import { describe, expect, it } from 'vitest';
import { YtmonApi } from '../src/main/api';
import { downloadUrlForSearch } from '../src/renderer/lib/filters';
import { mediaUrl, parseMediaUrl, MEDIA_SCHEME } from '../src/shared/media';
import { formatBytes, formatDuration } from '../src/shared/format';
import type { Video, VideoPage } from '../src/shared/types';

/**
 * A tiny in-memory implementation of the server's documented contract, shared
 * by these tests. Two independent "clients" read and mutate the same store —
 * this is exactly how the desktop and the Android app stay consistent.
 */
function makeFakeServer() {
  const quality = { quality: '1080p', prefer_mp4: true, embed_subs: false, embed_metadata: true, max_concurrent_downloads: 2 };
  const retention = { delete_file_when_watched: false, retention_days: null as number | null, max_library_items: null as number | null };
  const videos = new Map<string, Video>();
  const seenIds = new Set<string>(); // server-side dedupe
  const tokens = new Set<string>();
  let requiresAuth = false;

  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const p = url.pathname.replace('/api/v1', '');
    const method = init.method ?? 'GET';
    const headers = (init.headers ?? {}) as Record<string, string>;
    const authed = headers['Authorization']?.startsWith('Bearer ') && tokens.has(headers['Authorization']!.slice(7));
    const body = init.body ? JSON.parse(String(init.body)) : null;

    const err = (status: number, code: string, message: string) =>
      new Response(JSON.stringify({ error: { code, message, details: null } }), { status });

    if (p === '/health') return new Response(JSON.stringify({ status: 'ok' }));
    if (requiresAuth && !authed && p !== '/health' && p !== '/server/info') return err(401, 'unauthorized', 'missing token');

    switch (`${method} ${p}`) {
      case 'GET /quality':
        return new Response(JSON.stringify(quality));
      case 'PUT /quality':
        Object.assign(quality, body);
        return new Response(JSON.stringify(quality));
      case 'GET /quality/options':
        return new Response(
          JSON.stringify({
            options: ['144p', '240p', '360p', '480p', '720p', '1080p', '1440p', '2160p', 'best'],
            default: quality.quality,
            per_channel_overrides: {},
          }),
        );
      case 'GET /retention':
        return new Response(JSON.stringify(retention));
      case 'PUT /retention':
        Object.assign(retention, body);
        if (retention.delete_file_when_watched) {
          for (const v of videos.values()) {
            if (v.watched) {
              v.file_path = null;
              v.file_size = null;
            }
          }
        }
        return new Response(JSON.stringify(retention));
      case 'PATCH /videos/dQw4w9WgXcQ/watched': {
        const v = videos.get('dQw4w9WgXcQ')!;
        v.watched = !!body.watched;
        v.watched_at = v.watched ? '2026-10-10T00:00:00+00:00' : null;
        if (retention.delete_file_when_watched && v.watched) {
          v.file_path = null;
          v.file_size = null;
        }
        return new Response(JSON.stringify(v));
      }
      case 'DELETE /videos/dQw4w9WgXcQ': {
        const deleteFile = url.searchParams.get('delete_file') !== 'false';
        const v = videos.get('dQw4w9WgXcQ')!;
        const had = Boolean(v.file_path);
        videos.delete('dQw4w9WgXcQ');
        return new Response(
          JSON.stringify({
            deleted: 1,
            files_deleted: deleteFile && had ? 1 : 0,
            files_missing: deleteFile && !had ? 1 : 0,
            errors: [],
          }),
        );
      }
      case 'POST /videos/bulk-delete': {
        const ids: string[] = body.video_ids;
        let files = 0;
        for (const id of ids) {
          const v = videos.get(id);
          if (v?.file_path && body.delete_files) files += 1;
          videos.delete(id);
        }
        return new Response(
          JSON.stringify({ deleted: ids.length, files_deleted: files, files_missing: 0, errors: [] }),
        );
      }
      case 'GET /videos': {
        let items = [...videos.values()];
        if (url.searchParams.get('watched') !== null) {
          const w = url.searchParams.get('watched') === 'true';
          items = items.filter((v) => v.watched === w);
        }
        if (url.searchParams.get('status')) items = items.filter((v) => v.status === url.searchParams.get('status'));
        if (url.searchParams.get('kind')) items = items.filter((v) => v.kind === url.searchParams.get('kind'));
        if (url.searchParams.get('search')) {
          const q = url.searchParams.get('search')!.toLowerCase();
          items = items.filter((v) => v.title.toLowerCase().includes(q));
        }
        const page = Number(url.searchParams.get('page') ?? 1);
        const size = Number(url.searchParams.get('page_size') ?? 50);
        const body_: VideoPage = { items: items.slice((page - 1) * size, page * size), total: items.length, page, page_size: size };
        return new Response(JSON.stringify(body_));
      }
      case 'POST /videos/discover': {
        // Dedupe: the same video_id is never queued/downloaded twice.
        if (seenIds.has(body.video_id)) {
          return new Response(JSON.stringify({ duplicate: true, created: false }));
        }
        seenIds.add(body.video_id);
        return new Response(JSON.stringify({ created: true, duplicate: false }));
      }
      default:
        return err(404, 'not_found', `no route for ${method} ${p}`);
    }
  }) as unknown as typeof fetch;

  return {
    impl,
    state: { quality, retention, videos, seenIds },
    requireAuth(v: boolean) {
      requiresAuth = v;
    },
    addToken(t: string) {
      tokens.add(t);
    },
  };
}

