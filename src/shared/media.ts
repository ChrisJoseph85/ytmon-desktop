/**
 * The renderer references media as `ytmon-media://video/<id>` and never holds
 * the bearer token: the main process injects auth and forwards Range headers.
 */
export const MEDIA_SCHEME = 'ytmon-media';

/** Playback URL. Serves BOTH video and audio from the same /files/{id}/stream. */
export function mediaUrl(videoId: string, startByte = 0): string {
  const base = `${MEDIA_SCHEME}://video/${encodeURIComponent(videoId)}`;
  return startByte > 0 ? `${base}?range=bytes=${startByte}-` : base;
}

/**
 * Thumbnail URL. `Video.thumbnail_url` points at YouTube and will not load on an
 * offline phone, and a plain <img> cannot send a bearer header — so the renderer
 * asks for this instead and the main process fetches
 * GET /videos/{id}/thumbnail with auth and returns the cached bytes.
 */
export function thumbUrl(videoId: string): string {
  return `${MEDIA_SCHEME}://thumb/${encodeURIComponent(videoId)}`;
}

export type MediaUrlKind = 'video' | 'thumb';

export interface ParsedMediaUrl {
  kind: MediaUrlKind;
  videoId: string;
  range: string | null;
}

export function parseMediaUrl(raw: string): ParsedMediaUrl | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${MEDIA_SCHEME}:`) return null;
  const segments = url.pathname
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean)
    .map((s) => decodeURIComponent(s));

  // Standard scheme: `ytmon-media://video/<id>` parses as host=video, path=/<id>.
  // Also accept `ytmon-media:/video/<id>` where "video" lands in the path.
  const kind = (url.hostname || segments[0] || '') as MediaUrlKind;
  const videoId = segments.length > 1 ? (segments[1] ?? '') : (segments[0] ?? '');

  if ((kind !== 'video' && kind !== 'thumb') || !videoId || !/^[\w-]{1,64}$/.test(videoId)) return null;
  return { kind, videoId, range: url.searchParams.get('range') };
}
/**
 * The Range a client asked for.
 *
 * A <video> element seeks by sending `Range` as an HTTP REQUEST HEADER; nothing
 * puts it in the query string. Reading only the URL made every seek return a
 * full body from byte 0, so scrubbing silently snapped back to the start.
 */
export function pickRange(headers: Headers | { get(name: string): string | null }, urlRange?: string | null): string | null {
  const fromHeader = headers?.get ? headers.get('Range') ?? headers.get('range') : null;
  return fromHeader ?? urlRange ?? null;
}

/** Builds the upstream headers for a media stream request. */
export function upstreamHeaders(opts: {
  auth: Record<string, string>;
  range?: string | null;
  ifRange?: string | null;
}): Record<string, string> {
  const h: Record<string, string> = { ...opts.auth };
  if (opts.range) h['Range'] = opts.range;
  if (opts.ifRange) h['If-Range'] = opts.ifRange;
  return h;
}
