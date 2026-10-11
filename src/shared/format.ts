/**
 * URL handling. The phone's LAN IP changes, so the server address is always a
 * user setting — never hardcoded, never cached as authoritative.
 */

export const DEFAULT_SERVER_URL = 'http://192.168.1.100:8765';
export const LOOPBACK_SERVER_URL = 'http://127.0.0.1:8765';
export const API_PREFIX = '/api/v1';

export interface UrlValidation {
  ok: boolean;
  reason?: string;
  normalized?: string;
  host?: string;
  port?: number;
  isLoopback?: boolean;
}

/**
 * Accepts only http(s) origins with no credentials, no query and no path
 * beyond "/" — a server base is host:port, nothing more.
 */
export function validateServerUrl(input: string): UrlValidation {
  const raw = (input ?? '').trim();
  if (!raw) return { ok: false, reason: 'Enter the server address, e.g. http://192.168.1.100:8765' };

  let url: URL;
  try {
    // Only assume http:// when no scheme was given at all; a scheme like
    // ftp:// must be rejected as a scheme error, not silently rewritten.
    const hasScheme = raw.includes('://');
    url = new URL(hasScheme ? raw : `http://${raw}`);
  } catch {
    return { ok: false, reason: 'That is not a valid address.' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'Only http:// and https:// are supported.' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'Remove the username/password; use a bearer token instead.' };
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (path && path !== '/api/v1') {
    return { ok: false, reason: 'Enter only the host and port. The client appends /api/v1 itself.' };
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) return { ok: false, reason: 'Missing host name.' };
  const port = url.port ? Number.parseInt(url.port, 10) : url.protocol === 'https:' ? 443 : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, reason: 'Port must be between 1 and 65535.' };
  }
  return {
    ok: true,
    normalized: `${url.protocol}//${url.host}`,
    host,
    port,
    isLoopback: host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]',
  };
}

/** 11-char YouTube id. Used to reject junk before it reaches the API. */
export function isYouTubeVideoId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id);
}

/** 24-char channel id. */
export function isYouTubeChannelId(id: unknown): id is string {
  return typeof id === 'string' && /^UC[A-Za-z0-9_-]{22}$/.test(id);
}

export function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

/**
 * Filenames come from the server (already ASCII-sanitised) but are re-checked
 * here: a destination name must never contain separators or traversal.
 */
export function sanitizeFilename(name: string, fallback = 'video.mp4'): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base
    // eslint-disable-next-line no-control-regex -- stripping control chars is the point
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return cleaned.length > 0 && cleaned.length <= 200 ? cleaned : fallback;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

export function formatEta(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}