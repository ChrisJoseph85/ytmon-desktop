import {
  CHANNEL_MODES,
  SCHEDULE_DAYS,
  type Channel,
  type ChannelMode,
  type ChannelPolicyUpdate,
  type ScheduleDay,
} from './types';

export { SCHEDULE_DAYS };
export type { ScheduleDay };

/**
 * Per-channel download scheduling.
 *
 * The rules this file exists to enforce:
 *
 *  - `mode` is `auto` or `manual`. Manual channels are still DISCOVERED — the
 *    uploads show up in the library as `discovered` — they are just never
 *    downloaded automatically.
 *  - Scheduling gates the DOWNLOAD only. A channel scheduled for Monday still
 *    lists its Tuesday upload on Tuesday.
 *  - `due_now` / `next_due` are computed by the SERVER (it owns the timezone
 *    and the window). Never recompute them here; read the two fields.
 *  - Imported channels default to `manual` on purpose. The client must not
 *    flip them to auto.
 */

/** 24h "HH:MM", or null for "any time on the selected days". */
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const DAY_LABELS: Record<ScheduleDay, string> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
};

export const MODE_LABELS: Record<ChannelMode, string> = {
  auto: 'Automatic',
  manual: 'Manual',
};

export function isChannelMode(value: unknown): value is ChannelMode {
  return typeof value === 'string' && (CHANNEL_MODES as readonly string[]).includes(value);
}

/**
 * Channel paths take the channel KEY — a canonical "UC…" id or an "@handle" —
 * never the numeric row id. A numeric id silently addresses a different channel
 * (or nothing) with no error, so it is refused before it reaches the network.
 */
export function isChannelKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (/^UC[A-Za-z0-9_-]{22}$/.test(value.trim()) || /^@[A-Za-z0-9._-]{1,64}$/.test(value.trim()))
  );
}

export function isScheduleDay(value: unknown): value is ScheduleDay {
  return typeof value === 'string' && (SCHEDULE_DAYS as readonly string[]).includes(value);
}

/** A channel read from an older server has no policy fields at all. */
export function channelMode(channel: Pick<Channel, 'mode'> | null | undefined): ChannelMode {
  return isChannelMode(channel?.mode) ? channel.mode : 'auto';
}

export function channelScheduleDays(channel: Pick<Channel, 'schedule_days'> | null | undefined): ScheduleDay[] {
  const days = channel?.schedule_days;
  if (!Array.isArray(days)) return [];
  return SCHEDULE_DAYS.filter((d) => days.includes(d));
}

/**
 * "HH:MM" or null. Anything else is rejected client-side so the user gets an
 * inline reason instead of an opaque 422.
 */
export function isValidScheduleTime(value: unknown): value is string | null {
  if (value === null || value === undefined) return true;
  return typeof value === 'string' && TIME_RE.test(value);
}

export function validateScheduleTime(value: string): { ok: boolean; reason?: string; normalized: string | null } {
  const raw = (value ?? '').trim();
  // An empty box means "no specific time", which the server stores as null.
  if (!raw) return { ok: true, normalized: null };
  if (!TIME_RE.test(raw)) {
    return {
      ok: false,
      reason: 'Use 24-hour HH:MM, e.g. 08:30 or 21:00. Leave it empty for any time that day.',
      normalized: null,
    };
  }
  return { ok: true, normalized: raw };
}

/** Drops duplicates and anything that is not a documented weekday. */
export function normaliseDays(days: readonly string[]): ScheduleDay[] {
  return SCHEDULE_DAYS.filter((d) => days.includes(d));
}

export function toggleDay(days: readonly ScheduleDay[], day: ScheduleDay): ScheduleDay[] {
  const next = days.includes(day) ? days.filter((d) => d !== day) : [...days, day];
  return normaliseDays(next);
}

/** Empty = every day; otherwise keep Monday-first so the chips read naturally. */
export function scheduleSummary(days: readonly ScheduleDay[], time: string | null): string {
  const when = time ?? 'any time';
  if (days.length === 0) return `Every day, ${when}`;
  if (days.length === SCHEDULE_DAYS.length) return `Every day, ${when}`;
  if (days.length === 1) return `${DAY_LABELS[days[0]!]}, ${when}`;
  const first = days[0]!;
  const last = days[days.length - 1]!;
  const contiguous = days.every((d, i) => i === 0 || SCHEDULE_DAYS.indexOf(d) === SCHEDULE_DAYS.indexOf(days[i - 1]!) + 1);
  if (contiguous) return `${DAY_LABELS[first]}–${DAY_LABELS[last]}, ${when}`;
  return `${days.map((d) => DAY_LABELS[d]).join(', ')}, ${when}`;
}

