import { describe, expect, it } from 'vitest';
import { YtmonApi, describeScanResult } from '../src/main/api';
import { YtmonError } from '../src/shared/errors';
import {
  channelMode,
  cleanPolicyPatch,
  describePolicy,
  filterChannels,
  isChannelKey,
  isScheduled,
  normaliseDays,
  scheduleSummary,
  toggleDay,
  validateScheduleTime,
} from '../src/shared/schedule';
import type { Channel, MonitorScanResult } from '../src/shared/types';

/**
 * Subscriptions import + per-channel scheduling.
 *
 * The rules that are easy to get wrong, and which these tests pin:
 *  - the policy endpoint is PATCH /channels/{id}/policy, not PATCH /channels/{id}
 *  - manual channels still DISCOVER, they just never auto-download
 *  - a schedule gates the download only
 *  - imported channels arrive manual, and the client must not flip them
 *  - `held` on a scan is an outcome, not an error
 */

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const UC = 'UCabcdefghijklmnopqrstuv';

function channel(over: Partial<Channel> = {}): Channel {
  return {
    id: 1,
    channel_id: UC,
    url: `https://www.youtube.com/channel/${UC}`,
    title: 'A channel',
    enabled: true,
    quality_override: null,
    mode: 'auto',
    schedule_enabled: false,
    schedule_days: [],
    schedule_time: null,
    due_now: true,
    next_due: null,
    last_checked_at: null,
    last_uploaded_at: null,
    created_at: null,
    updated_at: null,
    ...over,
  };
}

describe('channel policy endpoint', () => {
  it('writes mode through /policy, not through the channel PATCH', async () => {
    const { impl, calls } = stubFetch(() => json(channel({ mode: 'manual' })));
    const api = new YtmonApi({ baseUrl: 'http://192.168.1.100:8765', fetchImpl: impl });
    await api.setChannelPolicy(UC, { mode: 'manual' });
    expect(calls[0]!.url).toBe(`http://192.168.1.100:8765/api/v1/channels/${UC}/policy`);
    expect(calls[0]!.init.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ mode: 'manual' });
  });

  it('sends schedule fields together in one PATCH', async () => {
    const { impl, calls } = stubFetch(() => json(channel()));
    const api = new YtmonApi({ baseUrl: 'http://192.168.1.100:8765', fetchImpl: impl });
    await api.setChannelPolicy(UC, cleanPolicyPatch({
      mode: 'auto',
      schedule_enabled: true,
      schedule_days: ['mon', 'wed', 'fri'],
      schedule_time: '08:30',
    }));
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      mode: 'auto',
      schedule_enabled: true,
      schedule_days: ['mon', 'wed', 'fri'],
      schedule_time: '08:30',
    });
  });

  it('bulk policy posts channel_ids plus the patch and returns the count', async () => {
    const { impl, calls } = stubFetch(() => json({ updated: 3 }));
    const api = new YtmonApi({ baseUrl: 'http://192.168.1.100:8765', fetchImpl: impl });
    const r = await api.bulkChannelPolicy({ channel_ids: [UC, '@handle'], mode: 'manual' });
    expect(calls[0]!.url).toBe('http://192.168.1.100:8765/api/v1/channels/policy/bulk');
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ channel_ids: [UC, '@handle'], mode: 'manual' });
    expect(r.updated).toBe(3);
  });

  it('clears the time with an explicit null, never with a dropped key', () => {
    expect(cleanPolicyPatch({ schedule_time: null })).toEqual({ schedule_time: null });
    // undefined means "the user did not touch this" — it must not clear it.
    expect(cleanPolicyPatch({ mode: 'auto' })).not.toHaveProperty('schedule_time');
  });

  it('rejects a bad time client-side with a readable reason', () => {
    expect(validateScheduleTime('08:30').ok).toBe(true);
    expect(validateScheduleTime('23:59').ok).toBe(true);
    expect(validateScheduleTime('8:30').ok).toBe(false);
    expect(validateScheduleTime('24:00').ok).toBe(false);
    expect(validateScheduleTime('08:60').ok).toBe(false);
    expect(validateScheduleTime('').normalized).toBeNull();
    expect(validateScheduleTime('abc').reason).toMatch(/HH:MM/);
  });

  it('drops unknown weekdays and keeps Monday-first order', () => {
    expect(normaliseDays(['fri', 'mon', 'nope', 'mon'])).toEqual(['mon', 'fri']);
    expect(normaliseDays([])).toEqual([]);
    expect(toggleDay(['mon'], 'tue')).toEqual(['mon', 'tue']);
    expect(toggleDay(['mon', 'tue'], 'mon')).toEqual(['tue']);
  });

  it('accepts a UC id or an @handle as a channel key, never the numeric row id', () => {
    expect(isChannelKey(UC)).toBe(true);
    expect(isChannelKey('@somehandle')).toBe(true);
    // The documented footgun: /channels/{id} never takes the numeric row id.
    expect(isChannelKey('7')).toBe(false);
    expect(isChannelKey(7)).toBe(false);
    expect(isChannelKey('https://www.youtube.com/channel/' + UC)).toBe(false);
    expect(isChannelKey('')).toBe(false);
  });
});

