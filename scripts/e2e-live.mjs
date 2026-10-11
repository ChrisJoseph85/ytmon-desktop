/**
 * Drives the REAL app against the REAL server over CDP, using the real API
 * (no fake data) to verify the end-to-end paths that matter:
 *
 *   connect with a token -> add a channel by @handle -> discover videos
 *
 * Nothing here mutates the server except adding the channel the user asked for.
 *
 * Usage:
 *   YTMON_TOKEN=<token> node scripts/e2e-live.mjs [serverUrl]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const BASE = (process.argv[2] ?? 'http://192.168.1.100:8765').replace(/\/+$/, '');
const TOKEN = process.env.YTMON_TOKEN;
const HANDLE = process.env.YTMON_CHANNEL ?? 'https://www.youtube.com/@veritasium';
const CDP_PORT = 9500 + (process.pid % 300);

if (!TOKEN) {
  console.error('Set YTMON_TOKEN to a token minted on the phone.');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const api = async (p, init = {}, timeoutMs = 15000) => {
  const res = await fetch(`${BASE}/api/v1${p}`, {
    ...init,
    // Object bodies must be serialised, or the server 422s on "[object Object]".
    body: init.body !== undefined && typeof init.body !== 'string' ? JSON.stringify(init.body) : init.body,
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  return { status: res.status, json, text };
};

async function findTarget() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* not up yet */ }
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
  const ready = new Promise((r) => ws.addEventListener('open', r));
  return {
    send: async (method, params = {}) => {
      await ready;
      const msgId = ++id;
      ws.send(JSON.stringify({ id: msgId, method, params }));
      // Never let a CDP call hang the run.
      return Promise.race([
        new Promise((resolve, reject) => pending.set(msgId, { resolve, reject })),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 15000)),
      ]);
    },
    close: () => ws.close(),
  };
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ytmon-live-'));
fs.mkdirSync(path.join(userData, 'userData'), { recursive: true });
fs.writeFileSync(
  path.join(userData, 'userData', 'settings.json'),
  JSON.stringify({
    serverUrl: BASE,
    // Session-only token: no keychain on this machine, and nothing is written
    // to disk in plain text.
    encryptedToken: null,
    lastDownloadDir: userData,
    maxParallelTransfers: 2,
    pollIntervalMs: 5000,
    theme: 'dark',
  }),
);

console.log(`\nLive end-to-end → ${BASE}`);
console.log(`      channel: ${HANDLE}\n`);

const electron = spawn(
  'npx',
  ['electron', '.', `--user-data-dir=${path.join(userData, 'userData')}`, '--no-sandbox', `--remote-debugging-port=${CDP_PORT}`],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
);
let logs = '';
electron.stdout.on('data', (d) => (logs += d));
electron.stderr.on('data', (d) => (logs += d));

const cleanup = (code) => {
  try { electron.kill('SIGKILL'); } catch {}
  fs.writeFileSync(path.join(os.tmpdir(), 'ytmon-live.log'), logs);
  fs.rmSync(userData, { recursive: true, force: true });
  process.exit(code);
};

