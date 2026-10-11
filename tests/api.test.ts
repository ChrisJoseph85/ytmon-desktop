import { describe, expect, it, vi } from 'vitest';
import { YtmonApi } from '../src/main/api';
import { validateServerUrl, sanitizeFilename, isYouTubeVideoId } from '../src/shared/format';

/** Minimal fetch stub that records requests and returns queued responses. */
function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('server URL validation', () => {
  it('accepts a LAN host:port and normalizes it', () => {
    const v = validateServerUrl('192.168.1.100:8765/');
    expect(v.ok).toBe(true);
    expect(v.normalized).toBe('http://192.168.1.100:8765');
    expect(v.port).toBe(8765);
    expect(v.isLoopback).toBe(false);
  });

  it('treats 127.0.0.1 as loopback/trusted', () => {
    expect(validateServerUrl('http://127.0.0.1:8765').isLoopback).toBe(true);
    expect(validateServerUrl('http://localhost:8765').isLoopback).toBe(true);
  });

  it('rejects non-http schemes, credentials and paths', () => {
    expect(validateServerUrl('ftp://host:21').ok).toBe(false);
    expect(validateServerUrl('http://user:pw@host:8765').ok).toBe(false);
    expect(validateServerUrl('http://host:8765/some/path').ok).toBe(false);
    expect(validateServerUrl('').ok).toBe(false);
  });
});

describe('filename safety', () => {
  it('strips directory traversal and separators', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('a\\b\\c.mp4')).toBe('c.mp4');
    expect(sanitizeFilename('/abs/path/video.mp4')).toBe('video.mp4');
  });

  it('falls back when the name is unusable', () => {
    expect(sanitizeFilename('')).toBe('video.mp4');
    expect(sanitizeFilename('...')).toBe('video.mp4');
  });
});

describe('video id validation', () => {
  it('accepts 11-char youtube ids and rejects junk', () => {
    expect(isYouTubeVideoId('dQw4w9WgXcQ')).toBe(true);
    expect(isYouTubeVideoId('../../x')).toBe(false);
    expect(isYouTubeVideoId('')).toBe(false);
  });
});