/** What the channel is actually doing, in one line, for a badge tooltip. */
export function describePolicy(channel: Channel): string {
  const mode = channelMode(channel);
  if (mode === 'manual') return 'Manual — uploads are discovered but never downloaded automatically.';
  if (!channel.schedule_enabled) return 'Automatic — downloads whenever discovery finds something.';
  return `Automatic, scheduled: ${scheduleSummary(channelScheduleDays(channel), channel.schedule_time ?? null)}.`;
}

/** True when downloads are gated by a schedule rather than happening freely. */
export function isScheduled(channel: Pick<Channel, 'schedule_enabled' | 'schedule_days' | 'schedule_time'>): boolean {
  if (!channel.schedule_enabled) return false;
  const days = channelScheduleDays(channel);
  const hasTime = isValidScheduleTime(channel.schedule_time) && Boolean(channel.schedule_time);
  // "Every day, any time" is not a schedule — it is just automatic.
  return days.length > 0 || hasTime;
}

export type ChannelFilter = 'all' | 'auto' | 'manual' | 'scheduled';

/** Client-side filter over an already-loaded channel list. */
export function filterChannels<T extends Channel>(channels: readonly T[], filter: ChannelFilter): T[] {
  switch (filter) {
    case 'auto':
      return channels.filter((c) => channelMode(c) === 'auto');
    case 'manual':
      return channels.filter((c) => channelMode(c) === 'manual');
    case 'scheduled':
      return channels.filter((c) => isScheduled(c));
    default:
      return [...channels];
  }
}

/**
 * Case-folds ASCII only, matching the server's search.
 *
 * A full `toLowerCase()` would fold Cyrillic/Greek/accented characters too,
 * which the server does NOT: it matches those case-SENSITIVELY. Folding more
 * than the server would silently match channels the server would not.
 */
export function asciiFold(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    out += code >= 65 && code <= 90 ? String.fromCodePoint(code + 32) : ch;
  }
  return out;
}

/** Title/channel-id search with the server's ASCII-only folding. */
export function channelMatchesSearch(
  channel: Pick<Channel, 'title' | 'channel_id'>,
  term: string,
): boolean {
  const t = term.trim();
  if (!t) return true;
  const needle = asciiFold(t);
  return (
    asciiFold(channel.title ?? '').includes(needle) ||
    asciiFold(channel.channel_id).includes(needle)
  );
}

/** Client-side mirror of the server's `?mode=` filter. */
export function modeQueryParam(filter: ChannelFilter): ChannelMode | undefined {
  return filter === 'auto' || filter === 'manual' ? filter : undefined;
}

/**
 * Drops undefined values so a PATCH only carries what actually changed —
 * sending `schedule_time: undefined` must not clear the stored time.
 */
export function cleanPolicyPatch(patch: ChannelPolicyUpdate): ChannelPolicyUpdate {
  const out: ChannelPolicyUpdate = {};
  if (patch.mode !== undefined && isChannelMode(patch.mode)) out.mode = patch.mode;
  if (patch.schedule_enabled !== undefined) out.schedule_enabled = patch.schedule_enabled;
  if (patch.schedule_days !== undefined) out.schedule_days = normaliseDays(patch.schedule_days as readonly string[]);
  if (patch.schedule_time !== undefined && isValidScheduleTime(patch.schedule_time)) {
    out.schedule_time = patch.schedule_time;
  }
  return out;
}

/**
 * Turns a failed policy write into a readable reason. The server answers 422
 * with its own message; this only covers the codes worth explaining.
 */
export function describePolicyError(code: string): string | null {
  switch (code) {
    case 'invalid_schedule_time':
      return 'The server rejected that time. Use 24-hour HH:MM, e.g. 08:30.';
    case 'invalid_schedule_days':
      return 'The server rejected those days. Use the short forms: mon, tue, wed, thu, fri, sat, sun.';
    case 'invalid_mode':
      return 'The server only accepts mode "auto" or "manual".';
    default:
      return null;
  }
}