describe('mode semantics', () => {
  it('treats a channel with no policy fields (older server) as automatic', () => {
    const legacy = { mode: undefined } as unknown as Channel;
    expect(channelMode(legacy)).toBe('auto');
    expect(channelMode(null)).toBe('auto');
  });

  it('says plainly that manual still discovers', () => {
    expect(describePolicy(channel({ mode: 'manual' }))).toMatch(/discovered but never downloaded/i);
  });

  it('"every day, any time" is not a schedule', () => {
    // schedule_enabled with nothing set would otherwise show as "scheduled"
    // while behaving exactly like automatic.
    expect(isScheduled(channel({ schedule_enabled: true }))).toBe(false);
    expect(isScheduled(channel({ schedule_enabled: true, schedule_time: '08:30' }))).toBe(true);
    expect(isScheduled(channel({ schedule_enabled: true, schedule_days: ['sat'] }))).toBe(true);
    expect(isScheduled(channel({ mode: 'manual', schedule_enabled: true, schedule_days: ['sat'] }))).toBe(true);
  });

  it('filters the list by auto / manual / scheduled', () => {
    const list = [
      channel({ channel_id: 'a', mode: 'auto' }),
      channel({ channel_id: 'b', mode: 'manual' }),
      channel({ channel_id: 'c', mode: 'auto', schedule_enabled: true, schedule_days: ['mon'] }),
    ];
    expect(filterChannels(list, 'all')).toHaveLength(3);
    expect(filterChannels(list, 'auto').map((c) => c.channel_id)).toEqual(['a', 'c']);
    expect(filterChannels(list, 'manual').map((c) => c.channel_id)).toEqual(['b']);
    expect(filterChannels(list, 'scheduled').map((c) => c.channel_id)).toEqual(['c']);
  });

  it('summarises a schedule in words, Monday first', () => {
    expect(scheduleSummary([], '08:30')).toBe('Every day, 08:30');
    expect(scheduleSummary([], null)).toBe('Every day, any time');
    expect(scheduleSummary(['mon'], '08:30')).toBe('Mon, 08:30');
    expect(scheduleSummary(['mon', 'tue', 'wed'], null)).toBe('Mon–Wed, any time');
    expect(scheduleSummary(['mon', 'wed'], null)).toBe('Mon, Wed, any time');
  });
});

