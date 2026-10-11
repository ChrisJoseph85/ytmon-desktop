/**
 * Visual verification: launches the real Electron app against a fake server,
 * drives the UI through the Chrome DevTools Protocol, and writes PNGs of each
 * screen to release/screenshots/. No app code is modified.
 *
 * Run:  npm run build && node scripts/screenshots.mjs
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const PORT = 8766;
const CDP_PORT = 9400 + (process.pid % 200);
const BASE = `http://127.0.0.1:${PORT}`;
const outDir = path.join(root, 'release', 'screenshots');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const QUALITY = ['144p', '240p', '360p', '480p', '720p', '1080p', '1440p', '2160p', 'best'];

const mk = (i, over = {}) => ({
  id: i,
  video_id: `vid${String(i).padStart(7, '0')}`,
  channel_id: i % 2 === 0 ? 'UCaaa' : 'UCbbb',
  title: `Sample video number ${i} — a reasonably long title to check truncation behaviour`,
  description: 'A longer description used to check the details panel layout and wrapping behaviour in the player dialog.',
  thumbnail_url: null,
  published_at: `2026-10-0${(i % 9) + 1}T10:00:00+00:00`,
  duration: 60 + i * 37,
  is_short: false,
  kind: 'video',
  file_path: '/data/media/x.mp4',
  file_size: 12_345_678 * i,
  quality: '1080p',
  quality_height: 720,
  watched: i % 3 === 0,
  watched_at: null,
  status: 'completed',
  error_message: null,
  created_at: null,
  updated_at: null,
  ...over,
});

const VIDEOS = [
  mk(1),
  mk(2, { status: 'downloading', file_path: null, file_size: null }),
  mk(3, { status: 'failed', error_message: 'Requested 1440p but no stream at or below that height exists.', file_path: null, file_size: null }),
  mk(4, { status: 'unavailable', file_path: null, file_size: null }),
  mk(5, { kind: 'short', is_short: true, duration: 42 }),
  mk(6, { status: 'queued', file_path: null, file_size: null }),
  mk(7),
  mk(8, { channel_id: 'UCbbb' }),
  mk(9),
];

const send = (res, code, body, headers = {}) => {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', ...headers });
  res.end(payload);
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, BASE);
  const p = url.pathname.replace('/api/v1', '');
  if (p === '/health') return send(res, 200, { status: 'ok' });
  if (p === '/server/info')
    return send(res, 200, { api_version: 'v1', server_version: '1.0.0', bind_mode: 'lan', ffmpeg_path: '/data/data/com.termux/files/usr/bin/ffmpeg' });
  if (p === '/videos') {
    let items = [...VIDEOS];
    const w = url.searchParams.get('watched');
    if (w !== null) items = items.filter((v) => String(v.watched) === w);
    const st = url.searchParams.get('status');
    if (st) items = items.filter((v) => v.status === st);
    const k = url.searchParams.get('kind');
    if (k) items = items.filter((v) => v.kind === k);
    return send(res, 200, { items, total: items.length, page: 1, page_size: 24 });
  }
  if (p === '/channels')
    return send(res, 200, [
      { id: 1, channel_id: 'UCaaa', url: 'https://youtube.com/@alpha', title: 'Alpha Channel', enabled: true, quality_override: '720p', last_checked_at: '2026-10-10T04:00:00+00:00', last_uploaded_at: '2026-10-09T18:00:00+00:00' },
      { id: 2, channel_id: 'UCbbb', url: 'https://youtube.com/@beta', title: 'Beta Channel', enabled: false, quality_override: null, last_checked_at: '2026-10-08T04:00:00+00:00', last_uploaded_at: null },
    ]);
  if (p === '/quality/options') return send(res, 200, { options: QUALITY, default: '1080p', per_channel_overrides: { UCaaa: { quality: '720p' } } });
  if (p === '/quality')
    return send(res, 200, {
      quality: '1080p', prefer_mp4: true, embed_subs: false, sub_langs: 'en.*', embed_metadata: true,
      embed_thumbnail: true, write_description: false, download_dir: '/data/data/com.termux/files/home/media',
      max_concurrent_downloads: 2,
    });
  if (p === '/monitor')
    return send(res, 200, { enabled: true, interval_minutes: 15, window_hours: 24, future_only: true, content_filter: 'all' });
  if (p === '/retention') return send(res, 200, { delete_file_when_watched: false, retention_days: null, max_library_items: null });
  if (p === '/storage')
    return send(res, 200, {
      bytes: 41_231_928_960, files: 231, free: 91_000_000_000,
      watched_bytes: 22_020_091_909, unwatched_bytes: 15_432_003_123, orphaned_bytes: 3_779_833_928,
    });
  if (p === '/queue/stats')
    return send(res, 200, { queued: 1, downloading: 1, completed: 128, failed: 3, skipped: 2, unavailable: 5 });
  if (p === '/queue/vid0000002')
    return send(res, 200, { id: 2, video_id: 'vid0000002', channel_id: 'UCaaa', status: 'downloading', quality: '1080p', progress: 42.5, speed: 2_400_000, downloaded_bytes: 420_000_000, total_bytes: 990_000_000, eta: 240, attempts: 1, error_message: null });
  const delOne = /^\/videos\/([^/]+)$/.exec(p);
  if (delOne && req.method === 'DELETE') {
    const v = VIDEOS.find((x) => x.video_id === delOne[1]);
    const delFile = url.searchParams.get('delete_file') !== 'false';
    const dryRun = url.searchParams.get('dry_run') === 'true';
    const files = delFile && v?.file_path ? 1 : 0;
    if (dryRun) return send(res, 200, { deleted: 0, files_deleted: files, files_missing: 0, errors: [] });
    return send(res, 200, { deleted: v ? 1 : 0, files_deleted: files, files_missing: 0, errors: [] });
  }
  if (p === '/videos/bulk-delete' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { video_ids = [], delete_files = true, dry_run = false } = JSON.parse(body || '{}');
      const targets = VIDEOS.filter((v) => video_ids.includes(v.video_id));
      const files = delete_files ? targets.filter((v) => v.file_path).length : 0;
      if (dry_run) return send(res, 200, { deleted: 0, files_deleted: files, files_missing: 0, errors: [] });
      return send(res, 200, { deleted: targets.length, files_deleted: files, files_missing: 0, errors: [] });
    });
    return;
  }
  if (/^\/files\/([^/]+)\/metadata$/.test(p)) {
    return send(res, 200, { video_id: 'vid0000001', filename: 'sample video 1.mp4', size_bytes: 12_345_678, mime_type: 'video/mp4', quality: '1080p', quality_height: 720, duration: 97, modified_at: '2026-10-10T03:00:00+00:00', supports_ranges: true });
  }
  if (/^\/files\/([^/]+)\/stream$/.test(p)) return send(res, 404, { error: { code: 'not_found', message: 'no file' } });
  return send(res, 404, { error: { code: 'not_found', message: `no route ${p}`, details: null } });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* not up yet */
    }
    await sleep(400);
  }
  throw new Error('DevTools target not found');
}

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  });
  const ready = new Promise((resolve) => ws.addEventListener('open', resolve));
  const send = async (method, params = {}) => {
    await ready;
    const msgId = ++id;
    ws.send(JSON.stringify({ id: msgId, method, params }));
    return new Promise((resolve, reject) => pending.set(msgId, { resolve, reject }));
  };
  return { send, close: () => ws.close() };
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ytmon-shot-'));
fs.mkdirSync(path.join(userData, 'userData'), { recursive: true });
fs.writeFileSync(
  path.join(userData, 'userData', 'settings.json'),
  JSON.stringify({ serverUrl: BASE, encryptedToken: null, lastDownloadDir: userData, maxParallelTransfers: 2, pollIntervalMs: 5000, theme: 'dark' }),
);