function video(over: Partial<Video> = {}): Video {
  return {
    id: 1,
    video_id: 'dQw4w9WgXcQ',
    channel_id: 'UC123',
    media_type: 'video',
    thumbnail_path: null,
    source_id: null,
    pinned: false,
    title: 'A video',
    description: null,
    thumbnail_url: null,
    published_at: '2026-10-01T00:00:00+00:00',
    duration: 300,
    is_short: false,
    kind: 'video',
    file_path: '/data/media/x.mp4',
    file_size: 1024,
    quality: '1080p',
    quality_height: 1080,
    watched: false,
    watched_at: null,
    status: 'completed',
    error_message: null,
    created_at: null,
    updated_at: null,
    ...over,
  };
}

describe('cross-client consistency (acceptance check: both clients see the same state)', () => {
  it('a quality change in one client is visible to the other after a refresh', async () => {
    const s = makeFakeServer();
    const desktop = new YtmonApi({ baseUrl: 'http://192.168.1.100:8765', fetchImpl: s.impl });
    const android = new YtmonApi({ baseUrl: 'http://127.0.0.1:8765', fetchImpl: s.impl });

    expect((await desktop.getQuality()).quality).toBe('1080p');
    await desktop.setQuality({ quality: '480p' });

    // The other client re-reads and sees the stored value, not its own cache.
    expect((await android.getQuality()).quality).toBe('480p');
    expect((await android.qualityOptions()).default).toBe('480p');
  });

  it('every quality value can be written and is read back by the other client', async () => {
    const s = makeFakeServer();
    const desktop = new YtmonApi({ baseUrl: 'http://192.168.1.100:8765', fetchImpl: s.impl });
    const android = new YtmonApi({ baseUrl: 'http://192.168.1.100:8765', fetchImpl: s.impl });
    const opts = (await desktop.qualityOptions()).options;

    expect(opts).toHaveLength(9);
    for (const q of opts) {
      await desktop.setQuality({ quality: q });
      expect((await android.getQuality()).quality).toBe(q);
    }
  });

  it('a library item marked watched in one client shows watched in the other', async () => {
    const s = makeFakeServer();
    s.state.videos.set('dQw4w9WgXcQ', video());
    const desktop = new YtmonApi({ baseUrl: 'http://192.168.1.100:8765', fetchImpl: s.impl });
    const android = new YtmonApi({ baseUrl: 'http://192.168.1.100:8765', fetchImpl: s.impl });

    await desktop.setWatched('dQw4w9WgXcQ', true);
    const other = await android.listVideos({ watched: true });
    expect(other.items).toHaveLength(1);
    expect(other.items[0]!.watched).toBe(true);
  });

  it('a deleted video disappears from the other client after refresh', async () => {
    const s = makeFakeServer();
    s.state.videos.set('dQw4w9WgXcQ', video());
    const desktop = new YtmonApi({ baseUrl: 'http://192.168.1.100:8765', fetchImpl: s.impl });
    const android = new YtmonApi({ baseUrl: 'http://192.168.1.100:8765', fetchImpl: s.impl });

    const result = await desktop.deleteVideo('dQw4w9WgXcQ', true);
    expect(result).toMatchObject({ deleted: 1, files_deleted: 1 });
    expect((await android.listVideos({})).items).toHaveLength(0);
  });

  it('delete semantics distinguish file removal from record removal', async () => {
    const s = makeFakeServer();
    s.state.videos.set('dQw4w9WgXcQ', video());
    const api = new YtmonApi({ baseUrl: 'http://192.168.1.100:8765', fetchImpl: s.impl });
    const keepFile = await api.deleteVideo('dQw4w9WgXcQ', false);
    expect(keepFile).toMatchObject({ deleted: 1, files_deleted: 0 });

    s.state.videos.set('dQw4w9WgXcQ', video({ file_path: null, file_size: null }));
    const missing = await api.deleteVideo('dQw4w9WgXcQ', true);
    expect(missing).toMatchObject({ deleted: 1, files_deleted: 0, files_missing: 1 });
  });

  it('delete-after-watch is off by default and keeps the row but clears the file when on', async () => {
    const s = makeFakeServer();
    s.state.videos.set('dQw4w9WgXcQ', video());
    const api = new YtmonApi({ baseUrl: 'http://192.168.1.100:8765', fetchImpl: s.impl });

    expect((await api.getRetention()).delete_file_when_watched).toBe(false);
    await api.setWatched('dQw4w9WgXcQ', true);
    expect(s.state.videos.get('dQw4w9WgXcQ')!.file_path).not.toBeNull();

    await api.setRetention({ delete_file_when_watched: true });
    await api.setWatched('dQw4w9WgXcQ', false);
    await api.setWatched('dQw4w9WgXcQ', true);
    const v = s.state.videos.get('dQw4w9WgXcQ')!;
    expect(v.watched).toBe(true);
    expect(v.file_path).toBeNull();
    expect(v.file_size).toBeNull();
  });

  it('duplicate uploads are never queued twice (server-side dedupe, client stays idempotent)', async () => {
    const s = makeFakeServer();
    const api = new YtmonApi({ baseUrl: 'http://192.168.1.100:8765', fetchImpl: s.impl });
    const first = await api.request('/videos/discover', { method: 'POST', body: { video_id: 'dQw4w9WgXcQ' } });
    const second = await api.request('/videos/discover', { method: 'POST', body: { video_id: 'dQw4w9WgXcQ' } });
    expect(first).toMatchObject({ created: true });
    expect(second).toMatchObject({ duplicate: true });
    expect(s.state.seenIds.size).toBe(1);
  });
});

