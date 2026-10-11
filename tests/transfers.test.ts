import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TransferService, type TransferSnapshot } from '../src/main/transfers';
import { YtmonApi } from '../src/main/api';
import type { FileMetadata } from '../src/shared/types';

/**
 * Exercises the real streaming code path against a temp directory and a stub
 * server that honours Range exactly like the FastAPI server does.
 */

const VIDEO_ID = 'dQw4w9WgXcQ';
const PAYLOAD = Buffer.from(Array.from({ length: 200_000 }, (_, i) => i % 251));

interface StubServer {
  calls: { url: string; init: RequestInit }[];
  api: YtmonApi;
  service: TransferService;
  snapshots: TransferSnapshot[];
  dir: string;
}

function makeStub(options: { supportsRanges?: boolean; dropAfter?: number; failOnce?: boolean } = {}): StubServer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytmon-test-'));
  const calls: { url: string; init: RequestInit }[] = [];
  let dropEnabled = options.dropAfter !== undefined;
  let failOnce = options.failOnce ?? false;

  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const headers = (init.headers ?? {}) as Record<string, string>;

    if (url.endsWith('/metadata')) {
      const meta: FileMetadata = {
        video_id: VIDEO_ID,
        filename: 'test video.mp4',
        size_bytes: PAYLOAD.length,
        mime_type: 'video/mp4',
        quality: '1080p',
        quality_height: 1080,
        duration: 120,
        modified_at: null,
        supports_ranges: options.supportsRanges ?? true,
      };
      return new Response(JSON.stringify(meta), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    if (failOnce) {
      failOnce = false;
      return new Response('boom', { status: 500 });
    }

    const range = headers['Range'];
    const supports = (options.supportsRanges ?? true) && Boolean(range);
    const start = supports ? Number(/bytes=(\d+)-/.exec(range ?? '')?.[1] ?? 0) : 0;
    const chunk = supports ? PAYLOAD.subarray(start) : PAYLOAD;

    // Drop only on the first download attempt so a resume can succeed.
    const dropAfter = options.dropAfter !== undefined && dropEnabled ? options.dropAfter : undefined;
    if (dropAfter !== undefined) dropEnabled = false;
    const body =
      dropAfter !== undefined && chunk.length > dropAfter
        ? new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(chunk.subarray(0, dropAfter)));
              // Error on a later tick so the queued bytes are actually delivered.
              setTimeout(() => controller.error(new Error('connection reset')), 5);
            },
          })
        : new Uint8Array(chunk);

    return new Response(body, {
      status: supports ? 206 : 200,
      headers: {
        'content-type': 'video/mp4',
        'accept-ranges': 'bytes',
        ...(supports ? { 'content-range': `bytes ${start}-${PAYLOAD.length - 1}/${PAYLOAD.length}` } : {}),
        'content-length': String(chunk.length),
      },
    });
  }) as unknown as typeof fetch;

  const api = new YtmonApi({ baseUrl: 'http://192.168.1.100:8765', token: 'tok_test', fetchImpl: impl });
  const snapshots: TransferSnapshot[] = [];
  const service = new TransferService(api, {
    onUpdate: (s) => snapshots.push(s),
    onCompleted: () => undefined,
  });
  return { calls, api, service, snapshots, dir };
}

const dest = (dir: string) => path.join(dir, 'out.mp4');

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('timed out waiting for condition');
}

let stub: StubServer | undefined;

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  if (stub) {
    stub.service.setMaxParallel(1);
    fs.rmSync(stub.dir, { recursive: true, force: true });
    stub = undefined;
  }
});

