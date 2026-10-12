/**
 * Layout diagnostic: launches the real Electron app against a fake server and
 * measures, in the actual renderer, whether each screen's scroll container can
 * actually reach its content.
 *
 * For every screen it reports:
 *   content   — the .content element's clientHeight vs scrollHeight
 *   canScroll — whether the container is scrollable AND actually scrolls
 *   focusable — whether controls below the fold are reachable
 *
 * A screen FAILS when content is taller than the viewport but the container
 * refuses to scroll, because that is exactly "I cannot reach the settings".
 *
 * Run:  node scripts/layout-check.mjs
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Node 20 has no global WebSocket (it is only default from Node 22), and the
// project declares engines.node >=20, so the CDP client uses ws explicitly.
import WebSocket from 'ws';

const root = fileURLToPath(new URL('..', import.meta.url));
const PORT = 8767;
const CDP_PORT = 9600 + (process.pid % 150);
const BASE = `http://127.0.0.1:${PORT}`;

const mk = (i, over = {}) => ({
  id: i,
  video_id: `vid${String(i).padStart(7, '0')}`,
  channel_id: i % 2 === 0 ? 'UCaaa' : 'UCbbb',
  title: `Sample video ${i}`,
  description: null,
  thumbnail_url: null,
  published_at: '2026-10-01T10:00:00+00:00',
  duration: 300,
  is_short: false,
  kind: 'video',
  file_path: '/data/media/x.mp4',
  file_size: 1024 * 1024 * 12,
  quality: '1080p',
  quality_height: 1080,
  watched: false,
  watched_at: null,
  status: 'completed',
  error_message: null,
  created_at: null,
  updated_at: null,
  ...over,
});

// Enough items that a list is genuinely taller than the window.
const VIDEOS = Array.from({ length: 60 }, (_, i) => mk(i + 1));
const CHANNELS = Array.from({ length: 24 }, (_, i) => ({
  id: i + 1,
  channel_id: `UCch${String(i).padStart(19, '0')}`,
  url: `https://www.youtube.com/channel/UCch${i}`,
  title: `Channel number ${i + 1}`,
  enabled: true,
  quality_override: null,
  mode: i % 3 === 0 ? 'manual' : 'auto',
  schedule_enabled: false,
  schedule_days: [],
  schedule_time: null,
  due_now: true,
  next_due: null,
  last_checked_at: '2026-10-10T04:00:00+00:00',
  last_uploaded_at: '2026-10-09T18:00:00+00:00',
  created_at: null,
  updated_at: null,
}));
const SOURCES = Array.from({ length: 20 }, (_, i) => ({
  id: i + 1,
  source_id: `PL${i}`,
  kind: i % 2 === 0 ? 'playlist' : 'watch_later',
  url: 'https://www.youtube.com/playlist?list=PLx',
  title: `Playlist number ${i + 1}`,
  enabled: true,
  quality_override: null,
  last_checked_at: null,
  last_added_at: null,
  created_at: null,
  updated_at: null,
  counts: { total: 40, downloaded: 30, failed: 2 },
}));

const QUALITY = ['144p', '240p', '360p', '480p', '720p', '1080p', '1440p', '2160p', 'best'];

const send = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, BASE);
  const p = url.pathname.replace('/api/v1', '');
  if (p === '/health') return send(res, 200, { status: 'ok' });
  if (p === '/server/info') return send(res, 200, { api_version: 'v1', server_version: '1.0.0', bind_mode: 'lan', ffmpeg_path: '/usr/bin/ffmpeg' });
  if (p === '/videos') return send(res, 200, { items: VIDEOS, total: VIDEOS.length, page: 1, page_size: 60 });
  if (p === '/channels') return send(res, 200, CHANNELS);
  if (p === '/sources') return send(res, 200, SOURCES);
  if (p === '/subscriptions/status') return send(res, 200, { cookies_configured: false, subscriptions: CHANNELS.length });
  if (p === '/videos/pinned') return send(res, 200, []);
  if (p === '/quality/options') return send(res, 200, { options: QUALITY, default: '1080p', per_channel_overrides: {} });
  if (p === '/quality')
    return send(res, 200, {
      quality: '1080p', media_type: 'video', prefer_mp4: true, embed_subs: false, sub_langs: 'en.*',
      embed_metadata: true, embed_thumbnail: true, write_description: false,
      download_dir: '/data/data/com.termux/files/home/media', max_concurrent_downloads: 2,
    });
  if (p === '/monitor')
    return send(res, 200, { enabled: true, interval_minutes: 15, window_hours: 24, future_only: true, content_filter: 'all' });
  if (p === '/retention')
    return send(res, 200, { delete_file_when_watched: false, retention_days: null, max_library_items: null });
  if (p === '/library/layouts')
    return send(res, 200, {
      options: ['channel_id', 'channel_title', 'channel_source', 'flat'],
      descriptions: {}, orders: ['newest', 'oldest', 'title', 'duration'],
    });
  if (p === '/library/settings')
    return send(res, 200, { media_layout: 'channel_id', tree_order: 'newest', retention_days: null, max_library_items: null, delete_file_when_watched: false });
  if (p === '/library/tree') {
    const folders = Array.from({ length: 8 }, (_, i) => ({
      name: `UCch${i}`,
      channel_id: `UCch${i}`,
      channel_title: `Channel ${i}`,
      item_count: 30,
      total_bytes: 5_000_000,
      subfolders: Array.from({ length: 2 }, (_, j) => ({
        name: j === 0 ? 'video' : 'audio',
        source_id: null,
        item_count: 15,
        items: Array.from({ length: 15 }, (_, k) => ({ id: i * 100 + j * 20 + k, title: `Item ${i}-${j}-${k}`, media_type: j === 0 ? 'video' : 'audio', duration: 100, file_size: 1024, pinned: false, watched: false, published_at: '2026-10-01T00:00:00+00:00' })),
      })),
    }));
    return send(res, 200, { folders, total_videos: 240, total_folders: 8, order: 'newest', media_dir: '/data/media' });
  }
  if (p === '/storage') return send(res, 200, { bytes: 41_231_928_960, files: 231, free: 91_000_000_000, watched_bytes: 22_020_091_909, unwatched_bytes: 15_432_003_123, orphaned_bytes: 3_779_833_928 });
  if (p === '/queue/stats') return send(res, 200, { queued: 4, downloading: 1, completed: 128, failed: 3, skipped: 2, unavailable: 5 });
  if (/^\/queue\//.test(p)) {
    const id = p.split('/')[2];
    const v = VIDEOS.find((x) => x.video_id === id) ?? VIDEOS[0];
    return send(res, 200, { ...v, status: 'downloading', progress: 40, speed: 2_400_000, downloaded_bytes: 400, total_bytes: 1000, eta: 60, attempts: 1 });
  }
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

/** Measured entirely inside the real renderer, on the real layout engine. */
const MEASURE = `(() => {
  const el = document.querySelector('.content');
  if (!el) return { error: 'no .content element' };
  const overflowing = [...el.querySelectorAll('*')].filter(
    (n) => n.scrollHeight > n.clientHeight + 2
      && getComputedStyle(n).overflowY !== 'visible'
      && !n.classList.contains('sr-only')
  );

  const controls = [...el.querySelectorAll('button, input, select, textarea')];
  const viewportBottom = el.getBoundingClientRect().bottom;
  // Controls sitting below the visible area BEFORE any scrolling.
  const belowFoldBefore = controls.filter((n) => n.getBoundingClientRect().bottom > viewportBottom + 2).length;

  const before = el.scrollTop;
  el.scrollTop = el.scrollHeight;
  const afterScrollTop = el.scrollTop;
  const reachedBottom = afterScrollTop >= el.scrollHeight - el.clientHeight - 2;
  el.scrollTop = before;

  // The real test: scroll to the end and confirm the last control is on screen.
  el.scrollTop = el.scrollHeight;
  const last = controls[controls.length - 1];
  const lastVisible = last ? last.getBoundingClientRect().bottom <= viewportBottom + 2 : true;
  el.scrollTop = before;

  return {
    viewportHeight: window.innerHeight,
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
    maxScroll: afterScrollTop,
    didScroll: afterScrollTop > 0,
    overflowY: getComputedStyle(el).overflowY,
    // The container must never be taller than the window it lives in.
    tallerThanWindow: el.getBoundingClientRect().height > window.innerHeight + 2,
    reachedBottom,
    lastVisible,
    belowFoldBefore,
    nestedScrollers: overflowing.map((n) => ({
      cls: n.className && n.className.toString().slice(0, 40),
      client: n.clientHeight,
      scroll: n.scrollHeight,
    })),
  };
})()`;

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ytmon-layout-'));
fs.mkdirSync(path.join(userData, 'userData'), { recursive: true });
fs.writeFileSync(
  path.join(userData, 'userData', 'settings.json'),
  JSON.stringify({ serverUrl: BASE, encryptedToken: null, lastDownloadDir: userData, maxParallelTransfers: 2, pollIntervalMs: 5000, theme: 'dark' }),
);