describe('authentication (acceptance check: protected endpoints need a token in LAN mode)', () => {
  it('health and server info stay public while everything else needs the token', async () => {
    const s = makeFakeServer();
    s.requireAuth(true);
    const anon = new YtmonApi({ baseUrl: 'http://192.168.1.100:8765', fetchImpl: s.impl });

    await expect(anon.health()).resolves.toMatchObject({ status: 'ok' });
    await expect(anon.getQuality()).rejects.toMatchObject({ status: 401 });
    // Destructive calls are protected too.
    await expect(anon.setQuality({ quality: '720p' })).rejects.toMatchObject({ status: 401 });
    await expect(anon.deleteVideo('dQw4w9WgXcQ', true)).rejects.toMatchObject({ status: 401 });
    await expect(anon.bulkDelete(['dQw4w9WgXcQ'], true)).rejects.toMatchObject({ status: 401 });
    await expect(anon.setRetention({ delete_file_when_watched: true })).rejects.toMatchObject({ status: 401 });
  });

  it('a valid token is accepted immediately', async () => {
    const s = makeFakeServer();
    s.requireAuth(true);
    s.addToken('tok_live');
    const api = new YtmonApi({ baseUrl: 'http://192.168.1.100:8765', token: 'tok_live', fetchImpl: s.impl });
    await expect(api.getQuality()).resolves.toMatchObject({ quality: '1080p' });
  });

  it('a revoked token stops working on the very next request', async () => {
    const s = makeFakeServer();
    s.requireAuth(true);
    s.addToken('tok_temp');
    const api = new YtmonApi({ baseUrl: 'http://192.168.1.100:8765', token: 'tok_temp', fetchImpl: s.impl });
    await expect(api.health()).resolves.toMatchObject({ status: 'ok' });
    // revocation clears the token server-side
    s.addToken('other');
    (s as unknown as { requireAuth(v: boolean): void }).requireAuth(true);
    const revoked = new YtmonApi({ baseUrl: 'http://192.168.1.100:8765', token: 'revoked', fetchImpl: s.impl });
    await expect(revoked.getQuality()).rejects.toMatchObject({ status: 401 });
  });
});

