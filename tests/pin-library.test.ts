import { describe, expect, it } from 'vitest';
import { YtmonApi } from '../src/main/api';

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
const api = (impl: typeof fetch) => new YtmonApi({ baseUrl: BASE, token: 't', fetchImpl: impl });

describe('pin / keep permanently', () => {
  it('PATCHes the single pinned flag', async () => {
    const { impl, calls } = stubFetch(() => json({ video_id: 'abc', pinned: true }));
    await api(impl).setPinned('abc', true);
    expect(calls[0]!.url).toContain('/videos/abc/pinned');
    expect(calls[0]!.init.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ pinned: true });
  });

  it('bulk-pins with video_ids always present', async () => {
    const { impl, calls } = stubFetch(() => json({ updated: 2 }));
    await api(impl).pinVideos(['a', 'b'], true);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ video_ids: ['a', 'b'], pinned: true });
  });

  it('refuses an empty selection rather than relying on a 422', async () => {
    const { impl } = stubFetch(() => json({}));
    await expect(api(impl).pinVideos([], true)).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('lists pinned videos', async () => {
    const { impl, calls } = stubFetch(() => json([{ video_id: 'a', pinned: true }]));
    const r = await api(impl).listPinned();
    expect(calls[0]!.url).toContain('/videos/pinned');
    expect(r).toHaveLength(1);
  });
});

describe('GET /library/tree', () => {
  it('sends order and limit_per_folder', async () => {
    const { impl, calls } = stubFetch(() =>
      json({ folders: [], total_videos: 0, total_folders: 0, order: 'title', media_dir: '/root/ytmon/media' }),
    );
    await api(impl).libraryTree('title', 25);
    const u = new URL(calls[0]!.url);
    expect(u.searchParams.get('order')).toBe('title');
    expect(u.searchParams.get('limit_per_folder')).toBe('25');
  });

  it('exposes folders -> subfolders -> items with a true item_count', async () => {
    const { impl } = stubFetch(() =>
      json({
        folders: [
          {
            name: 'UCabc',
            channel_id: 'UCabc',
            channel_title: null,
            item_count: 12,
            total_bytes: 1024,
            subfolders: [
              { name: 'Timeless', source_id: 'PL1', item_count: 12, items: [{ video_id: 'a' }, { video_id: 'b' }] },
            ],
          },
        ],
        total_videos: 12,
        total_folders: 1,
        order: 'newest',
        media_dir: '/root/ytmon/media',
      }),
    );
    const t = await api(impl).libraryTree();
    const folder = t.folders[0]!;
    // item_count is the true total; items may be truncated — the UI shows both.
    expect(folder.item_count).toBe(12);
    expect(folder.subfolders[0]!.items).toHaveLength(2);
    expect(folder.channel_title).toBeNull(); // known gap: raw UC id fallback
  });
});

describe('PUT /library/settings is a merge', () => {
  it('sends only the changed field', async () => {
    const { impl, calls } = stubFetch(() =>
      json({
        media_layout: 'flat',
        tree_order: 'newest',
        retention_days: null,
        max_library_items: null,
        delete_file_when_watched: false,
      }),
    );
    await api(impl).updateLibrarySettings({ media_layout: 'flat' });
    // Only the one field — the server merges, so the others must not be sent.
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ media_layout: 'flat' });
  });

  it('preserves an explicit null (which clears a retention rule)', async () => {
    const { impl, calls } = stubFetch(() => json({ retention_days: null }));
    await api(impl).updateLibrarySettings({ retention_days: null });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ retention_days: null });
  });

  it('drops undefined so a no-op patch sends nothing', async () => {
    const { impl, calls } = stubFetch(() => json({}));
    await api(impl).updateLibrarySettings({ tree_order: undefined });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({});
  });
});

describe('media layouts', () => {
  it('exposes all four documented options and four orders', async () => {
    const { impl } = stubFetch(() =>
      json({
        options: ['channel_id', 'channel_title', 'channel_source', 'flat'],
        descriptions: { channel_id: 'media/<UCxxxx>/<video_id>.ext' },
        orders: ['newest', 'oldest', 'title', 'duration'],
      }),
    );
    const l = await api(impl).libraryLayouts();
    expect(l.options).toHaveLength(4);
    expect(l.orders).toHaveLength(4);
    expect(l.descriptions.channel_id).toContain('media/');
  });
});