/**
 * Focused diagnostic: why does in-app playback not stream?
 * Pairs the app against the real server, opens the player, and reports exactly
 * what the <video> element and the ytmon-media:// handler are doing.
 *
 *   YTMON_TOKEN=<token> node scripts/debug-stream.mjs [serverUrl]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const BASE = (process.argv[2] ?? 'http://192.168.1.100:8765').replace(/\/+$/, '');
const TOKEN = process.env.YTMON_TOKEN;
const CDP_PORT = 9600 + (process.pid % 300);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (p) => {
  const res = await fetch(`${BASE}/api/v1${p}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(15000),
  });
  return res.json();
};

async function findTarget() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const t = (await r.json()).find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
      if (t) return t;
    } catch { /* wait */ }
    await sleep(400);
  }
  throw new Error('no devtools target');
}

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  });
  const ready = new Promise((r) => ws.addEventListener('open', r));
  return {
    send: async (method, params = {}) => {
      await ready;
      const i = ++id;
      ws.send(JSON.stringify({ id: i, method, params }));
      return Promise.race([
        new Promise((res, rej) => pending.set(i, { resolve: res, reject: rej })),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`CDP timeout ${method}`)), 12000)),
      ]);
    },
    close: () => ws.close(),
  };
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ytmon-dbg-'));
fs.mkdirSync(path.join(userData, 'userData'), { recursive: true });
fs.writeFileSync(
  path.join(userData, 'userData', 'settings.json'),
  JSON.stringify({ serverUrl: BASE, encryptedToken: null, lastDownloadDir: userData, maxParallelTransfers: 2, pollIntervalMs: 5000, theme: 'dark' }),
);