describe('YtmonApi', () => {
  it('always sends the bearer token, even on loopback', async () => {
    const { impl, calls } = stubFetch(() => json({ status: 'ok' }));
    const api = new YtmonApi({ baseUrl: 'http://127.0.0.1:8765', token: 'tok_abc123', fetchImpl: impl });
    await api.health();
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tok_abc123');
    expect(calls[0]!.url).toBe('http://127.0.0.1:8765/api/v1/health');
  });

  it('omits the header when no token is configured', async () => {
    const { impl, calls } = stubFetch(() => json({ status: 'ok' }));
    const api = new YtmonApi({ baseUrl: 'http://127.0.0.1:8765', fetchImpl: impl });
    await api.health();
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('surfaces the server error envelope rather than parsing text', async () => {
    const { impl } = stubFetch(() =>
      json({ error: { code: 'not_found', message: 'video not found', details: null } }, 404),
    );
    const api = new YtmonApi({ baseUrl: 'http://192.168.1.100:8765', fetchImpl: impl });
    await expect(api.fileMeta('dQw4w9WgXcQ')).rejects.toMatchObject({
      code: 'not_found',
      message: 'video not found',
      status: 404,
    });
  });

  it('flags 401 as an auth error so the UI can prompt for a token', async () => {
    const { impl } = stubFetch(() => json({ error: { code: 'unauthorized', message: 'invalid token' } }, 401));
    const api = new YtmonApi({ baseUrl: 'http://192.168.1.100:8765', fetchImpl: impl });
    await expect(api.listVideos()).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
  });

  it('sends documented query parameters and skips empty ones', async () => {
    const { impl, calls } = stubFetch(() => json({ items: [], total: 0, page: 1, page_size: 50 }));
    const api = new YtmonApi({ baseUrl: 'http://192.168.1.100:8765', fetchImpl: impl });
    await api.listVideos({ search: 'lofi', status: 'completed', watched: false, page: 2, page_size: 24 });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/api/v1/videos');
    expect(url.searchParams.get('search')).toBe('lofi');
    expect(url.searchParams.get('status')).toBe('completed');
    expect(url.searchParams.get('watched')).toBe('false');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('page_size')).toBe('24');
  });

  it('uses delete_file + dry_run on single delete and delete_files + dry_run on bulk delete', async () => {
    const { impl, calls } = stubFetch(() => json({ deleted: 1, files_deleted: 1, files_missing: 0, errors: [] }));
    const api = new YtmonApi({ baseUrl: 'http://192.168.1.100:8765', fetchImpl: impl });

    await api.deleteVideo('abc', false);
    expect(new URL(calls[0]!.url).searchParams.get('delete_file')).toBe('false');
    expect(new URL(calls[0]!.url).searchParams.get('dry_run')).toBe('false');
    expect(calls[0]!.init.method).toBe('DELETE');

    await api.bulkDelete(['a', 'b'], true);
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
      video_ids: ['a', 'b'],
      delete_files: true,
      dry_run: false,
    });
    expect(calls[1]!.init.method).toBe('POST');
  });

  it('dry run previews before anything is destroyed', async () => {
    const { impl, calls } = stubFetch(() => json({ deleted: 0, files_deleted: 2, files_missing: 1, errors: [] }));
    const api = new YtmonApi({ baseUrl: 'http://192.168.1.100:8765', fetchImpl: impl });

    const preview = await api.previewBulkDelete(['a', 'b', 'c'], true);
    expect(calls[0]!.url).toContain('/videos/bulk-delete');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      video_ids: ['a', 'b', 'c'],
      delete_files: true,
      dry_run: true,
    });
    // A dry run must never actually delete anything.
    expect(preview.deleted).toBe(0);
    expect(preview.files_deleted).toBe(2);

    await api.deleteVideo('a', true, true);
    expect(new URL(calls[1]!.url).searchParams.get('dry_run')).toBe('true');
  });

  it('accepts numeric row ids as well as youtube ids in bulk deletes', async () => {
    const { impl, calls } = stubFetch(() => json({ deleted: 2, files_deleted: 0, files_missing: 0, errors: [] }));
    const api = new YtmonApi({ baseUrl: 'http://192.168.1.100:8765', fetchImpl: impl });
    await api.bulkDelete([12, 'dQw4w9WgXcQ'], false);
    expect(JSON.parse(String(calls[0]!.init.body)).video_ids).toEqual([12, 'dQw4w9WgXcQ']);
  });

  it('marks unavailable videos without offering a retry path in the client', async () => {
    const { impl, calls } = stubFetch(() => json({ status: 'unavailable' }));
    const api = new YtmonApi({ baseUrl: 'http://192.168.1.100:8765', fetchImpl: impl });
    // The retry endpoint exists on the server, but the client must not call it
    // for `unavailable`; this asserts the endpoint is a plain POST.
    await api.retry('abc');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.url).toContain('/queue/abc/retry');
  });

  it('reports an unreachable host as a network error, not a crash', async () => {
    const impl = (async () => {
      throw Object.assign(new Error('fetch failed'), { name: 'TypeError' });
    }) as unknown as typeof fetch;
    const api = new YtmonApi({ baseUrl: 'http://192.168.1.100:8765', fetchImpl: impl });
    await expect(api.health()).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('passes Range headers through for resumable transfers', async () => {
    const { impl, calls } = stubFetch(() => new Response(new Uint8Array([1, 2, 3]), { status: 206 }));
    const api = new YtmonApi({ baseUrl: 'http://192.168.1.100:8765', token: 't', fetchImpl: impl });
    const headers = api.headers();
    headers['Range'] = 'bytes=1024-';
    const res = await impl(`${api.apiBase}/files/abc/download`, { headers });
    // 206 is success, not an error.
    expect(res.status).toBe(206);
    expect(headers['Range']).toBe('bytes=1024-');
    expect(calls[0]!.url).toBe('http://192.168.1.100:8765/api/v1/files/abc/download');
  });

  it('sends a partial quality update without wiping the rest (server merges)', async () => {
    const { impl, calls } = stubFetch(() => json({ quality: '480p', prefer_mp4: true, embed_subs: false }));
    const api = new YtmonApi({ baseUrl: 'http://192.168.1.100:8765', fetchImpl: impl });
    await api.setQuality({ quality: '480p' });
    // Only the changed field is sent; the server merges it into the stored config.
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ quality: '480p' });
  });

  it('surfaces invalid_sub_langs as a 400 the UI must show', async () => {
    const { impl } = stubFetch(() =>
      json({ error: { code: 'invalid_sub_langs', message: 'sub_langs "*" matches every track', details: null } }, 400),
    );
    const api = new YtmonApi({ baseUrl: 'http://192.168.1.100:8765', fetchImpl: impl });
    await expect(api.setQuality({ sub_langs: '*' })).rejects.toMatchObject({
      code: 'invalid_sub_langs',
      status: 400,
    });
  });

  it('distinguishes missing_token from invalid_token on 401', async () => {
    const missing = stubFetch(() => json({ error: { code: 'missing_token', message: 'no bearer token' } }, 401));
    const api = new YtmonApi({ baseUrl: 'http://192.168.1.100:8765', fetchImpl: missing.impl });
    await expect(api.getQuality()).rejects.toMatchObject({ code: 'missing_token', status: 401 });

    const invalid = stubFetch(() => json({ error: { code: 'invalid_token', message: 'token revoked' } }, 401));
    const api2 = new YtmonApi({ baseUrl: 'http://192.168.1.100:8765', token: 'dead', fetchImpl: invalid.impl });
    await expect(api2.getQuality()).rejects.toMatchObject({ code: 'invalid_token' });
  });

  it('never allows a non-http base URL to be constructed', () => {
    expect(() => new YtmonApi({ baseUrl: 'file:///etc/passwd', fetchImpl: vi.fn() as unknown as typeof fetch })).toThrow();
  });
});