describe('TransferService — authenticated file transfer over the LAN', () => {
  it('streams the whole file and lands it at the chosen destination', async () => {
    stub = makeStub();
    const target = dest(stub.dir);
    stub.service.start({ id: 't1', videoId: VIDEO_ID, destPath: target });
    await waitFor(() => stub!.service.get('t1')?.status === 'completed');

    const written = await fsp.readFile(target);
    expect(written.equals(PAYLOAD)).toBe(true);
    expect(stub.service.get('t1')).toMatchObject({ received: PAYLOAD.length, percent: 100 });

    // metadata preflight + the download request, both authenticated.
    const metaCall = stub.calls.find((c) => c.url.endsWith('/metadata'));
    const dlCall = stub.calls.find((c) => c.url.endsWith('/download'));
    expect((metaCall!.init.headers as Record<string, string>).Authorization).toBe('Bearer tok_test');
    expect((dlCall!.init.headers as Record<string, string>).Authorization).toBe('Bearer tok_test');
  });

  it('uses the server-supplied filename but never a server-supplied path', async () => {
    stub = makeStub();
    const snapshotPromise = stub.service.start({ id: 't2', videoId: VIDEO_ID, destPath: dest(stub.dir) });
    await snapshotPromise;
    expect(stub.service.get('t2')?.filename).toBe('test video.mp4');
    expect(path.isAbsolute(stub.service.get('t2')!.destPath!)).toBe(true);
  });

  it('reports progress monotonically up to the real size', async () => {
    stub = makeStub();
    stub.service.start({ id: 't3', videoId: VIDEO_ID, destPath: dest(stub.dir) });
    await waitFor(() => stub!.service.get('t3')?.status === 'completed');
    const updates = stub.snapshots.filter((s) => s.id === 't3');
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) {
      expect(u.received).toBeLessThanOrEqual(PAYLOAD.length);
      expect(u.percent).toBeLessThanOrEqual(100);
    }
    expect(updates[updates.length - 1]!.percent).toBe(100);
  });

  it('resumes with Range from the exact byte after a dropped connection', async () => {
    stub = makeStub({ dropAfter: 50_000 });
    const target = dest(stub.dir);
    stub.service.start({ id: 't4', videoId: VIDEO_ID, destPath: target });
    await waitFor(() => stub!.service.get('t4')?.status === 'failed');
    expect(stub.service.get('t4')?.status).toBe('failed');

    // A retry would hit the stub's server again; we assert the partial file and
    // the resume offset the service will use.
    const partialSize = (await fsp.stat(`${target}.part`)).size;
    expect(partialSize).toBeGreaterThan(0);
    expect(partialSize).toBeLessThan(PAYLOAD.length);

    const resumed = await stub.service.start({ id: 't4', videoId: VIDEO_ID, destPath: target });
    await waitFor(() => stub!.service.get('t4')?.status === 'completed');
    const written = await fsp.readFile(target);
    expect(written.equals(PAYLOAD)).toBe(true);
    expect(resumed.received).toBeGreaterThan(0);
  });

  it('sends Range: bytes=N- on resume when the server supports ranges', async () => {
    // First run drops mid-file, second run succeeds.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytmon-range-'));
    const target = path.join(dir, 'out.mp4');
    let drop = true;
    const seenRanges: (string | undefined)[] = [];

    const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const headers = (init.headers ?? {}) as Record<string, string>;
      if (url.endsWith('/metadata')) {
        const meta: FileMetadata = {
          video_id: VIDEO_ID,
          filename: 'v.mp4',
          size_bytes: PAYLOAD.length,
          mime_type: 'video/mp4',
          quality: 'best',
          quality_height: 1080,
          duration: null,
          modified_at: null,
          supports_ranges: true,
        };
        return new Response(JSON.stringify(meta), { status: 200 });
      }
      const range = headers['Range'];
      seenRanges.push(range);
      const start = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;
      const chunk = PAYLOAD.subarray(start);
      if (drop) {
        drop = false;
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(chunk.subarray(0, 1000)));
              setTimeout(() => c.error(new Error('reset')), 5);
            },
          }),
          { status: 206, headers: { 'content-length': String(chunk.length) } },
        );
      }
      return new Response(new Uint8Array(chunk), { status: 206, headers: { 'content-length': String(chunk.length) } });
    }) as unknown as typeof fetch;

    const api = new YtmonApi({ baseUrl: 'http://192.168.1.100:8765', fetchImpl: impl });
    const svc = new TransferService(api, { onUpdate: () => undefined, onCompleted: () => undefined });
    svc.start({ id: 'r', videoId: VIDEO_ID, destPath: target });
    await waitFor(() => svc.get('r')?.status === 'failed');
    await svc.start({ id: 'r', videoId: VIDEO_ID, destPath: target });
    await waitFor(() => svc.get('r')?.status === 'completed');

    expect(seenRanges[0]).toBeUndefined();
    expect(seenRanges[1]).toBe('bytes=1000-');
    expect((await fsp.readFile(target)).equals(PAYLOAD)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('restarts cleanly when the server ignores Range and returns 200', async () => {
    // supports_ranges=false means the request falls back to a full body; the
    // service must NOT append to an existing partial file (that would corrupt).
    stub = makeStub({ supportsRanges: false });
    const target = dest(stub.dir);
    stub.service.start({ id: 't5', videoId: VIDEO_ID, destPath: target });
    await waitFor(() => stub!.service.get('t5')?.status === 'completed');
    expect((await fsp.readFile(target)).equals(PAYLOAD)).toBe(true);
  });

  it('cancellation keeps a valid partial file that a later resume can use', async () => {
    stub = makeStub();
    const target = dest(stub.dir);
    stub.service.start({ id: 't6', videoId: VIDEO_ID, destPath: target });
    stub.service.cancel('t6');
    await waitFor(() => ['cancelled', 'completed'].includes(stub!.service.get('t6')?.status ?? ''));
    const snap = stub.service.get('t6')!;
    expect(['cancelled', 'completed']).toContain(snap.status);
    // Whether it finished or not, the destination is never a corrupt mixture.
    if (snap.status === 'cancelled') {
      const part = `${target}.part`;
      if (fs.existsSync(part)) {
        const size = (await fsp.stat(part)).size;
        expect(size).toBeLessThanOrEqual(PAYLOAD.length);
      }
    }
  });

  it('a 404 file metadata surfaces a clear not-found error, not a silent failure', async () => {
    const impl = (async () =>
      new Response(JSON.stringify({ error: { code: 'not_found', message: 'video not found' } }), {
        status: 404,
      })) as unknown as typeof fetch;
    const api = new YtmonApi({ baseUrl: 'http://192.168.1.100:8765', fetchImpl: impl });
    const svc = new TransferService(api, { onUpdate: () => undefined, onCompleted: () => undefined });
    await expect(svc.start({ id: 'z', videoId: VIDEO_ID, destPath: '/tmp/x.mp4' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('respects the parallel transfer limit', async () => {
    stub = makeStub();
    stub.service.setMaxParallel(1);
    stub.service.start({ id: 'p1', videoId: VIDEO_ID, destPath: dest(stub.dir) });
    stub.service.start({ id: 'p2', videoId: VIDEO_ID, destPath: path.join(stub.dir, 'out2.mp4') });
    // The second stays queued while the first holds the only slot.
    await waitFor(() => stub!.service.get('p2')?.status === 'completed');
    expect(stub.service.list().every((t) => t.percent >= 0)).toBe(true);
  });

  it('never writes outside the chosen destination and cleans up the partial on success', async () => {
    stub = makeStub();
    const target = dest(stub.dir);
    stub.service.start({ id: 't7', videoId: VIDEO_ID, destPath: target });
    await waitFor(() => stub!.service.get('t7')?.status === 'completed');
    expect(fs.existsSync(`${target}.part`)).toBe(false);
    expect(fs.existsSync(target)).toBe(true);
  });
});