describe('subscriptions import', () => {
  it('sends the pasted Takeout payload with source=takeout', async () => {
    const { impl, calls } = stubFetch(() =>
      json({ source: 'takeout', imported: 300, updated: 0, skipped: 2, total: 302, errors: [] }),
    );
    const api = new YtmonApi({ baseUrl: 'http://192.168.1.100:8765', fetchImpl: impl });
    const r = await api.importSubscriptions({ source: 'takeout', data: '[{"contentDetails":{}}]' });
    expect(calls[0]!.url).toBe('http://192.168.1.100:8765/api/v1/subscriptions/import');
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      source: 'takeout',
      data: '[{"contentDetails":{}}]',
    });
    expect(r).toMatchObject({ imported: 300, updated: 0, skipped: 2, total: 302 });
  });

  it('never sends an empty data field for the feed source', async () => {
    const { impl, calls } = stubFetch(() =>
      json({ source: 'feed', imported: 120, updated: 1, skipped: 0, total: 121, errors: [] }),
    );
    const api = new YtmonApi({ baseUrl: 'http://192.168.1.100:8765', fetchImpl: impl });
    await api.importSubscriptions({ source: 'feed', data: 'ignored' });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ source: 'feed' });
  });

  it('surfaces the documented import errors with their codes', async () => {
    const api = new YtmonApi({
      baseUrl: 'http://192.168.1.100:8765',
      fetchImpl: stubFetch(() =>
        json({ error: { code: 'invalid_takeout', message: 'not a subscriptions array' } }, 400),
      ).impl,
    });
    const err = await api.importSubscriptions({ source: 'takeout', data: '{}' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(YtmonError);
    expect((err as YtmonError).code).toBe('invalid_takeout');
    // The user is told what to do, not just what went wrong.
    expect((err as YtmonError).hint).toMatch(/subscriptions\.json/);
  });

  it('points an expired-cookies feed failure at Takeout', async () => {
    const api = new YtmonApi({
      baseUrl: 'http://192.168.1.100:8765',
      fetchImpl: stubFetch(() => json({ error: { code: 'import_failed', message: 'cookies expired' } }, 400)).impl,
    });
    const err = (await api.importSubscriptions({ source: 'feed' }).catch((e: unknown) => e)) as YtmonError;
    expect(err.code).toBe('import_failed');
    expect(err.hint).toMatch(/Takeout/);
  });

  it('explains data_required rather than showing a bare 400', () => {
    expect(new YtmonError('no data', 'data_required', 400).hint).toMatch(/subscriptions\.json/);
  });

  it('reads cookies_configured before offering the feed option', async () => {
    const { impl, calls } = stubFetch(() => json({ cookies_configured: false, subscriptions: 12 }));
    const api = new YtmonApi({ baseUrl: 'http://192.168.1.100:8765', fetchImpl: impl });
    const status = await api.subscriptionsStatus();
    expect(calls[0]!.url).toBe('http://192.168.1.100:8765/api/v1/subscriptions/status');
    expect(status.cookies_configured).toBe(false);
  });

  it('lists subscriptions with the documented ?mode filter', async () => {
    const { impl, calls } = stubFetch(() => json([]));
    const api = new YtmonApi({ baseUrl: 'http://192.168.1.100:8765', fetchImpl: impl });
    await api.listSubscriptions('manual');
    expect(new URL(calls[0]!.url).searchParams.get('mode')).toBe('manual');
    await api.listSubscriptions();
    expect(new URL(calls[1]!.url).searchParams.get('mode')).toBeNull();
  });

  it('re-reads a stored snapshot by id', async () => {
    const { impl, calls } = stubFetch(() => json({ id: 7, source: 'takeout', imported: 300 }));
    const api = new YtmonApi({ baseUrl: 'http://192.168.1.100:8765', fetchImpl: impl });
    await api.subscriptionSnapshot('7');
    expect(calls[0]!.url).toBe('http://192.168.1.100:8765/api/v1/subscriptions/snapshots/7');
  });
});

describe('scan `held` is not an error', () => {
  it('reports held videos without claiming an error', () => {
    const text = describeScanResult({
      channels_scanned: 4,
      discovered: 9,
      queued: 6,
      duplicates: 2,
      filtered: 0,
      held: 3,
      errors: [],
    });
    expect(text).toContain('3 waiting for its schedule');
    expect(text).toContain('not due');
    expect(text).not.toMatch(/error/i);
  });

  it('omits held entirely when the server does not report it', () => {
    const text = describeScanResult({
      channels_scanned: 1, discovered: 1, queued: 1, duplicates: 0, filtered: 0, errors: [],
    });
    expect(text).not.toContain('held');
    // A server that omits it must not print "0 held".
    expect(text).not.toContain('0 held');
  });

  it('still counts real errors', () => {
    const text = describeScanResult({
      channels_scanned: 1, discovered: 0, queued: 0, duplicates: 0, filtered: 0, held: 2,
      errors: ['boom'],
    });
    expect(text).toContain('1 error');
  });
});
/**
 * Regressions found by review. Each of these failed before the fix.
 */
describe('scan results without an errors array', () => {
  it('describeScanResult does not crash on a payload missing errors[]', () => {
    const payload = {
      channels_scanned: 2, discovered: 3, queued: 1, duplicates: 0, filtered: 0, held: 2,
    } as unknown as MonitorScanResult;
    expect(() => describeScanResult(payload)).not.toThrow();
    expect(describeScanResult(payload)).toContain('2 waiting for its schedule');
  });
});
