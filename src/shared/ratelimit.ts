import type { ContentKind } from './types';

/**
 * Rate limiting and quiet hours.
 *
 * These exist to stop YouTube throttling (or banning) a phone that hammers
 * it. All three are OFF by default: 0 / 0 / null.
 */

export const RATE_LIMIT_BOUNDS = {
  min_seconds_between_downloads: { min: 0, max: 3600 },
  max_downloads_per_day: { min: 0, max: 10_000 },
  subscriptions_autosync_minutes: { min: 5, max: 10_080 },
} as const;

export type RateLimitField = keyof typeof RATE_LIMIT_BOUNDS;

export function rateLimitBounds(field: RateLimitField): { min: number; max: number } {
  return RATE_LIMIT_BOUNDS[field];
}

export function validateRateLimit(field: RateLimitField, raw: string): { ok: boolean; reason?: string; value: number } {
  const { min, max } = RATE_LIMIT_BOUNDS[field];
  const text = (raw ?? '').trim();
  if (text === '') return { ok: true, value: min };
  if (!/^\d+$/.test(text)) return { ok: false, reason: `Enter a whole number of ${unitFor(field)}.`, value: min };
  const n = Number(text);
  if (!Number.isFinite(n) || n < min || n > max) {
    return { ok: false, reason: `Must be between ${min} and ${max} ${unitFor(field)}.`, value: min };
  }
  return { ok: true, value: n };
}

function unitFor(field: RateLimitField): string {
  if (field === 'subscriptions_autosync_minutes') return 'minutes';
  if (field === 'min_seconds_between_downloads') return 'seconds';
  return 'downloads';
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * "HH:MM-HH:MM". Overnight ranges (22:00-07:00) are explicitly allowed, so
 * start === end is treated as invalid rather than as "all day".
 */
export function validateQuietHours(raw: string): { ok: boolean; reason?: string; normalized: string | null } {
  const text = (raw ?? '').trim();
  if (!text) return { ok: true, normalized: null };
  const m = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(text);
  if (!m) return { ok: false, reason: 'Use HH:MM-HH:MM, e.g. 22:00-07:00.', normalized: null };
  const [, start, end] = m;
  if (!HHMM.test(start!) || !HHMM.test(end!)) {
    return { ok: false, reason: 'Times must be 24-hour HH:MM, e.g. 22:00-07:00.', normalized: null };
  }
  if (start === end) return { ok: false, reason: 'Start and end are the same — remove the field to disable quiet hours.', normalized: null };
  return { ok: true, normalized: `${start}-${end}` };
}

/** True when `now` falls inside an overnight-capable quiet window. */
export function inQuietHours(quietHours: string | null | undefined, now: Date): boolean {
  const parsed = validateQuietHours(quietHours ?? '');
  if (!parsed.ok || !parsed.normalized) return false;
  const [startRaw, endRaw] = parsed.normalized.split('-');
  const toMin = (s: string) => Number(s!.slice(0, 2)) * 60 + Number(s!.slice(3, 5));
  const start = toMin(startRaw!);
  const end = toMin(endRaw!);
  const cur = now.getHours() * 60 + now.getMinutes();
  // start > end means the window wraps past midnight.
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

export const DOWNLOAD_KINDS: ContentKind[] = ['video', 'short', 'unknown'];

export function isDownloadKind(v: unknown): v is ContentKind {
  return v === 'video' || v === 'short' || v === 'unknown';
}
