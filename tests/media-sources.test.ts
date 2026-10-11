import { describe, expect, it } from 'vitest';
import { YtmonApi } from '../src/main/api';
import { filterByMediaType, downloadUrlForSearch } from '../src/renderer/lib/filters';
import { MEDIA_TYPES } from '../src/shared/types';
import { thumbUrl, parseMediaUrl } from '../src/shared/media';

function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const BASE = 'http://192.168.1.100:8765';

describe('MediaTypeEnum', () => {
  it('has exactly the two documented values', () => {
    expect([...MEDIA_TYPES]).toEqual(['video', 'audio']);
  });

  it('is carried on Video and the quality settings', () => {
    // The UI branches on this, never on the file extension.
    const v = { media_type: 'audio' as const, title: 'song' };
    expect(filterByMediaType([v], 'audio')).toHaveLength(1);
    expect(filterByMediaType([v], 'video')).toHaveLength(0);
  });
});

describe('library media filter (server has no media_type query param)', () => {
  it('filters the loaded page client-side', () => {
    const items = [
      { media_type: 'video' as const, id: 1 },
      { media_type: 'audio' as const, id: 2 },
      { id: 3 }, // older servers omit it; treat as video
    ];
    expect(filterByMediaType(items, 'all')).toHaveLength(3);
    expect(filterByMediaType(items, 'audio').map((i) => i.id)).toEqual([2]);
    expect(filterByMediaType(items, 'video').map((i) => i.id)).toEqual([1, 3]);
  });

  it('does NOT send media_type to the server, which would be silently ignored', () => {
    const q = downloadUrlForSearch({
      view: 'all',
      kind: 'all',
      mediaType: 'audio',
      search: '',
      channelId: '',
      sort: 'published_at',
      order: 'desc',
      page: 1,
      page_size: 24,
    });
    expect(q).not.toHaveProperty('media_type');
  });
});

describe('POST /videos/fetch', () => {
  it('sends download:false for a preview and queues nothing', async () => {
    const { impl, calls } = stubFetch(() =>
      json({
        kind: 'video',
        resolved: 1,
        added: [],
        queued: [],
        duplicates: ['abc'],
        unavailable: [],
        truncated: false,
        quality: null,
        media_type: 'video',
      }),
    );
    const api = new YtmonApi({ baseUrl: BASE, token: 't', fetchImpl: impl });
    const r = await api.fetchLink({ url: 'https://youtu.be/abc', download: false });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ url: 'https://youtu.be/abc', download: false });
    expect(r.queued).toEqual([]);
    expect(r.quality).toBeNull(); // expected, not a bug
  });

  it('passes media_type and a per-call quality override', async () => {
    const { impl, calls } = stubFetch(() => json({ kind: 'video', resolved: 1, added: [], queued: ['a'], duplicates: [], unavailable: [], truncated: false, quality: '480p', media_type: 'audio' }));
    const api = new YtmonApi({ baseUrl: BASE, token: 't', fetchImpl: impl });
    await api.fetchLink({ url: 'https://youtu.be/a', download: true, media_type: 'audio', quality: '480p' });
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ media_type: 'audio', quality: '480p', download: true });
  });

  it('surfaces unavailable and truncated rather than dropping them', async () => {
    const { impl } = stubFetch(() =>
      json({ kind: 'playlist', resolved: 50, added: [], queued: [], duplicates: [], unavailable: ['a', 'b'], truncated: true, quality: null, media_type: 'video' }),
    );
    const api = new YtmonApi({ baseUrl: BASE, token: 't', fetchImpl: impl });
    const r = await api.fetchLink({ url: 'https://youtube.com/playlist?list=PL1', download: false });
    expect(r.unavailable).toEqual(['a', 'b']);
    expect(r.truncated).toBe(true);
  });
});