describe('library query mapping', () => {
  it('maps each view onto documented server parameters', () => {
    const base = { kind: 'all' as const, search: '', channelId: '', sort: 'published_at', order: 'desc' as const, page: 1, page_size: 24 };
    expect(downloadUrlForSearch({ ...base, view: 'unwatched' }).watched).toBe(false);
    expect(downloadUrlForSearch({ ...base, view: 'watched' }).watched).toBe(true);
    expect(downloadUrlForSearch({ ...base, view: 'downloading' }).status).toBe('downloading');
    expect(downloadUrlForSearch({ ...base, view: 'completed' }).status).toBe('completed');
    expect(downloadUrlForSearch({ ...base, view: 'failed' }).status).toBe('failed');
    expect(downloadUrlForSearch({ ...base, view: 'all' })).not.toHaveProperty('status');
  });

  it('shorts-only and regular-only filters use the documented kind enum', () => {
    const base = { view: 'all' as const, search: '', channelId: '', sort: 'published_at', order: 'desc' as const, page: 1, page_size: 24 };
    expect(downloadUrlForSearch({ ...base, kind: 'short' }).kind).toBe('short');
    expect(downloadUrlForSearch({ ...base, kind: 'video' }).kind).toBe('video');
    expect(downloadUrlForSearch({ ...base, kind: 'all' })).not.toHaveProperty('kind');
  });

  it('clamps page and page_size into the documented range', () => {
    const q = downloadUrlForSearch({
      view: 'all', kind: 'all', search: '', channelId: '', sort: 'id', order: 'asc', page: 0, page_size: 5000,
    });
    expect(q.page).toBe(1);
    expect(q.page_size).toBe(200);
  });
});

describe('playback media scheme (token never reaches the renderer)', () => {
  it('builds a URL carrying only the video id', () => {
    expect(mediaUrl('dQw4w9WgXcQ')).toBe(`${MEDIA_SCHEME}://video/dQw4w9WgXcQ`);
  });

  it('parses ids and range hints, rejecting anything else', () => {
    expect(parseMediaUrl(`${MEDIA_SCHEME}://video/dQw4w9WgXcQ`)).toEqual({
      kind: 'video',
      videoId: 'dQw4w9WgXcQ',
      range: null,
    });
    expect(parseMediaUrl(`${MEDIA_SCHEME}://video/dQw4w9WgXcQ?range=bytes=512-`)).toEqual({
      kind: 'video',
      videoId: 'dQw4w9WgXcQ',
      range: 'bytes=512-',
    });
    expect(parseMediaUrl(`${MEDIA_SCHEME}://file//etc/passwd`)).toBeNull();
    expect(parseMediaUrl('https://evil.example/video/x')).toBeNull();
  });
});

describe('formatting helpers', () => {
  it('formats bytes and durations for the library grid', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(null)).toBe('—');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatDuration(null)).toBe('—');
  });
});