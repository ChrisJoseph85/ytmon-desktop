/**
 * Channel URL handling.
 *
 * The server derives `channel_id` from whatever URL you give it. Hand it an
 * @handle and it stores "@handle", but discovered videos carry the canonical
 * `UC…` id — so every scan comes back `{discovered: 0, filtered: N}` and the
 * channel silently never finds anything. Adding a channel therefore always
 * goes through the canonical `/channel/UC…` URL.
 */

const CANONICAL = /^https?:\/\/(?:www\.)?youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})/i;
const CHANNEL_ID_IN_PATH = /\/channel\/(UC[A-Za-z0-9_-]{22})/i;

/** Returns the canonical /channel/UC… URL if the given URL has one. */
export function pickCanonicalUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = CANONICAL.exec(url.trim());
  return m?.[1] ? `https://www.youtube.com/channel/${m[1]}` : null;
}

/** Extracts the UC id from any channel URL. */
export function pickChannelId(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = CHANNEL_ID_IN_PATH.exec(url.trim());
  return m?.[1] ?? null;
}

/** True when the URL carries a handle rather than a canonical id. */
export function isHandleUrl(url: string): boolean {
  return /youtube\.com\/@/.test(url);
}
