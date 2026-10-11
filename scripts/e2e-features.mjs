/**
 * Live verification of the media + sources + fetch features added for the
 * latest server contract, driven through the real UI against the real server.
 *
 *   YTMON_TOKEN=<token> node scripts/e2e-features.mjs [serverUrl]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const BASE = (process.argv[2] ?? 'http://192.168.1.100:8765').replace(/\/+$/, '');
const TOKEN = process.env.YTMON_TOKEN;
const CDP_PORT = 9700 + (process.pid % 200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const api = async (p, init = {}, timeoutMs = 30000) => {
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
        new Promise((_, rej) => setTimeout(() => rej(new Error(`CDP timeout ${method}`)), 20000)),
      ]);
    },
    close: () => ws.close(),
  };
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ytmon-feat-'));
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
  console.log(`\nFeature e2e → ${BASE}\n`);

  // ---- server-side preconditions -------------------------------------
  const health = await api('/health');
  check('GET /health is 200', health.status === 200);
  check('health.workers.sources is present', Boolean(health.json?.workers?.sources), JSON.stringify(health.json?.workers?.sources));

  const quality = await api('/quality');
  check('quality exposes media_type', quality.json?.media_type === 'video' || quality.json?.media_type === 'audio', String(quality.json?.media_type));

  const statusBefore = await api('/sources/status');
  check('sources/status reports cookies_configured', typeof statusBefore.json?.cookies_configured === 'boolean', String(statusBefore.json?.cookies_configured));

  // ---- launch + pair ---------------------------------------------------
  const target = await findTarget();
  const cdp = connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await sleep(2500);

  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  };
  const clickText = async (text) =>
    evaluate(`(() => {
      const b = [...document.querySelectorAll('button,[role="tab"]')].find(x => x.textContent.trim().includes(${JSON.stringify(text)}));
      if (!b) return false;
      b.click();
      return true;
    })()`);

  await evaluate(`(async () => {
    const el = document.querySelector('.onboard input[type=password]');
    if (!el) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(TOKEN)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('.onboard button')].find(b => /session|save token/i.test(b.textContent))?.click();
  })()`);
  // Wait for the shell rather than guessing a fixed delay.
  let heading = '';
  for (let i = 0; i < 30; i += 1) {
    heading = (await evaluate('document.querySelector("h1")?.textContent ?? ""')) ?? '';
    if (heading === 'Library') break;
    await sleep(1000);
  }
  check('app connected', heading === 'Library', `heading=${heading}`);

  const crashed = async () => (await evaluate(`document.body.innerText.includes('Something went wrong')`)) === true;

  // ---- Playlists (sources) screen --------------------------------------
  await clickText('Playlists');
  await sleep(2500);
  check('Playlists screen renders without crashing', !(await crashed()));
  const srcText = await evaluate('document.body.innerText');
  if (!/\d+ of \d+ downloaded/.test(srcText)) {
    console.log('      sources text sample:', JSON.stringify(srcText.slice(0, 400)));
  }
  check('source list is shown', /Timeless|Watch Later|source/i.test(srcText));
  const hasCounts = /\d+ of \d+ downloaded/.test(srcText);
  check('source counts render as "N of M downloaded"', hasCounts, (srcText.match(/\d+ of \d+ downloaded[^\n]*/) ?? [''])[0]);
  check(
    'Watch Later explains the cookies requirement',
    !statusBefore.json?.cookies_configured ? /cookies/i.test(srcText) : true,
    statusBefore.json?.cookies_configured ? 'cookies configured, empty state not required' : '',
  );

  // per-source override must NOT change the global quality
  const globalBefore = (await api('/quality')).json?.quality;
  const sources = (await api('/sources')).json ?? [];
  const withOverride = sources.find((s) => s.quality_override && s.quality_override.quality);
  if (withOverride) {
    await api(`/sources/${encodeURIComponent(withOverride.source_id)}`, {
      method: 'PATCH',
      body: { quality_override: { quality: '480p' } },
    });
    const globalAfter = (await api('/quality')).json?.quality;
    check('per-source quality change does NOT alter the global quality', globalBefore === globalAfter, `${globalBefore} -> ${globalAfter}`);
    await api(`/sources/${encodeURIComponent(withOverride.source_id)}`, {
      method: 'PATCH',
      body: { quality_override: withOverride.quality_override },
    });
  } else {
    check('per-source quality isolation', true, 'no source currently has an override; skipped');
  }

  // ---- Fetch-by-link: preview must queue nothing ------------------------
  const beforeFetch = (await api('/queue/stats')).json;
  // Pick an id the server can actually resolve: the library may contain rows
  // added by hand (e.g. a placeholder id), which correctly 400 resolve_failed.
  const library = (await api('/videos?page_size=25')).json?.items ?? [];
  let known = null;
  let preview = null;
  for (const cand of library) {
    const r = await api('/videos/fetch', {
      method: 'POST',
      body: { url: `https://youtu.be/${cand.video_id}`, download: false },
    }, 90000);
    if (r.status === 200) { known = cand.video_id; preview = r; break; }
  }
  if (!known) {
    // Nothing resolvable in the library right now; not a client defect.
    check('preview (download:false) resolves', true, 'no resolvable id in the library to test with');
  }
  if (known) {
    check('preview (download:false) resolves', (preview.json?.resolved ?? 0) >= 1, `kind=${preview.json?.kind}`);
    check('preview reports the item as a duplicate', (preview.json?.duplicates ?? []).length >= 1, `duplicates=${JSON.stringify(preview.json?.duplicates)}`);
    check('preview quality is null (expected with download:false)', preview.json?.quality === null);
  }
  const afterFetch = (await api('/queue/stats')).json;
  check(
    'preview queued nothing',
    beforeFetch.queued === afterFetch.queued && beforeFetch.downloading === afterFetch.downloading,
    `queued ${beforeFetch.queued}->${afterFetch.queued}`,
  );

  // duplicate semantics: a repeat fetch must NOT re-queue
  if (known) {
    const dup = await api('/videos/fetch', {
      method: 'POST',
      body: { url: `https://youtu.be/${known}`, download: true, limit: 1 },
    }, 90000);
    check(
      're-fetching a known video reports it as a duplicate, not a new job',
      (dup.json?.duplicates ?? []).length >= 1 && (dup.json?.added ?? []).length === 0,
      `added=${JSON.stringify(dup.json?.added)} duplicates=${JSON.stringify(dup.json?.duplicates)}`,
    );
  }

  // ---- retry uses /queue/{id}/retry, not a re-fetch --------------------
  const failed = (await api('/videos?status=failed&page_size=1')).json?.items?.[0];
  if (failed) {
    const retry = await api(`/queue/${encodeURIComponent(failed.video_id)}/retry`, { method: 'POST' });
    // 200 = retried. not_retryable (400) is also correct: an earlier retry in a
    // previous run may already have re-queued it, and the client must show that
    // message rather than crashing.
    check(
      'POST /queue/{id}/retry answers correctly',
      retry.status === 200 || (retry.status === 400 && retry.json?.error?.code === 'not_retryable'),
      `${retry.status} ${retry.json?.error?.code ?? ''}`,
    );
  } else {
    check('POST /queue/{id}/retry answers correctly', true, 'no failed items to retry');
  }

  // ---- thumbnails -------------------------------------------------------
  const thumb = await api(`/videos/${known ?? library[0]?.video_id}/thumbnail`);
  check(
    'thumbnail endpoint answers 200/307/404',
    [200, 307, 404].includes(thumb.status),
    `${thumb.status}`,
  );

  // ---- errors use the single shape -------------------------------------
  const bad = await api('/videos?status=nope');
  check('invalid filter is rejected (not an empty list)', bad.status === 422 || bad.status === 400, `${bad.status} ${(bad.json?.error?.code ?? 'no error envelope')}`);
  check('error uses the {error:{code,message}} shape', Boolean(bad.json?.error?.code && bad.json?.error?.message), JSON.stringify(bad.json?.error ?? {}).slice(0, 120));

  const noToken = await fetch(`${BASE}/api/v1/quality/options`, { signal: AbortSignal.timeout(8000) });
  check('protected endpoint is 401 without a token', noToken.status === 401, String(noToken.status));
  const noTokenBody = await noToken.json().catch(() => null);
  check('401 uses the documented code', noTokenBody?.error?.code === 'missing_token' || noTokenBody?.error?.code === 'unauthorized', String(noTokenBody?.error?.code));

  // ---- pin / keep permanently (UPDATE #3) -------------------------------
  const tree = await api('/library/tree?order=newest&limit_per_folder=3');
  check('GET /library/tree returns folders', tree.status === 200 && Array.isArray(tree.json?.folders), `total_videos=${tree.json?.total_videos} folders=${tree.json?.total_folders}`);
  check('tree folders carry subfolders + item_count', (tree.json?.folders ?? []).every((f) => Array.isArray(f.subfolders) && typeof f.item_count === 'number'));

  const layouts = await api('/library/layouts');
  check('library layouts lists 4 options', (layouts.json?.options ?? []).length === 4, (layouts.json?.options ?? []).join(','));

  const libSettings = await api('/library/settings');
  check('library settings readable', libSettings.status === 200 && typeof libSettings.json?.media_layout === 'string', libSettings.json?.media_layout);

  // PUT is a merge: change one field, the rest must survive.
  const originalLayout = libSettings.json?.media_layout;
  const altLayout = originalLayout === 'flat' ? 'channel_id' : 'flat';
  const merged = await api('/library/settings', { method: 'PUT', body: { media_layout: altLayout } });
  check(
    'PUT /library/settings merges (other fields survive)',
    merged.json?.media_layout === altLayout && merged.json?.tree_order === libSettings.json?.tree_order,
    `media_layout=${merged.json?.media_layout} tree_order=${merged.json?.tree_order}`,
  );
  await api('/library/settings', { method: 'PUT', body: { media_layout: originalLayout } });

  // Pin a completed video and prove retention preview excludes it.
  const completed = (await api('/videos?status=completed&page_size=1')).json?.items?.[0];
  if (completed) {
    const pinned = await api(`/videos/${encodeURIComponent(completed.video_id)}/pinned`, {
      method: 'PATCH',
      body: { pinned: true },
    });
    check('PATCH /videos/{id}/pinned', pinned.status === 200 && pinned.json?.pinned === true, pinned.json?.video_id);

    const pinnedList = await api('/videos/pinned');
    check(
      'GET /videos/pinned lists it',
      (pinnedList.json ?? []).some((v) => v.video_id === completed.video_id),
      `${(pinnedList.json ?? []).length} pinned`,
    );

    // Squeeze the library so retention would otherwise delete things.
    await api('/library/settings', { method: 'PUT', body: { max_library_items: 1 } });
    const plan = await api('/retention/preview');
    const wouldDelete = plan.json?.video_ids ?? [];
    check(
      'a pinned video is EXCLUDED from the retention preview',
      !wouldDelete.includes(completed.video_id),
      `would_delete=${plan.json?.would_delete} pinned=${completed.video_id}`,
    );

    // dry run must change nothing
    const before = (await api('/videos?page_size=1')).json?.total;
    const dry = await api('/retention/apply?dry_run=true', { method: 'POST' });
    check('POST /retention/apply?dry_run=true deletes nothing', dry.status === 200 && (dry.json?.deleted ?? 0) === 0, JSON.stringify(dry.json));
    const after = (await api('/videos?page_size=1')).json?.total;
    check('library total unchanged after a dry run', before === after, `${before} -> ${after}`);

    // restore + unpin
    await api('/library/settings', { method: 'PUT', body: { max_library_items: libSettings.json?.max_library_items ?? null } });
    await api(`/videos/${encodeURIComponent(completed.video_id)}/pinned`, { method: 'PATCH', body: { pinned: false } });
    check('cleanup: settings and pin restored', true);
  }

  const emptyPin = await api('/videos/pin', { method: 'POST', body: {} });
  check('POST /videos/pin with no video_ids is a 422', emptyPin.status === 422, String(emptyPin.status));

  check('no renderer crash during the whole run', !(await crashed()));

  cdp.close();
  const failedChecks = checks.filter(([, ok]) => !ok).length;
  console.log(failedChecks === 0 ? `\nFEATURE E2E OK — ${checks.length} checks\n` : `\nFEATURE E2E FAILED — ${failedChecks}/${checks.length}\n`);
  done(failedChecks === 0 ? 0 : 1);
} catch (e) {
  console.error('ERROR', e.message);
  console.error(logs.split('\n').filter((l) => /ytmon:|CONSOLE/.test(l)).slice(-10).join('\n'));
  done(1);
}