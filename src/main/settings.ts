import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SERVER_URL, LOOPBACK_SERVER_URL, validateServerUrl } from '../shared/format';

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
    tokenSessionOnly: !safeStorage.isEncryptionAvailable() && Boolean(sessionToken),
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
  if (!s.encryptedToken) return sessionToken;
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(s.encryptedToken, 'base64'));
    } catch {
      return null;
    }
  }
  // No OS keychain (rare: some Linux desktops). We refuse to hand out a
  // plaintext-at-rest secret rather than silently weakening security.
  return null;
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
): { ok: boolean; sessionOnly?: boolean; reason?: string } {
  if (token === null || token.trim() === '') {
    saveSettings({ encryptedToken: null });
    sessionToken = null;
    return { ok: true };
  }
  const value = token.trim();

  if (!safeStorage.isEncryptionAvailable()) {
    if (persist) {
      return {
        ok: false,
        reason:
          'No OS keychain is available on this system, so the token cannot be stored securely. Use "this session only" instead, or enable a desktop keyring (gnome-keyring/kwallet).',
      };
    }
    sessionToken = value;
    return { ok: true, sessionOnly: true };
  }
  const buf = safeStorage.encryptString(value);
  saveSettings({ encryptedToken: buf.toString('base64') });
  sessionToken = null;
  return { ok: true };
}