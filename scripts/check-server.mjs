/**
 * Diagnostic against the REAL server on the LAN.
 *
 * Usage:
 *   node scripts/check-server.mjs [http://192.168.1.100:8765] [token]
 *
 * Explains *why* the desktop cannot reach the phone, using the checks from the
 * handoff brief, rather than guessing.
 */
import net from 'node:net';
import { execFile } from 'node:child_process';
import { URL } from 'node:url';

const BASE = (process.argv[2] ?? 'http://192.168.1.100:8765').replace(/\/+$/, '');
const TOKEN = process.argv[3] ?? process.env.YTMON_TOKEN ?? '';

const url = new URL(BASE);
const host = url.hostname;
const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(host);

const ok = (m) => console.log(`PASS  ${m}`);
const warn = (m) => console.log(`WARN  ${m}`);
const bad = (m) => console.log(`FAIL  ${m}`);
const info = (m) => console.log(`      ${m}`);

console.log(`\nYTMon server check → ${BASE}`);
console.log(`      host ${host} · port ${port} · ${isLoopback ? 'loopback (trusted)' : 'LAN (token required)'}\n`);

// 1. DNS / reachability of the host itself.
const tcpResult = await new Promise((resolve) => {
  const socket = net.connect({ host, port, timeout: 4000 });
  socket.on('connect', () => {
    socket.destroy();
    resolve({ ok: true });
  });
  socket.on('timeout', () => {
    socket.destroy();
    resolve({ ok: false, reason: 'timeout' });
  });
  socket.on('error', (e) => resolve({ ok: false, reason: e.code ?? e.message }));
});

if (!tcpResult.ok) {
  bad(`TCP connect to ${host}:${port} failed — ${tcpResult.reason}`);

  // Distinguish "phone is off the network" from "server bound to loopback".
  // They look identical to a client but need completely different fixes.
  const icmp = await new Promise((resolve) => {
    execFile('ping', ['-c', '2', '-W', '2', host], { timeout: 9000 }, (err) => resolve(!err));
  }).catch(() => false);

  info('');
  if (tcpResult.reason === 'timeout' && !icmp) {
    warn(`The phone does not answer ping either — it is OFF the network, not a server problem.`);
    info('');
    info('Check, in order:');
    info('  1. Is the phone awake and unlocked? (Doze kills Wi-Fi in Doze)');
    info('  2. Is it still on THIS Wi-Fi network? Check with: ./scripts/lan-address.sh');
    info('  3. Did the DHCP lease change the IP? The address is a user setting for a reason.');
    info('  4. Was the router restarted or did the phone drop off it?');
    info('');
    info('This is a network/phone issue — the client is behaving correctly.');
    process.exit(1);
  }

  info('This is NOT an app bug. The phone is answering on the network but nothing');
  info('is accepting connections on that port. Check on the phone, in order:');
  info('  1. Is the server running?  ./run.sh  (or uvicorn ... in Termux)');
  info('  2. Is LAN mode enabled? By default it binds 127.0.0.1 only, and a LAN');
  info('     client then gets exactly this "connection refused" response.');
  info('  3. Is the port right? Print it with: ./scripts/lan-address.sh');
  info('  4. Has the phone\'s IP changed? It changes when it joins a new network.');
  info('  5. Router AP/client isolation, or a guest network, will also do this.');
  process.exit(1);
}
ok(`TCP connect to ${host}:${port} succeeded`);

