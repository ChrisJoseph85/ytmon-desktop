/**
 * Quality dropdown is populated from GET /quality/options so both clients stay
 * identical. The local list is only a display-order fallback / sanity check.
 */
export function qualityLabelsFrom(options: string[] | undefined): { value: string; label: string }[] {
  const order = ['144p', '240p', '360p', '480p', '720p', '1080p', '1440p', '2160p', 'best'];
  const source = Array.isArray(options) && options.length > 0 ? options : order;
  const sorted = [
    ...source.filter((o) => o !== 'best' && order.includes(o)).sort((a, b) => order.indexOf(a) - order.indexOf(b)),
    ...(source.includes('best') ? ['best'] : []),
  ];
  return sorted.map((value) => ({
    value,
    label: value === 'best' ? 'Best available (no ceiling)' : `${value} — max height, best at or below`,
  }));
}

export function qualityDisplay(value: string | null | undefined): string {
  if (!value) return '—';
  return value === 'best' ? 'Best available' : value;
}
/**
 * The server rejects sub_langs="*" with 400 invalid_sub_langs because it makes
 * yt-dlp fetch every subtitle track and break every download. Validate before
 * sending so the user gets an inline reason instead of an opaque failure.
 */
export function validateSubLangs(value: string): { ok: boolean; reason?: string; normalized: string } {
  const raw = (value ?? '').trim();
  if (!raw) return { ok: false, reason: 'Enter at least one language, e.g. "en.*" or "en,es".', normalized: '' };
  if (raw === '*') {
    return {
      ok: false,
      reason: '"*" is rejected by the server (invalid_sub_langs) — it makes every download fail. Use "en.*" to match English tracks.',
      normalized: raw,
    };
  }
  if (/^\s*$/.test(raw)) return { ok: false, reason: 'Empty language filter.', normalized: raw };
  if (raw.length > 120) return { ok: false, reason: 'Too long (max 120 characters).', normalized: raw };
  if (!/^[A-Za-z0-9.*,_\-\s]+$/.test(raw)) {
    return { ok: false, reason: 'Only language codes, wildcards, commas and dots — e.g. "en.*,es".', normalized: raw };
  }
  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return { ok: false, reason: 'Enter at least one language code.', normalized: raw };
  return { ok: true, normalized: parts.join(',') };
}

/** download_dir lives on the phone; reject anything that is not a sane path. */
export function validateDownloadDir(value: string): { ok: boolean; reason?: string; normalized: string | null } {
  const raw = (value ?? '').trim();
  if (!raw) return { ok: true, normalized: null };
  if (!raw.startsWith('/')) return { ok: false, reason: 'Use an absolute path on the phone, e.g. /data/data/com.termux/files/home/media', normalized: null };
  if (raw.includes('..')) return { ok: false, reason: 'Path traversal ("..") is not allowed.', normalized: null };
  if (/\s/.test(raw)) return { ok: false, reason: 'Paths cannot contain spaces.', normalized: null };
  return { ok: true, normalized: raw };
}
