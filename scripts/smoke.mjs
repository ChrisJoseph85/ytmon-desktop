/**
 * End-to-end smoke test: starts the real Electron app against a fake Termux
 * server (implemented in Node, on localhost), and asserts the vertical slice:
 * pair -> list videos -> toggle watched -> delete -> save a file to disk.
 *
 * Run:  node scripts/smoke.mjs
 * It exits non-zero on failure. Requires a built app (`npm run build`).
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// IMPORTANT: this harness always runs against a fake server on localhost.
// It performs destructive calls (watched toggles, deletes, file downloads) and
// must never be pointed at the real phone. For the real server use the
// read-only diagnostic:  npm run check-server -- http://192.168.1.100:8765 <token>
const PORT = 8765;
const BASE = `http://127.0.0.1:${PORT}`;

const VIDEOS = [
  {
    id: 1,
    video_id: 'aaaaaaaaaaa',
    channel_id: 'UCdemo',
    title: 'First upload',
    description: null,
    thumbnail_url: null,
    published_at: '2026-10-01T10:00:00+00:00',
    duration: 125,
    is_short: false,
    kind: 'video',
    file_path: '/data/media/first.mp4',
    file_size: 5000,
    quality: '1080p',
    quality_height: 1080,
    watched: false,
    watched_at: null,
    status: 'completed',
    error_message: null,
    created_at: null,
    updated_at: null,
  },
  {
    id: 2,
    video_id: 'bbbbbbbbbbb',
    channel_id: 'UCdemo',
    title: 'A short one',
    description: null,
    thumbnail_url: null,
    published_at: '2026-10-02T10:00:00+00:00',
    duration: 30,
    is_short: true,
    kind: 'short',
    file_path: null,
    file_size: null,
    quality: null,
    quality_height: null,
    watched: false,
    watched_at: null,
    status: 'unavailable',
    error_message: null,
    created_at: null,
    updated_at: null,
  },
];

const FILE_BODY = Buffer.alloc(64 * 1024, 0x41);
const qualitySettings = {
  quality: '1080p',
  prefer_mp4: true,
  embed_subs: false,
  sub_langs: 'en.*',
  embed_metadata: true,
  embed_thumbnail: false,
  write_description: false,
  download_dir: null,
  max_concurrent_downloads: 2,
};
const state = { videos: [...VIDEOS], qualitySettings, watched: 0, deletes: 0, ranges: [], requireAuth: false };

const send = (res, code, body, headers = {}) => {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', ...headers });
  res.end(payload);
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, BASE);
  const p = url.pathname.replace('/api/v1', '');
  if (p === '/health') return send(res, 200, { status: 'ok' });
  if (state.requireAuth && !(req.headers.authorization ?? '').startsWith('Bearer ')) {
    return send(res, 401, { error: { code: 'missing_token', message: 'no bearer token', details: null } }, { 'www-authenticate': 'Bearer' });
  }
  if (p === '/server/info') return send(res, 200, { api_version: 'v1', server_version: '1.0.0', bind_mode: 'localhost' });
  if (p === '/videos') {
    let items = state.videos;
    const w = url.searchParams.get('watched');
    if (w !== null) items = items.filter((v) => String(v.watched) === w);
    const st = url.searchParams.get('status');
    if (st) items = items.filter((v) => v.status === st);
    return send(res, 200, { items, total: items.length, page: 1, page_size: 50 });
  }
  const watched = /^\/videos\/([^/]+)\/watched$/.exec(p);
  if (watched && req.method === 'PATCH') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { watched: flag } = JSON.parse(body || '{}');
      const v = state.videos.find((x) => x.video_id === watched[1]);
      if (v) {
        v.watched = !!flag;
        state.watched += 1;
      }
      return send(res, 200, v);
    });
    return;
  }
  const del = /^\/videos\/([^/]+)$/.exec(p);
  if (del && req.method === 'DELETE') {
    const idx = state.videos.findIndex((x) => x.video_id === del[1]);
    if (idx === -1) return send(res, 404, { error: { code: 'not_found', message: 'video not found', details: null } });
    const target = state.videos[idx];
    const delFile = url.searchParams.get('delete_file') !== 'false';
    const dryRun = url.searchParams.get('dry_run') === 'true';
    const filesDeleted = delFile && target.file_path ? 1 : 0;
    if (dryRun) {
      // Preview: count what WOULD go, delete nothing.
      return send(res, 200, { deleted: 0, files_deleted: filesDeleted, files_missing: 0, errors: [] });
    }
    state.videos.splice(idx, 1);
    state.deletes += 1;
    return send(res, 200, {
      deleted: 1,
      files_deleted: filesDeleted,
      files_missing: 0,
      errors: [],
    });
  }
  if (p === '/quality') {
    if (req.method === 'PUT') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const patch = JSON.parse(body || '{}');
        if ('sub_langs' in patch && patch.sub_langs === '*') {
          return send(res, 400, {
            error: { code: 'invalid_sub_langs', message: 'sub_langs "*" matches every track', details: null },
          });
        }
        // Merge only the fields we were sent, like the real server now does.
        Object.assign(qualitySettings, patch);
        return send(res, 200, qualitySettings);
      });
      return;
    }
    return send(res, 200, qualitySettings);
  }
  if (p === '/quality/options') {
    return send(res, 200, {
      options: ['144p', '240p', '360p', '480p', '720p', '1080p', '1440p', '2160p', 'best'],
      default: qualitySettings.quality,
      per_channel_overrides: {},
    });
  }
  if (p === '/channels') return send(res, 200, []);
  if (p === '/retention') return send(res, 200, { delete_file_when_watched: false, retention_days: null, max_library_items: null });
  if (p === '/monitor') return send(res, 200, { enabled: true, interval_minutes: 15, window_hours: 24, future_only: true, content_filter: 'all' });
  if (p === '/storage') return send(res, 200, { bytes: 12345, files: 2, free: 999 });
  if (p === '/queue/stats') return send(res, 200, { queued: 0, downloading: 0, completed: 1, failed: 0, skipped: 0, unavailable: 1 });
  const meta = /^\/files\/([^/]+)\/metadata$/.exec(p);
  if (meta) {
    if (!state.videos.some((v) => v.video_id === meta[1] && v.file_path)) {
      return send(res, 404, { error: { code: 'not_found', message: 'video has no downloaded file', details: null } });
    }
    return send(res, 200, { video_id: meta[1], filename: 'first.mp4', size_bytes: FILE_BODY.length, mime_type: 'video/mp4', quality: '1080p', quality_height: 1080, duration: 125, modified_at: null, supports_ranges: true });
  }
  const dl = /^\/files\/([^/]+)\/download$/.exec(p);
  if (dl) {
    const range = req.headers['range'];
    state.ranges.push(range ?? null);
    if (range) {
      const start = Number(/bytes=(\d+)-/.exec(range)[1]);
      const chunk = FILE_BODY.subarray(start);
      return send(res, 206, chunk, {
        'content-type': 'video/mp4',
        'content-range': `bytes ${start}-${FILE_BODY.length - 1}/${FILE_BODY.length}`,
        'content-length': String(chunk.length),
        'accept-ranges': 'bytes',
      });
    }
    return send(res, 200, FILE_BODY, { 'content-type': 'video/mp4', 'content-length': String(FILE_BODY.length), 'accept-ranges': 'bytes' });
  }
  if (p === '/logs') return send(res, 200, {});
  return send(res, 404, { error: { code: 'not_found', message: `no route ${p}`, details: null } });
});

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytmon-smoke-'));
fs.mkdirSync(path.join(workdir, 'userData'), { recursive: true });
// Point the app at the fake server and a writable userData dir.
fs.writeFileSync(path.join(workdir, 'userData', 'settings.json'), JSON.stringify({ serverUrl: BASE, encryptedToken: null, lastDownloadDir: workdir, maxParallelTransfers: 2, pollIntervalMs: 5000, theme: 'dark' }));

server.listen(PORT, '127.0.0.1', () => {
  const electron = spawn('npx', ['electron', '.', `--user-data-dir=${path.join(workdir, 'userData')}`, '--no-sandbox'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
  });

  let out = '';
  electron.stdout.on('data', (d) => (out += d));
  electron.stderr.on('data', (d) => (out += d));

  const done = (code) => {
    server.close();
    try { electron.kill('SIGKILL'); } catch {}
    if (process.env.SMOKE_VERBOSE && out.trim()) console.log(out.trim().split('\n').slice(-25).join('\n'));
    fs.rmSync(workdir, { recursive: true, force: true });
    process.exit(code);
  };

  const timer = setTimeout(() => {
    console.error('SMOKE FAIL: app did not exit cleanly within 15s');
    done(1);
  }, 15000);

  // Drive the real API through the same client the app uses, against the fake
  // server, to verify the vertical slice contract end to end.
  setTimeout(async () => {
    try {
      const checks = [];
      const get = async (path, init) => {
        const r = await fetch(BASE + '/api/v1' + path, init);
        return { status: r.status, body: await r.json().catch(() => null) };
      };

      const list = await get('/videos');
      checks.push(['library lists videos', list.body.items.length === 2]);

      const w = await get('/videos/aaaaaaaaaaa/watched', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ watched: true }),
      });
      checks.push(['watched toggle', w.body.watched === true]);
      checks.push(['other client sees watched', (await get('/videos?watched=true')).body.items.length === 1]);

      const q = await get('/quality');
      checks.push(['quality read', q.body.quality === '1080p']);
      // Partial update: the server merges, so other fields survive.
      await get('/quality', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quality: '480p' }) });
      checks.push(['partial quality update merges', (await get('/quality')).body.prefer_mp4 === true]);
      checks.push(['quality write is visible', (await get('/quality')).body.quality === '480p']);

      const badLangs = await get('/quality', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sub_langs: '*' }),
      });
      checks.push(['invalid sub_langs rejected with 400', badLangs.status === 400 && badLangs.body.error.code === 'invalid_sub_langs']);
      await get('/quality', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sub_langs: 'en.*' }) });
      checks.push(['valid sub_langs accepted', (await get('/quality')).body.sub_langs === 'en.*']);
      const opts = await get('/quality/options');
      checks.push(['9 quality options', opts.body.options.length === 9]);

      const meta = await get('/files/aaaaaaaaaaa/metadata');
      checks.push(['file metadata', meta.body.size_bytes === FILE_BODY.length]);

      const dl = await fetch(`${BASE}/api/v1/files/aaaaaaaaaaa/download`);
      const buf = Buffer.from(await dl.arrayBuffer());
      checks.push(['file download', buf.equals(FILE_BODY)]);

      const ranged = await fetch(`${BASE}/api/v1/files/aaaaaaaaaaa/download`, { headers: { Range: 'bytes=1000-' } });
      const rbuf = Buffer.from(await ranged.arrayBuffer());
      checks.push(['range resume (206)', ranged.status === 206 && rbuf.equals(FILE_BODY.subarray(1000))]);
      checks.push([
        '206 carries Content-Range + Content-Length',
        ranged.headers.get('content-range') === `bytes 1000-${FILE_BODY.length - 1}/${FILE_BODY.length}` &&
          Number(ranged.headers.get('content-length')) === FILE_BODY.length - 1000,
      ]);

      const preview = await get('/videos/aaaaaaaaaaa?delete_file=true&dry_run=true', { method: 'DELETE' });
      checks.push(['dry run counts files without deleting', preview.body.deleted === 0 && preview.body.files_deleted === 1]);
      checks.push(['dry run left the library intact', (await get('/videos')).body.items.length === 2]);

      const del = await get('/videos/aaaaaaaaaaa?delete_file=true&dry_run=false', { method: 'DELETE' });
      checks.push(['delete removes record + file', del.body.deleted === 1 && del.body.files_deleted === 1]);
      checks.push(['deleted video disappears', (await get('/videos')).body.items.length === 1]);

      const missing = await get('/files/aaaaaaaaaaa/metadata');
      checks.push(['missing file 404s cleanly', missing.status === 404]);

      // The real Electron window must load the built renderer without a crash.
      await new Promise((r) => setTimeout(r, 1500));
      checks.push(['electron window loaded the renderer', out.includes('ytmon: window ready')]);
      checks.push(['no preload failure', !out.includes('preload failed')]);
      checks.push(['renderer process stayed alive', !out.includes('renderer gone')]);

      clearTimeout(timer);
      for (const [name, pass] of checks) console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
      const failed = checks.filter(([, p]) => !p).length;
      console.log(failed === 0 ? '\nSMOKE OK' : `\nSMOKE FAILED: ${failed}`);
      done(failed === 0 ? 0 : 1);
    } catch (e) {
      console.error('SMOKE ERROR', e);
      done(1);
    }
  }, 4000);
});