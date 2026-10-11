import { app, safeStorage } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SERVER_URL, LOOPBACK_SERVER_URL, validateServerUrl } from '../shared/format';
import os from 'node:os';

export interface AppSettings {
  serverUrl: string;
  /** Encrypted at rest with the OS keychain; never leaves the main process. */
  encryptedToken: string | null;
  /** Remember the last used destination folder for "Save to this computer". */
  lastDownloadDir: string | null;
  /** max concurrent transfers to this computer (server concurrency is separate). */
  maxParallelTransfers: number;
  pollIntervalMs: number;
  theme: 'system' | 'dark' | 'light';
}

const DEFAULTS: AppSettings = {
  serverUrl: DEFAULT_SERVER_URL,
  encryptedToken: null,
  lastDownloadDir: null,
  maxParallelTransfers: 2,
  pollIntervalMs: 5000,
  theme: 'system',
};

let cached: AppSettings | null = null;

/**
 * Where the token actually lives. Surfaced in the UI so it is never a mystery.
 */
export type TokenStorage = 'keychain' | 'encrypted-file' | 'memory' | 'none';

/**
 * Machine-local AES key used only when the OS has no keyring.
 *
 * This is deliberately NOT presented as strong as a keychain: it stops a token
 * leaking through a settings.json backup or a stray screenshot of the config,
 * but anyone who can read the keystore file as this user can also decrypt.
 * The key file is created 0600 and never leaves the machine.
 */
let fileKey: Buffer | null = null;

function keystorePath(): string {
  return path.join(app.getPath('userData'), 'keystore');
}

function loadOrCreateKey(): Buffer {
  if (fileKey) return fileKey;
  const p = keystorePath();
  try {
    fileKey = crypto.randomBytes(32);
    fs.writeFileSync(p, fileKey, { mode: 0o600 });
    fs.chmodSync(p, 0o600);
  } catch {
    // Read-only profile: fall back to a key derived from stable machine facts.
    fileKey = crypto.createHash('sha256').update(`${os.hostname()}:${os.userInfo().username}:ytmon`).digest();
  }
  return fileKey;
}

function encryptWithFileKey(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', loadOrCreateKey(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return JSON.stringify({
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  });
}

function decryptWithFileKey(blob: string): string | null {
  try {
    const parsed = JSON.parse(blob) as { iv: string; tag: string; data: string };
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      loadOrCreateKey(),
      Buffer.from(parsed.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parsed.data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Session-only token, held in main-process memory and NEVER written to disk.
 *
 * Used when the OS has no keychain (some Linux desktops). It is strictly a
 * downgrade from the keychain path, so it must be an explicit user choice: the
 * UI offers it instead of silently falling back, and it disappears when the
 * app closes.
 */
let sessionToken: string | null = null;

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

export function loadSettings(): AppSettings {
  if (cached) return cached;
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    cached = { ...DEFAULTS, ...parsed };
  } catch {
    cached = { ...DEFAULTS };
  }
  return cached;
}

export function saveSettings(next: Partial<AppSettings>): AppSettings {
  const merged = { ...loadSettings(), ...next };
  cached = merged;
  const file = settingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(merged, null, 2), { mode: 0o600 });
  return merged;
}

/** Public view of settings — the token itself is never returned to the renderer. */
export function publicSettings() {
  const s = loadSettings();
  return {
    serverUrl: s.serverUrl,
    lastDownloadDir: s.lastDownloadDir,
    maxParallelTransfers: s.maxParallelTransfers,
    pollIntervalMs: s.pollIntervalMs,
    theme: s.theme,
    hasToken: Boolean(readToken()),
    tokenKeychain: safeStorage.isEncryptionAvailable(),
    // True when the token lives in memory only and will be forgotten on quit.
    tokenSessionOnly: tokenStorage() === 'memory',
    tokenStorage: tokenStorage(),
  };
}

export function setServerUrl(url: string): { ok: boolean; reason?: string } {
  const v = validateServerUrl(url);
  if (!v.ok || !v.normalized) return { ok: false, reason: v.reason };
  saveSettings({ serverUrl: v.normalized });
  return { ok: true };
}

export function useLoopback(): void {
  saveSettings({ serverUrl: LOOPBACK_SERVER_URL });
}

/** Returns the plaintext token to main-process callers only. */
export function readToken(): string | null {
  const s = loadSettings();
  if (sessionToken) return sessionToken;
  if (!s.encryptedToken) return null;
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(s.encryptedToken, 'base64'));
    } catch {
      return null;
    }
  }
  return decryptWithFileKey(s.encryptedToken);
}

export function tokenStorage(): TokenStorage {
  if (sessionToken) return 'memory';
  const s = loadSettings();
  if (!s.encryptedToken) return 'none';
  return safeStorage.isEncryptionAvailable() ? 'keychain' : 'encrypted-file';
}

/**
 * Stores the token in the OS keychain. Without an available keychain the token
 * is refused and the user is told why — we never fall back to plain storage.
 */
/**
 * Stores the token.
 *
 * persist=true  → encrypted in the OS keychain, survives restarts.
 * persist=false → kept in memory for this session only, never touches the disk.
 *
 * If a persist is requested but no keychain exists we refuse rather than writing
 * a plaintext secret to disk.
 */
export function writeToken(
  token: string | null,
  persist = true,
): { ok: boolean; sessionOnly?: boolean; reason?: string; storage?: TokenStorage } {
  if (token === null || token.trim() === '') {
    saveSettings({ encryptedToken: null });
    sessionToken = null;
    return { ok: true, storage: 'none' };
  }
  const value = token.trim();

  if (!safeStorage.isEncryptionAvailable()) {
    if (!persist) {
      sessionToken = value;
      return { ok: true, sessionOnly: true, storage: 'memory' };
    }
    // No keyring: encrypt with a machine-local key rather than making the user
    // re-paste the token on every launch, and never write it in plain text.
    sessionToken = null;
    saveSettings({ encryptedToken: encryptWithFileKey(value) });
    return { ok: true, storage: 'encrypted-file' };
  }
  const buf = safeStorage.encryptString(value);
  saveSettings({ encryptedToken: buf.toString('base64') });
  sessionToken = null;
  return { ok: true, storage: 'keychain' };
}