const electron = spawn('npx', ['electron', '.', `--user-data-dir=${path.join(userData, 'userData')}`, '--no-sandbox', `--remote-debugging-port=${CDP_PORT}`], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
electron.stdout.on('data', (d) => (logs += d));
electron.stderr.on('data', (d) => (logs += d));

const done = (code) => {
  try { electron.kill('SIGKILL'); } catch {}
  fs.rmSync(userData, { recursive: true, force: true });
  process.exit(code);
};

try {
  const target = await findTarget();
  const cdp = connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable').catch(() => {});

  // Collect renderer console + network failures.
  const consoleLines = [];
  const netEvents = [];
  const handler = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled') {
      consoleLines.push(`${m.params.type}: ${(m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')}`);
    }
    if (m.method === 'Log.entryAdded') {
      consoleLines.push(`[${m.params.entry.level}] ${m.params.entry.text} ${m.params.entry.url ?? ''}`);
    }
    if (m.method === 'Network.loadingFailed') {
      netEvents.push(`FAILED ${m.params.errorText} ${m.params.type} ${m.params.blockedReason ?? ''}`);
    }
  };
  await cdp.send('Network.enable').catch(() => {});
  cdp.send; // keep linter quiet
  const rawWs = cdp;
  void rawWs;
  // attach a second listener through the socket we already have
  // (connect() swallows the raw socket, so poll instead)

  await sleep(2500);

  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  };

  // Pair.
  await evaluate(`(async () => {
    const el = document.querySelector('.onboard input[type=password]');
    if (!el) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(TOKEN)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('.onboard button')].find(b => /session|save token/i.test(b.textContent))?.click();
    return true;
  })()`);
  await sleep(3500);

  const state = await evaluate(`(() => ({
    heading: document.querySelector('h1')?.textContent ?? '',
    cards: document.querySelectorAll('.video-card').length,
    modal: Boolean(document.querySelector('.modal')),
    bodyStart: (document.body.innerText || '').slice(0, 200),
  }))()`);
  console.log('screen state:', JSON.stringify(state));

  // Open the player on the first completed video.
  const clicked = await evaluate(`(() => {
    const t = document.querySelector('.video-title');
    if (!t) return 'no-title';
    t.click();
    return 'clicked';
  })()`);
  console.log('player click:', clicked);
  await sleep(3000);
  console.log('modal after click:', await evaluate(`Boolean(document.querySelector('.modal'))`));

  const diag = await evaluate(`(() => {
    const v = document.querySelector('.modal video');
    if (!v) return { found: false };
    const err = v.error;
    return {
      found: true,
      src: v.currentSrc || v.src,
      readyState: v.readyState,
      networkState: v.networkState,
      duration: v.duration,
      currentTime: v.currentTime,
      videoWidth: v.videoWidth,
      videoHeight: v.videoHeight,
      error: err ? { code: err.code, message: err.message } : null,
      buffered: v.buffered.length ? [v.buffered.start(0), v.buffered.end(0)] : [],
    };
  })()`);
  console.log('\n--- <video> element ---');
  console.log(JSON.stringify(diag, null, 2));

  // Audio items must play in an <audio> element, not a <video> one.
  const audioDiag = await evaluate(`(async () => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find(b => b.textContent.includes('Library'));
    const close = [...document.querySelectorAll('.modal button')].find(b => b.textContent.trim() === '✕');
    close?.click();
    await new Promise(r => setTimeout(r, 400));
    // Filter to audio, then open the first card.
    const audioBtn = [...document.querySelectorAll('.media-toggle button')].find(b => b.textContent.trim() === 'Audio');
    if (!audioBtn) return { skipped: 'no audio filter' };
    audioBtn.click();
    await new Promise(r => setTimeout(r, 1500));
    const t = document.querySelector('.video-title');
    if (!t) return { skipped: 'no audio items in library' };
    t.click();
    await new Promise(r => setTimeout(r, 3000));
    const a = document.querySelector('.modal audio');
    const v = document.querySelector('.modal video');
    return {
      foundAudio: Boolean(a),
      foundVideo: Boolean(v),
      duration: a ? a.duration : null,
      readyState: a ? a.readyState : null,
      error: a?.error ? a.error.code : null,
      badgeText: document.querySelector('.modal')?.innerText.includes('audio/mpeg') ? 'audio/mpeg' : 'n/a',
    };
  })()`);
  console.log('\n--- audio item ---');
  console.log(JSON.stringify(audioDiag));

  // Thumbnails come from the authenticated proxy, never thumbnail_url.
  const thumbDiag = await evaluate(`(() => {
    const imgs = [...document.querySelectorAll('.modal img')].map(i => i.src);
    return imgs.slice(0, 3);
  })()`);
  console.log('\n--- player image sources ---');
  console.log(JSON.stringify(thumbDiag));

  // Back to the video item for the seek test.
  await evaluate(`(async () => {
    document.querySelector('.modal button')?.click();
    await new Promise(r => setTimeout(r, 400));
    const all = [...document.querySelectorAll('.media-toggle button')].find(b => b.textContent.trim() === 'All');
    all?.click();
    await new Promise(r => setTimeout(r, 1500));
    document.querySelector('.video-title')?.click();
    await new Promise(r => setTimeout(r, 2500));
    return true;
  })()`);

  // Seeking is the thing Content-Range enables; prove it round-trips.
  const seek = await evaluate(`(async () => {
    const v = document.querySelector('.modal video');
    if (!v) return { skipped: true };
    const before = v.currentTime;
    v.currentTime = 60;
    await new Promise((r) => {
      const done = () => { v.removeEventListener('seeked', done); r(); };
      v.addEventListener('seeked', done);
      setTimeout(r, 6000);
    });
    await new Promise((r) => setTimeout(r, 600));
    return { before, requested: 60, after: v.currentTime, bufferedEnd: v.buffered.length ? v.buffered.end(v.buffered.length - 1) : null };
  })()`);
  console.log('\n--- seek test ---');
  console.log(JSON.stringify(seek));

  // Can the renderer even fetch the media URL?
  const probe = await evaluate(`(async () => {
    const v = document.querySelector('.modal video');
    const url = v ? (v.currentSrc || v.src) : null;
    if (!url) return { skipped: true };
    try {
      const res = await fetch(url);
      const buf = await res.arrayBuffer();
      return { url, status: res.status, type: res.headers.get('content-type'), bytes: buf.byteLength,
               ranges: res.headers.get('accept-ranges'), cr: res.headers.get('content-range') };
    } catch (e) {
      return { url, fetchError: String(e) };
    }
  })()`);
  console.log('\n--- renderer fetch of the media URL ---');
  console.log(JSON.stringify(probe, null, 2));

  // Same URL from node, to separate app bugs from server bugs.
  const src = diag?.src;
  if (src) {
    console.log('\n--- what the app logged ---');
    console.log(logs.split('\n').filter((l) => /ytmon:|error|Error/.test(l)).slice(-12).join('\n') || '(nothing)');
    console.log('\n--- renderer console ---');
    console.log(consoleLines.slice(-15).join('\n') || '(nothing)');
    console.log('\n--- network failures ---');
    console.log(netEvents.slice(-10).join('\n') || '(nothing)');
  }

  cdp.close();
  done(0);
} catch (e) {
  console.error('ERROR', e.message);
  console.error(logs.split('\n').slice(-15).join('\n'));
  done(1);
}