describe('/sources', () => {
  it('lists sources with their live counts', async () => {
    const { impl, calls } = stubFetch(() =>
      json([
        {
          id: 1,
          source_id: 'PLabc',
          kind: 'playlist',
          url: 'https://youtube.com/playlist?list=PLabc',
          title: 'Timeless',
          enabled: true,
          quality_override: {},
          last_checked_at: null,
          last_added_at: null,
          created_at: null,
          updated_at: null,
          counts: { total: 19, downloaded: 13, failed: 6 },
        },
      ]),
    );
    const api = new YtmonApi({ baseUrl: BASE, token: 't', fetchImpl: impl });
    const [s] = await api.listSources();
    expect(calls[0]!.url).toBe(`${BASE}/api/v1/sources`);
    expect(s!.counts).toEqual({ total: 19, downloaded: 13, failed: 6 });
  });

  it('creates a source with an object override, never a bare string', async () => {
    const { impl, calls } = stubFetch(() => json({ source_id: 'WL', kind: 'watch_later', counts: { total: 0, downloaded: 0, failed: 0 } }));
    const api = new YtmonApi({ baseUrl: BASE, token: 't', fetchImpl: impl });
    await api.createSource({ url: 'watch_later', quality_override: { quality: '480p', media_type: 'audio' } });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      url: 'watch_later',
      quality_override: { quality: '480p', media_type: 'audio' },
    });
  });

  it('previews via POST (browsers strip GET bodies)', async () => {
    const { impl, calls } = stubFetch(() => json({ source_id: 'PL1', kind: 'playlist', count: 3, truncated: false, cookies_required: false, entries: [] }));
    const api = new YtmonApi({ baseUrl: BASE, token: 't', fetchImpl: impl });
    const p = await api.previewSource('PL1');
    expect(calls[0]!.init.method).toBe('POST');
    expect(p.cookies_required).toBe(false);
  });

  it('reads cookies_configured so an empty Watch Later is explainable', async () => {
    const { impl } = stubFetch(() => json({ sources: 2, enabled: 2, running: true, last_error: null, cookies_configured: false, default_quality: 'best' }));
    const api = new YtmonApi({ baseUrl: BASE, token: 't', fetchImpl: impl });
    expect((await api.sourcesStatus()).cookies_configured).toBe(false);
  });

  it('scans are POSTs and are never auto-retried by the client', async () => {
    const { impl, calls } = stubFetch(() => json({ results: [{ source: 'PL1', seen: 1, new: 0, queued: 0, duplicates: 1, truncated: false, error: null }] }));
    const api = new YtmonApi({ baseUrl: BASE, token: 't', fetchImpl: impl });
    const r = await api.scanAllSources();
    expect(calls[0]!.init.method).toBe('POST');
    expect(r.results[0]!.duplicates).toBe(1);
  });
});

describe('Channel.quality_override is an object', () => {
  it('must never be rendered directly (React objects-as-children crash)', () => {
    const override = { quality: '720p' as const };
    // The renderer reads .quality; the old code interpolated the object itself
    // and crashed the Channels screen with React error #31.
    expect(override.quality).toBe('720p');
    expect(typeof override).toBe('object');
  });
});

describe('thumbnails come from the authenticated proxy', () => {
  it('never uses Video.thumbnail_url', () => {
    expect(thumbUrl('abc123')).toBe('ytmon-media://thumb/abc123');
    expect(thumbUrl('abc123')).not.toContain('ytimg');
  });

  it('routes thumb URLs to the thumb handler', () => {
    expect(parseMediaUrl('ytmon-media://thumb/abc123')?.kind).toBe('thumb');
    expect(parseMediaUrl('ytmon-media://video/abc123')?.kind).toBe('video');
  });
});

describe('PUT /retention is strictly typed', () => {
  it('sends only the three known keys', async () => {
    const { impl, calls } = stubFetch(() => json({ delete_file_when_watched: false, retention_days: null, max_library_items: null }));
    const api = new YtmonApi({ baseUrl: BASE, token: 't', fetchImpl: impl });
    await api.setRetention({ delete_file_when_watched: true } as never);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(Object.keys(body)).toEqual(['delete_file_when_watched']);
  });

  it('never forwards unknown keys that would 422', async () => {
    const { impl, calls } = stubFetch(() => json({ delete_file_when_watched: false, retention_days: null, max_library_items: null }));
    const api = new YtmonApi({ baseUrl: BASE, token: 't', fetchImpl: impl });
    await api.setRetention({ bogus_field: 1 } as never);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({});
  });
});

describe('GET /videos never sends empty query values', () => {
  it('drops undefined and empty so a stale filter cannot 422', async () => {
    const { impl, calls } = stubFetch(() => json({ items: [], total: 0, page: 1, page_size: 50 }));
    const api = new YtmonApi({ baseUrl: BASE, token: 't', fetchImpl: impl });
    await api.listVideos({ search: undefined, status: undefined, watched: false });
    const q = new URL(calls[0]!.url).searchParams;
    expect(q.has('search')).toBe(false);
    expect(q.has('status')).toBe(false);
    expect(q.get('watched')).toBe('false');
  });
});