// Route ids, not labels: nav items carry data-route.
const SCREENS = [
  ['library', 'Library'],
  ['browser', 'Files'],
  ['downloads', 'Downloads'],
  ['channels', 'Channels'],
  ['sources', 'Playlists'],
  ['settings', 'Settings'],
];

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
    fs.rmSync(userData, { recursive: true, force: true });
    process.exit(code);
  };

  try {
    const target = await findTarget();
    process.on('exit', () => {
      try { electron.kill('SIGKILL'); } catch {}
    });
    const { send: cdp, close } = connect(target.webSocketDebuggerUrl);
    await cdp('Runtime.enable');
    await cdp('Page.enable');

    // Wait for the shell rather than sleeping a fixed amount: on a loaded
    // machine the app can still be booting when a fixed wait gives up, and the
    // failure then looks like a layout bug when it is not.
    const waitFor = async (expr, label) => {
      for (let i = 0; i < 60; i += 1) {
        const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true });
        if (r.result.value) return true;
        await sleep(400);
      }
      throw new Error(`timed out waiting for ${label}`);
    };
    await waitFor(`!!document.querySelector('.nav-item[data-route="settings"]')`, 'the app shell');

    // Both sizes matter: the reported bug happens worst at the minimum window,
    // and a fix that only works when the window happens to be large is no fix.
    const SIZES = [
      ['at minimum size', 940, 620],
      ['at default size', 1360, 900],
    ];

    let failures = 0;
    for (const [sizeLabel, w, h] of SIZES) {
      // Page-level emulation resizes the viewport the renderer lays out
      // against, which is what the measurements below are about.
      await cdp('Emulation.setDeviceMetricsOverride', {
        width: w, height: h, deviceScaleFactor: 1, mobile: false,
      });
      await sleep(900);

      console.log(`\n--- ${sizeLabel} (${w}x${h}) ---`);
      for (const [label, title] of SCREENS) {
        const clicked = await cdp('Runtime.evaluate', {
          expression: `(() => {
            const b = document.querySelector('.nav-item[data-route=${JSON.stringify(label)}]');
            if (!b) return false;
            b.click();
            return true;
          })()`,
          returnByValue: true,
        });
        if (!clicked.result.value) {
          console.log(`FAIL  ${title} — nav item not found`);
          failures += 1;
          continue;
        }
        // Let the screen render its data before measuring.
        await sleep(900);
        const m = await cdp('Runtime.evaluate', { expression: MEASURE, returnByValue: true });
        const r = m.result.value;
        if (r.error) {
          console.log(`FAIL  ${title} — ${r.error}`);
          failures += 1;
          continue;
        }
        const overflowing = r.scrollHeight > r.clientHeight + 2;
        // Three separate ways this can be broken, all of them "I can't scroll":
        //  1. the container is taller than the window, so body clips it away
        //  2. there IS overflow but it refuses to move
        //  3. it moves but the last control is still off screen
        const problems = [];
        if (r.tallerThanWindow) problems.push('container taller than window (clipped by body)');
        if (overflowing && !r.didScroll) problems.push('overflow present but will not scroll');
        if (overflowing && r.didScroll && !r.reachedBottom) problems.push('cannot scroll to the end');
        if (overflowing && r.didScroll && !r.lastVisible) problems.push('last control unreachable');
        if (problems.length > 0) failures += 1;
        console.log(
          `${problems.length ? 'FAIL ' : 'PASS '}  ${title.padEnd(10)} win=${r.viewportHeight} box=${r.clientHeight} ` +
            `content=${r.scrollHeight} scrolled=${r.maxScroll} hidden=${r.belowFoldBefore}` +
            (problems.length ? `\n        ${problems.join('; ')}` : ''),
        );
        for (const n of r.nestedScrollers) {
          console.log(`        nested scroller: .${n.cls} client=${n.client} scroll=${n.scroll}`);
        }
      }
    }

    await cdp('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
    console.log(failures === 0 ? '\nLAYOUT OK' : `\nLAYOUT PROBLEMS: ${failures}`);
    close();
    if (out.includes('renderer gone')) console.log('NOTE: renderer process died');
    cleanup(failures === 0 ? 0 : 1);
  } catch (e) {
    console.error('LAYOUT ERROR', e.message);
    if (process.env.VERBOSE) console.error(out.slice(-2000));
    cleanup(1);
  }
});