const call = async (p, { auth = true, method = 'GET', body } = {}) => {
  const headers = { Accept: 'application/json' };
  if (body) headers['content-type'] = 'application/json';
  if (auth && TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;
  const res = await fetch(`${BASE}/api/v1${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, json, raw: text };
};

// 2. Health is always public.
try {
  const health = await call('/health', { auth: false });
  if (health.status === 200) {
    ok(`GET /health → 200 {"status":"${health.json?.status ?? '?'}"}`);
  } else {
    bad(`GET /health → ${health.status} ${health.json?.error?.message ?? health.raw.slice(0, 120)}`);
  }
} catch (e) {
  bad(`GET /health failed: ${e.message}`);
}

// 3. Server info (always public) — surfaces bind mode.
try {
  const infoRes = await call('/server/info', { auth: false });
  if (infoRes.status === 200) {
    ok('GET /server/info → 200');
    for (const k of ['api_version', 'server_version', 'bind_mode', 'ffmpeg_path']) {
      if (infoRes.json?.[k] !== undefined) info(`${k}: ${infoRes.json[k]}`);
    }
    const bind = String(infoRes.json?.bind_mode ?? '');
    if (bind && bind !== 'lan' && !isLoopback) {
      warn(`Server bind mode is "${bind}" but you are connecting over LAN.`);
      info('Enable LAN mode on the phone, or use 127.0.0.1 from the phone itself.');
    }
  } else {
    warn(`GET /server/info → ${infoRes.status}`);
  }
} catch (e) {
  warn(`GET /server/info failed: ${e.message}`);
}

// 4. A protected endpoint tells us whether the token works.
try {
  const quality = await call('/quality/options');
  if (quality.status === 200) {
    const opts = quality.json?.options ?? [];
    ok(`GET /quality/options → ${opts.length} options`);
    info(opts.join(' '));
    info(`server default: ${quality.json?.default}`);
    if (opts.length !== 9) warn(`Expected 9 quality options, server reported ${opts.length}.`);
  } else if (quality.status === 401 || quality.status === 403) {
    bad(`GET /quality/options → ${quality.status} ${quality.json?.error?.message ?? ''}`);
    info(isLoopback
      ? 'On loopback this should not happen unless LAN mode is on and no token was sent.'
      : 'LAN mode is on and the token is missing or invalid.');
    info('Mint a token ON THE PHONE: http://127.0.0.1:8765/docs → POST /tokens');
    info('Then run: node scripts/check-server.mjs ' + BASE + ' <token>');
  } else {
    warn(`GET /quality/options → ${quality.status} ${quality.json?.error?.message ?? ''}`);
  }
} catch (e) {
  warn(`GET /quality/options failed: ${e.message}`);
}

// 5. If we have a token, confirm destructive endpoints are actually guarded.
if (TOKEN) {
  try {
    const stats = await call('/queue/stats');
    if (stats.status === 200) {
      const s = stats.json ?? {};
      ok(`GET /queue/stats → ${stats.status}`, `queued=${s.queued} downloading=${s.downloading} completed=${s.completed} failed=${s.failed} skipped=${s.skipped} unavailable=${s.unavailable}`);
      const missing = ['queued', 'downloading', 'completed', 'failed', 'skipped', 'unavailable'].filter((k) => !(k in s));
      if (missing.length) warn(`QueueStats is missing documented keys: ${missing.join(', ')}`);
      if ('discovered' in s) warn('QueueStats contains "discovered", which the contract says it must not.');
    } else {
      warn(`GET /queue/stats → ${stats.status}`);
    }
  } catch (e) {
    warn(`GET /queue/stats failed: ${e.message}`);
  }

  try {
    const videos = await call('/videos?page_size=1');
    if (videos.status === 200) {
      ok(`GET /videos → total ${videos.json?.total}`);
      const first = videos.json?.items?.[0];
      if (first) {
        const missing = ['video_id', 'channel_id', 'title', 'kind', 'status', 'watched', 'quality_height', 'file_path']
          .filter((k) => !(k in first));
        if (missing.length) bad(`Video model is missing documented fields: ${missing.join(', ')}`);
        else ok('Video model matches the documented field set');
        info(`status enum in use: ${[...new Set((videos.json.items ?? []).map((v) => v.status))].join(', ')}`);
      }
    } else {
      warn(`GET /videos → ${videos.status}`);
    }
  } catch (e) {
    warn(`GET /videos failed: ${e.message}`);
  }

  // Range support on a real file, if one is completed.
  try {
    const page = await call('/videos?status=completed&page_size=1');
    const v = page.json?.items?.[0];
    if (!v) {
      info('No completed video to test file transfer against yet.');
    } else {
      const meta = await call(`/files/${v.video_id}/metadata`);
      if (meta.status === 200) {
        ok(`GET /files/${v.video_id}/metadata → ${meta.json.size_bytes} bytes, filename "${meta.json.filename}", ranges=${meta.json.supports_ranges}`);
      } else {
        warn(`GET /files/${v.video_id}/metadata → ${meta.status} (file may be missing on the phone)`);
      }
      const head = await fetch(`${BASE}/api/v1/files/${v.video_id}/download`, {
        headers: { ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}), Range: 'bytes=0-99' },
        signal: AbortSignal.timeout(8000),
      });
      if (head.status === 206) ok('Range request → 206 partial content (server honours Range)');
      else if (head.status === 200) warn('Range request → 200 full body (server ignored Range; resume will restart the file)');
      else bad(`Range request → ${head.status}`);
      head.body?.cancel?.().catch(() => {});
    }
  } catch (e) {
    warn(`File transfer probe failed: ${e.message}`);
  }

  // Token endpoints are localhost-only by design.
  if (!isLoopback) {
    const tokens = await call('/tokens');
    if (tokens.status === 403) info('GET /tokens → 403 as expected from a remote client (localhost-only)');
    else warn(`GET /tokens → ${tokens.status} (expected 403 from a remote client)`);
  }
} else {
  info('');
  info('No token supplied. Remote/LAN access needs one:');
  info('  node scripts/check-server.mjs ' + BASE + ' <token>');
}

console.log('');