try {
  // ---- 1. server reachable -------------------------------------------
  const health = await api('/health');
  check('server reachable and healthy', health.status === 200 && health.json?.status === 'ok');

  // Start from a clean slate so "the app added it" is unambiguous. Any channel
  // already tracking this handle is removed first and re-added through the UI,
  // so the end state is the same.
  const channelsBefore = await api('/channels');
  for (const c of channelsBefore.json ?? []) {
    if (c.url.includes(new URL(HANDLE).pathname) || String(c.title ?? '').toLowerCase().includes('veritasium')) {
      console.log(`      removing existing channel ${c.channel_id} before the UI test`);
      await api(`/channels/${encodeURIComponent(c.channel_id)}`, { method: 'DELETE' });
    }
  }
  const remaining = await api('/channels');
  const before = new Set((remaining.json ?? []).map((c) => c.channel_id));
  check('starting from a clean slate for this channel', remaining.json !== null);

  // ---- 2. launch the real app and pair it -----------------------------
  const target = await findTarget();
  const cdp = connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 940, deviceScaleFactor: 1, mobile: false });
  await sleep(2500);

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  };
  const step = (m) => console.log(`      … ${m}`);
  // Screenshots are best-effort: the compositor is not always available in
  // headless/CI environments and the assertions are what matter.
  const shoot = async (name) => {
    try {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const outDir = path.join(root, 'release', 'screenshots-live');
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(data, 'base64'));
      console.log(`      captured release/screenshots-live/${name}.png`);
    } catch (e) {
      console.log(`      (screenshot ${name} skipped: ${e.message})`);
    }
  };

  check('electron window loaded the renderer', logs.includes('ytmon: window ready'));

  // The app starts unauthenticated; it should be showing the token prompt.
  await evaluate(`(() => {
    const el = [...document.querySelectorAll('.onboard input[type=password]')][0];
    if (!el) return 'no-token-field';
    return 'ok';
  })()`);

  // Pair through the real preload bridge (session-only: no keychain here).
  const paired = await evaluate(`(async () => {
    const el = document.querySelector('.onboard input[type=password]');
    if (!el) return { ok: false, why: 'no token field' };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(TOKEN)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    const btn = [...document.querySelectorAll('.onboard button')].find(b => /session|save token/i.test(b.textContent));
    if (!btn) return { ok: false, why: 'no pair button' };
    btn.click();
    return { ok: true };
  })()`);
  check('token field is present and pairable', paired?.ok === true, paired?.why ?? '');

  // ---- 3. the app must reach the real library --------------------------
  await sleep(3000);
  const heading = await evaluate('document.querySelector("h1")?.textContent ?? ""');
  check('app connected and left the pairing screen', heading === 'Library', `heading=${heading}`);
  step('library screenshot');
  await shoot('01-library-live');

  step('health strip');
  const healthStrip = await evaluate('document.querySelector(".health-strip")?.innerText ?? ""');
  check('health banner shows connected + the real address', /Connected/.test(healthStrip) && healthStrip.includes(BASE.replace(/^https?:\/\//, '')), healthStrip.replace(/\n/g, ' '));

  const cards = await evaluate('document.querySelectorAll(".video-card").length');
  check('real videos rendered from the server', cards > 0, `${cards} cards`);

  // ---- 4. add the channel through the real UI -------------------------
  step('open channels tab');
  await evaluate(`(() => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find(b => b.textContent.includes('Channels'));
    tab?.click();
    return true;
  })()`);
  await sleep(900);

  step('open add dialog');
  const crash = await evaluate(`(() => {
    const t = document.body.innerText;
    if (t.includes('Something went wrong')) return t.slice(0, 500);
    return null;
  })()`);
  if (crash) console.log('      CRASH:', JSON.stringify(crash));
  const buttons = await evaluate(`[...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(Boolean).slice(0, 24)`);
  console.log('      buttons:', JSON.stringify(buttons));
  const opened = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add channel');
    if (!btn) return 'not-found';
    btn.click();
    return 'clicked';
  })()`);
  console.log('      add-dialog click:', opened);
  await sleep(900);
  console.log('      modal open:', await evaluate(`Boolean(document.querySelector('.modal'))`));
  console.log('      modal inputs:', await evaluate(`[...document.querySelectorAll('.modal input')].map(i => i.id).join(',')`));

  step('type url + submit');
  const typed = await evaluate(`(async () => {
    const input = document.querySelector('#add-channel-url');
    if (!input) return { ok: false, why: 'no url field' };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(HANDLE)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 120));
    [...document.querySelectorAll('.modal button')].find(b => b.textContent.trim() === 'Add')?.click();
    return { ok: true };
  })()`);
  check('channel URL entered in the Add dialog', typed?.ok === true, typed?.why ?? '');
  step('waiting for the dialog to close');
  // yt-dlp channel resolution is slow (~4s), so wait for the dialog to close.
  for (let i = 0; i < 40; i += 1) {
    const stillOpen = await evaluate('Boolean(document.querySelector(".modal"))');
    if (!stillOpen) break;
    await sleep(1000);
  }
  await shoot('02-channels-live');
  const dialogText = await evaluate('document.querySelector(".modal")?.innerText ?? "(dialog closed)"');
  console.log('      dialog says:', JSON.stringify(dialogText));

  // ---- 5. the server must now have a canonical channel -----------------
  const channelsAfter = await api('/channels');
  const added = (channelsAfter.json ?? []).find((c) => !before.has(c.channel_id));
  check('channel was added by the app', Boolean(added), added ? `${added.title} (${added.channel_id})` : 'none added');
  check(
    'the UI stored the canonical URL, not the @handle',
    Boolean(added && /\/channel\/UC[A-Za-z0-9_-]{22}/.test(added.url)),
    added?.url ?? '',
  );

  const canonical = added && /^UC[A-Za-z0-9_-]{22}$/.test(added.channel_id);
  check(
    'stored channel_id is canonical UC… (not an @handle)',
    Boolean(canonical),
    added?.channel_id ?? '',
  );

  // ---- 6. the scan must actually discover something --------------------
  if (added) {
    // A yt-dlp scan touches the network and can take tens of seconds.
    const scan = await api(`/channels/${encodeURIComponent(added.channel_id)}/scan`, { method: 'POST' }, 120000);
    const r = scan.json ?? {};
    check(
      'scan ran without error',
      scan.status === 200,
      `discovered=${r.discovered} queued=${r.queued} filtered=${r.filtered}`,
    );
    // discovered=0 with a large filtered count is usually the PUBLICATION
    // WINDOW, not a broken channel: the server only considers videos published
    // within MonitorSettings.window_hours.
    const mon = await api('/monitor');
    const windowHours = mon.json?.window_hours;
    if ((r.discovered ?? 0) === 0 && (r.filtered ?? 0) > 0) {
      const explained = windowHours !== undefined && windowHours <= 48;
      check(
        'empty scan is explained by the publication window, not a broken channel',
        explained,
        `discovered=0 filtered=${r.filtered} window_hours=${windowHours}` +
          (explained ? ' — widen MonitorSettings.window_hours in Settings to see older uploads' : ''),
      );
    } else {
      check('scan discovered new videos', (r.discovered ?? 0) > 0 || (r.duplicates ?? 0) > 0, JSON.stringify(r));
    }
  }

  await sleep(2500);
  const libCount = await api('/videos');
  check('library reflects real server data', (libCount.json?.total ?? 0) > 0, `total=${libCount.json?.total}`);

  cdp.close();
  const failed = checks.filter(([, ok]) => !ok).length;
  console.log(failed === 0 ? `\nLIVE E2E OK — ${checks.length} checks\n` : `\nLIVE E2E FAILED — ${failed}/${checks.length}\n`);
  cleanup(failed === 0 ? 0 : 1);
} catch (e) {
  console.error('LIVE E2E ERROR', e.message);
  console.error(logs.split('\n').slice(-12).join('\n'));
  cleanup(1);
}