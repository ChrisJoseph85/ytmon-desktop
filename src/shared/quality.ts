import { QUALITY_VALUES, type ContentKind, type DownloadState, type Quality } from './types';

/**
 * Quality is a MAXIMUM PERMITTED VIDEO HEIGHT, not a guarantee.
 * `best` is the only unbounded option.
 */
export function qualityCeiling(q: Quality): number | null {
  if (q === 'best') return null;
  const n = Number.parseInt(q, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Choose the best actual height for a requested ceiling given what yt-dlp found.
 * Mirrors the server's selection rule so both clients predict the same outcome.
 * Returns null when nothing at or below the ceiling exists -> caller reports an
 * error instead of silently upgrading.
 */
export function resolveAvailableHeight(requested: Quality, availableHeights: number[]): number | null {
  const valid = [...new Set(availableHeights.filter((h) => Number.isFinite(h) && h > 0))].sort((a, b) => a - b);
  if (valid.length === 0) return null;
  const ceiling = qualityCeiling(requested);
  if (ceiling === null) return valid[valid.length - 1]!;
  const atOrBelow = valid.filter((h) => h <= ceiling);
  return atOrBelow.length > 0 ? atOrBelow[atOrBelow.length - 1]! : null;
}

export function describeQuality(q: Quality): string {
  return q === 'best' ? 'Best available' : `${q} (max height)`;
}

/** Human label for what the file actually IS (quality_height), not what was asked. */
export function effectiveQualityLabel(requested: Quality | null, actualHeight: number | null): string | null {
  if (actualHeight === null || actualHeight === undefined) return requested ? `${requested} (requested)` : null;
  const p = `${actualHeight}p`;
  if (!requested || requested === 'best') return p;
  const ceiling = qualityCeiling(requested);
  if (ceiling === null) return p;
  if (actualHeight > ceiling) return `${p} (above your ${requested} ceiling)`;
  if (actualHeight < ceiling) return `${p} (best at or below ${requested})`;
  return p;
}

export const STATE_LABELS: Record<DownloadState, string> = {
  discovered: 'Discovered',
  queued: 'Queued',
  downloading: 'Downloading',
  completed: 'Completed',
  failed: 'Failed',
  unavailable: 'Not available',
  skipped: 'Skipped',
};

/**
 * `unavailable` is permanent (private / removed / age-restricted / DRM).
 * Never offer Retry and never present it as a user-fixable error.
 */
export const NON_RETRYABLE_STATES: DownloadState[] = ['unavailable'];

/** Only `failed` is retryable; `unavailable` is permanent by contract. */
export function isRetryable(state: DownloadState): boolean {
  return state === 'failed';
}

export function isActive(state: DownloadState): boolean {
  return state === 'downloading' || state === 'queued';
}

export function hasLocalFile(v: { status: DownloadState; file_path: string | null }): boolean {
  return v.status === 'completed' && v.file_path !== null;
}

export const KIND_LABELS: Record<ContentKind, string> = {
  video: 'Video',
  short: 'Short',
  unknown: 'Unknown',
};

export function isQualityValue(v: unknown): v is Quality {
  return typeof v === 'string' && (QUALITY_VALUES as readonly string[]).includes(v);
}