server.listen(PORT, '127.0.0.1', async () => {
  const electron = spawn(
    'npx',
    ['electron', '.', `--user-data-dir=${path.join(userData, 'userData')}`, '--no-sandbox', `--remote-debugging-port=${CDP_PORT}`],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let out = '';
  electron.stdout.on('data', (d) => (out += d));
  electron.stderr.on('data', (d) => (out += d));

  const cleanup = (code) => {
    try { electron.kill('SIGKILL'); } catch {}
    server.close();
    fs.writeFileSync(path.join(outDir, 'electron.log'), out);
    fs.rmSync(userData, { recursive: true, force: true });
    process.exit(code);
  };

  try {
    const target = await findTarget();
    const cdp = connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 940, deviceScaleFactor: 1, mobile: false });
    await sleep(2500);

    const evaluate = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''));
      return r.result?.value;
    };

    const shoot = async (name) => {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(data, 'base64'));
      console.log(`captured ${name}.png`);
    };

    const clickTab = async (label) => {
      await evaluate(`(() => {
        const btn = [...document.querySelectorAll('[role="tab"]')].find(b => b.textContent.includes(${JSON.stringify(label)}));
        if (!btn) throw new Error('tab not found: ' + ${JSON.stringify(label)});
        btn.click();
        return true;
      })()`);
      await sleep(900);
    };

    const checks = [];
    // Sanity: the app really rendered, not a blank window.
    const title = await evaluate('document.querySelector("h1")?.textContent ?? ""');
    console.log('root heading:', JSON.stringify(title));
    checks.push(['app shell rendered', title === 'Library']);

    await shoot('01-library');

    // Open the player for the first video.
    await evaluate(`(() => {
      const t = document.querySelector('.video-title');
      if (!t) throw new Error('no video title');
      t.click();
      return true;
    })()`);
    await sleep(1200);
    await shoot('02-player');
    await evaluate(`(() => {
      const b = [...document.querySelectorAll('.modal button')].find(b => b.textContent.trim() === '✕');
      if (b) b.click();
      return true;
    })()`);
    await sleep(500);

    // Open the delete dialog to capture the dry-run preview.
    await evaluate(`(() => {
      const btn = [...document.querySelectorAll('.video-actions button')].find(b => b.getAttribute('aria-label')?.startsWith('Delete '));
      if (!btn) throw new Error('no delete button');
      btn.click();
      return true;
    })()`);
    await sleep(1200);
    await shoot('02b-delete-preview');
    const previewOk = await evaluate(`document.body.innerText.includes('Preview (nothing has been deleted yet)')`);
    checks.push(['delete dialog shows a dry-run preview', previewOk === true]);
    await evaluate(`(() => {
      const b = [...document.querySelectorAll('.modal button')].find(b => b.textContent.trim() === '✕');
      if (b) b.click();
      return true;
    })()`);
    await sleep(400);

    await clickTab('Downloads');
    await shoot('03-downloads');

    await clickTab('Channels');
    await shoot('04-channels');
    const channelsOk = await evaluate(`document.body.innerText.includes('Alpha Channel') && document.body.innerText.includes('Override: 720p')`);
    checks.push(['channels render with override', channelsOk === true]);

    await clickTab('Settings');
    await sleep(700);
    await shoot('05-settings');

    const qualityOk = await evaluate(`document.body.innerText.includes('720p') && document.body.innerText.includes('2160p')`);
    checks.push(['settings shows server quality options', qualityOk === true]);

    cdp.close();
    for (const [name, pass] of checks) console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
    const failed = checks.filter(([, p]) => !p).length;
    console.log(failed === 0 ? '\nUI CHECKS OK' : `\nUI CHECKS FAILED: ${failed}`);
    cleanup(failed === 0 ? 0 : 1);
  } catch (e) {
    console.error('SCREENSHOT ERROR', e.message);
    console.error(out.split('\n').slice(-15).join('\n'));
    cleanup(1);
  }
});