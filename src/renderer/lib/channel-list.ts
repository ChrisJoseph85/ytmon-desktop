/**
 * Bulk channel list handling.
 *
 * The server's import endpoint stores whatever URL you hand it — including an
 * @handle, which produces a channel row whose id can never match the canonical
 * `UC…` id that discovered videos carry (scans then return
 * `{discovered: 0, filtered: N}` forever). So entries are canonicalised here
 * before anything is sent.
 */

export interface ParsedEntry {
  /** The value we will send, always a canonical /channel/UC… URL when possible. */
  canonicalUrl: string;
  /** Original text the user supplied. */
  raw: string;
  /** Canonical id when we already know it. */
  channelId: string | null;
  /** True when the server would have to resolve it (an @handle, a bare name). */
  needsResolution: boolean;
}

const URL_IN_TEXT = /https?:\/\/[^\s,;"']+/gi;
const HANDLE_IN_TEXT = /@([A-Za-z0-9._-]{3,})/g;
const UC_ID = /\b(UC[A-Za-z0-9_-]{22})\b/;

export interface ParsedList {
  entries: ParsedEntry[];
  /** Lines dropped because they duplicated an earlier entry. */
  duplicates: number;
}

/**
 * Extracts channel references from arbitrary pasted text: CSV rows, JSON, a
 * plain list of URLs, @handles, or bare UC ids (e.g. a Google Takeout
 * subscriptions export).
 */
export function parseChannelListWithStats(text: string): ParsedList {
  const raw = (text ?? '').trim();
  if (!raw) return { entries: [], duplicates: 0 };

  const entries: ParsedEntry[] = [];
  const seen = new Set<string>();
  let duplicates = 0;

  const add = (entry: ParsedEntry) => {
    if (seen.has(entry.canonicalUrl)) {
      duplicates += 1;
      return;
    }
    seen.add(entry.canonicalUrl);
    entries.push(entry);
  };

  // Canonical UC ids anywhere in the text (including inside URLs).
  for (const m of raw.matchAll(new RegExp(UC_ID, 'g'))) {
    const id = m[1];
    if (!id) continue;
    add({ canonicalUrl: `https://www.youtube.com/channel/${id}`, raw: id, channelId: id, needsResolution: false });
  }

  for (const m of raw.matchAll(URL_IN_TEXT)) {
    const url = (m[0] ?? '').replace(/[),;.]+$/, '');
    if (!url) continue;
    const id = UC_ID.exec(url)?.[1];
    if (id) {
      // Already covered by the canonical pass above.
      add({ canonicalUrl: `https://www.youtube.com/channel/${id}`, raw: url, channelId: id, needsResolution: false });
      continue;
    }
    add({
      canonicalUrl: url,
      raw: url,
      channelId: null,
      // Anything that is not already a /channel/UC… URL must be resolved.
      needsResolution: !/\/channel\/UC[A-Za-z0-9_-]{22}/.test(url),
    });
  }

  for (const m of raw.matchAll(HANDLE_IN_TEXT)) {
    const handle = m[1];
    if (!handle) continue;
    add({
      canonicalUrl: `https://www.youtube.com/@${handle}`,
      raw: `@${handle}`,
      channelId: null,
      needsResolution: true,
    });
  }

  return { entries, duplicates };
}

export function parseChannelList(text: string): ParsedEntry[] {
  return parseChannelListWithStats(text).entries;
}

/** Builds the CSV body for POST /channels/import/csv. */
export function toImportCsv(entries: ParsedEntry[], qualityOverride?: string | null): string {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const rows = entries.map((e) =>
    [e.canonicalUrl, e.channelId ?? '', e.raw, '1', qualityOverride ?? ''].map(esc).join(','),
  );
  return ['url,channel_id,title,enabled,quality', ...rows].join('\n');
}

/** Builds the JSON body for POST /channels/import/json. */
export function toImportJson(entries: ParsedEntry[], qualityOverride?: string | null): string {
  return JSON.stringify(
    entries.map((e) => ({
      url: e.canonicalUrl,
      channel_id: e.channelId ?? undefined,
      title: e.raw,
      enabled: true,
      quality_override: qualityOverride ?? null,
    })),
    null,
    2,
  );
}

export interface ListSummary {
  total: number;
  ready: number;
  needResolving: number;
  duplicates: number;
}

export function summarise(entries: ParsedEntry[], duplicates = 0): ListSummary {
  return {
    total: entries.length,
    ready: entries.filter((e) => !e.needsResolution).length,
    needResolving: entries.filter((e) => e.needsResolution).length,
    duplicates,
  };
}