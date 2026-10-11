import { protocol } from 'electron';
import { Readable } from 'node:stream';
import type { YtmonApi } from './api';
import { networkError } from './api';
import { parseMediaUrl, MEDIA_SCHEME, mediaUrl, pickRange, upstreamHeaders } from '../shared/media';

export { MEDIA_SCHEME, mediaUrl };

/**
 * Custom scheme used for in-app playback only.
 *
 * The renderer must never hold the bearer token, so it asks for
 * `ytmon-media://video/<video_id>` and this handler injects the Authorization
 * header itself, forwarding Range requests so seeking and resume work.
 * No filesystem path is ever exposed: the URL carries only a video id.
 */
export function registerMediaSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
      },
    },
  ]);
}

export function registerMediaProtocol(getApi: () => YtmonApi): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const parsed = parseMediaUrl(request.url);
    if (!parsed) return new Response('Bad media request', { status: 400 });

    const api = getApi();

    // ---- thumbnails ---------------------------------------------------
    // <img> cannot send a bearer header and Video.thumbnail_url points at
    // YouTube (dead on an offline phone), so the renderer loads thumbnails
    // through here instead.
    if (parsed.kind === 'thumb') {
      try {
        const res = await api.http(api.thumbnailUrl(parsed.videoId), { headers: api.headers() });
        if (res.status === 200) {
          return new Response(new Uint8Array(await res.arrayBuffer()), {
            status: 200,
            headers: {
              'content-type': res.headers.get('content-type') ?? 'image/jpeg',
              'cache-control': 'no-store',
            },
          });
        }
        if (res.status === 404) {
          // Nothing cached on the server: render the placeholder instead.
          return new Response(null, { status: 404 });
        }
        // 307 (nothing cached yet) and anything else: let the caller fall back.
        return new Response(null, { status: res.status === 307 ? 404 : 502 });
      } catch (e) {
        const y = networkError(e, api.base);
        return new Response(JSON.stringify({ error: { code: y.code, message: y.message } }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        });
      }
    }

    try {
      // A <video> element seeks by sending a Range REQUEST HEADER, not a URL
      // parameter. Reading only the query param meant every seek came back as a
      // full 200 body from byte 0, so seeking silently snapped back to the start.
      const headers = upstreamHeaders({
        auth: api.headers(),
        range: pickRange(request.headers, parsed.range),
        ifRange: request.headers.get('If-Range'),
      });

      const upstream = await fetch(`${api.apiBase}/files/${encodeURIComponent(parsed.videoId)}/stream`, {
        headers,
      });

      if (upstream.status === 404) {
        return new Response(
          JSON.stringify({ error: { code: 'not_found', message: 'This video has no downloaded file on the server.' } }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        );
      }
      // 206 partial content is a success, not an error.
      if (!upstream.ok && upstream.status !== 206) {
        // fall through to the error response below
        const body = (await upstream.json().catch(() => null)) as
          | { error?: { message?: string; code?: string } }
          | null;
        return new Response(
          JSON.stringify({
            error: {
              code: body?.error?.code ?? `http_${upstream.status}`,
              message: body?.error?.message ?? 'Playback failed',
            },
          }),
          { status: upstream.status, headers: { 'content-type': 'application/json' } },
        );
      }

      const outHeaders = new Headers();
      for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified']) {
        const v = upstream.headers.get(key);
        if (v) outHeaders.set(key, v);
      }
      outHeaders.set('accept-ranges', 'bytes');
      outHeaders.set('cache-control', 'no-store');

      return new Response(upstream.body ? (Readable.fromWeb(upstream.body as never) as never) : null, {
        status: upstream.status,
        headers: outHeaders,
      });
    } catch (e) {
      const y = networkError(e, api.base);
      return new Response(JSON.stringify({ error: { code: y.code, message: y.message } }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      });
    }
  });
}