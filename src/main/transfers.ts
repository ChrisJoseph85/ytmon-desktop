import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { YtmonError } from '../shared/errors';
import { sanitizeFilename } from '../shared/format';
import type { FileMetadata } from '../shared/types';
import type { YtmonApi } from './api';
import { networkError } from './api';

export interface TransferSnapshot {
  id: string;
  videoId: string;
  filename: string;
  destPath: string | null;
  received: number;
  total: number;
  percent: number;
  status: 'preparing' | 'downloading' | 'paused' | 'completed' | 'failed' | 'cancelled';
  error: string | null;
  speedBytesPerSec: number;
  supportsResume: boolean;
}

interface TransferEntry {
  snapshot: TransferSnapshot;
  controller: AbortController | null;
  meta: FileMetadata | null;
  destPath: string | null;
  partialPath: string | null;
  startedAt: number;
}

export interface TransferEvents {
  onUpdate: (s: TransferSnapshot) => void;
  onCompleted: (s: TransferSnapshot) => void;
}

/**
 * Streams video files from the Termux server to this computer.
 *
 * - Preflights GET /files/{id}/metadata for a real progress denominator.
 * - Resumes with `Range: bytes=<n>-` after a failure or restart; treats 206 as
 *   success and falls back to a fresh write when the server returns 200.
 * - Cancellation aborts the request and leaves a valid partial file, exactly
 *   what a later resume expects.
 */
export class TransferService {
  private readonly api: YtmonApi;
  private readonly events: TransferEvents;
  private readonly transfers = new Map<string, TransferEntry>();
  private active = 0;
  private maxParallel = 2;
  private readonly waiting: string[] = [];

  constructor(api: YtmonApi, events: TransferEvents) {
    this.api = api;
    this.events = events;
  }

  setMaxParallel(n: number): void {
    this.maxParallel = Math.max(1, Math.min(6, Math.floor(n) || 1));
    this.pump();
  }

  list(): TransferSnapshot[] {
    return [...this.transfers.values()].map((t) => ({ ...t.snapshot }));
  }

  get(id: string): TransferSnapshot | undefined {
    const t = this.transfers.get(id);
    return t ? { ...t.snapshot } : undefined;
  }

  /** How many bytes already exist in a partial file, for a correct resume offset. */
  private async partialSize(partialPath: string | null): Promise<number> {
    if (!partialPath) return 0;
    try {
      const st = await fsp.stat(partialPath);
      return st.size;
    } catch {
      return 0;
    }
  }

  update(id: string, patch: Partial<TransferSnapshot>): void {
    const t = this.transfers.get(id);
    if (!t) return;
    Object.assign(t.snapshot, patch);
    this.events.onUpdate({ ...t.snapshot });
  }

  /**
   * Starts (or resumes) a transfer. `destPath` must come from a native save
   * dialog — the caller never sends a path from an API response.
   */
  async start(params: {
    id: string;
    videoId: string;
    destPath: string;
    forceRestart?: boolean;
  }): Promise<TransferSnapshot> {
    const { id, videoId, destPath } = params;
    const meta = await this.api.fileMeta(videoId);
    if (!meta.filename) throw new YtmonError('Server returned no filename', 'invalid_response');
    if (!Number.isFinite(meta.size_bytes) || meta.size_bytes <= 0) {
      throw new YtmonError('The server reports this file as empty.', 'empty_file');
    }

    const safeName = sanitizeFilename(meta.filename, `${videoId}.mp4`);
    const finalPath = path.resolve(destPath);
    // Guard: the chosen destination must be a real, writable-looking absolute path
    // chosen by the user via the native dialog.
    if (!path.isAbsolute(finalPath)) throw new YtmonError('Invalid destination path', 'invalid_path');

    const partialPath = `${finalPath}.part`;
    let existing = params.forceRestart ? 0 : await this.partialSize(partialPath);
    if (existing > meta.size_bytes) existing = 0;

    const entry: TransferEntry = this.transfers.get(id) ?? {
      snapshot: {
        id,
        videoId,
        filename: safeName,
        destPath: finalPath,
        received: 0,
        total: meta.size_bytes,
        percent: 0,
        status: 'preparing',
        error: null,
        speedBytesPerSec: 0,
        supportsResume: meta.supports_ranges,
      },
      controller: null,
      meta: null,
      destPath: null,
      partialPath: null,
      startedAt: Date.now(),
    };
    entry.meta = meta;
    entry.destPath = finalPath;
    entry.partialPath = partialPath;
    entry.startedAt = Date.now();
    entry.snapshot = {
      ...entry.snapshot,
      filename: safeName,
      destPath: finalPath,
      total: meta.size_bytes,
      received: existing,
      percent: meta.size_bytes ? Math.round((existing / meta.size_bytes) * 100) : 0,
      error: null,
      status: existing > 0 ? 'paused' : 'preparing',
      supportsResume: meta.supports_ranges,
    };
    this.transfers.set(id, entry);
    this.events.onUpdate({ ...entry.snapshot });

    if (this.active >= this.maxParallel) {
      this.waiting.push(id);
      return { ...entry.snapshot };
    }
    void this.run(id);
    return { ...entry.snapshot };
  }

  private pump(): void {
    while (this.active < this.maxParallel && this.waiting.length > 0) {
      const id = this.waiting.shift()!;
      void this.run(id);
    }
  }

  /** The actual streaming pull with Range-based resume. */
  private async run(id: string): Promise<void> {
    const entry = this.transfers.get(id);
    if (!entry || !entry.meta || !entry.destPath || !entry.partialPath) return;

    this.active += 1;
    const controller = new AbortController();
    entry.controller = controller;
    this.update(id, { status: 'downloading' });

    const meta = entry.meta;
    const partialPath = entry.partialPath;
    let fromByte = await this.partialSize(partialPath);
    if (fromByte > meta.size_bytes) fromByte = 0;

    try {
      const headers = this.api.headers();
      if (fromByte > 0) headers['Range'] = `bytes=${fromByte}-`;

      const res = await this.api.http(`${this.api.apiBase}/files/${encodeURIComponent(meta.video_id)}/download`, {
        headers,
        signal: controller.signal,
      });

      if (res.status === 416 && fromByte > 0) {
        // Range unsatisfiable (partial is stale/corrupt) -> restart from zero.
        fromByte = 0;
        await fsp.rm(partialPath, { force: true });
        this.update(id, { received: 0, percent: 0 });
        // Re-enter; the outer `finally` releases the slot after this returns.
        return this.run(id);
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
        throw new YtmonError(
          body?.error?.message ?? `Server returned ${res.status}`,
          body?.error?.code ?? `http_${res.status}`,
          res.status,
        );
      }
      if (!res.body) throw new YtmonError('Server sent no data', 'empty_stream');

      // 206 = server honoured our Range. 200 = it ignored it, so we must
      // truncate or appended bytes would corrupt the file.
      const resumed = res.status === 206;
      if (fromByte > 0 && !resumed) fromByte = 0;

      // Newer servers send Content-Range + Content-Length on 206; use them to
      // verify the offset we asked for really is the offset we got. A mismatch
      // means the partial file and the server disagree, so restart cleanly
      // rather than write a corrupt file.
      const contentRange = res.headers.get('content-range');
      if (resumed && contentRange) {
        const m = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(contentRange.trim());
        if (!m) {
          throw new YtmonError(`Server sent an unreadable Content-Range (${contentRange}).`, 'invalid_range');
        }
        const start = Number(m[1]);
        const end = Number(m[2]);
        const totalFromServer = Number(m[3]);
        if (start !== fromByte) {
          fromByte = 0;
          await fsp.rm(partialPath, { force: true });
          this.update(id, { received: 0, percent: 0 });
          return this.run(id);
        }
        if (totalFromServer !== meta.size_bytes) {
          // The file changed size on the phone; trust the server and restart.
          meta.size_bytes = totalFromServer;
          entry.snapshot.total = totalFromServer;
        }
        const expected = end - start + 1;
        const contentLength = Number(res.headers.get('content-length'));
        if (Number.isFinite(contentLength) && contentLength !== expected) {
          throw new YtmonError('Server body length does not match Content-Range.', 'invalid_range');
        }
      }

      const declaredLength = Number(res.headers.get('content-length'));
      const expectedTotal = Number.isFinite(declaredLength) ? fromByte + declaredLength : meta.size_bytes;
      this.update(id, {
        received: fromByte,
        total: expectedTotal,
        percent: expectedTotal ? Math.round((fromByte / expectedTotal) * 100) : 0,
      });

      // Stream to disk chunk-by-chunk. We never buffer a whole video in memory,
      // and on failure/cancel we FLUSH rather than destroy the write stream so
      // the partial file holds every byte received — which is exactly what the
      // next `Range: bytes=N-` resume expects.
      const total = expectedTotal;
      const startedAt = Date.now();
      const out = fs.createWriteStream(partialPath, { flags: resumed && fromByte > 0 ? 'a' : 'w' });
      const reader = res.body.getReader();
      let received = fromByte;

      const finishWrite = (): Promise<void> =>
        new Promise((resolve, reject) => out.end((err?: NodeJS.ErrnoException | null) => (err ? reject(err) : resolve())));

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          const chunk = Buffer.from(value);
          received += chunk.length;
          const elapsed = Math.max(1, (Date.now() - startedAt) / 1000);
          entry.snapshot.received = received;
          entry.snapshot.percent = total ? Math.round((received / total) * 100) : 0;
          entry.snapshot.speedBytesPerSec = Math.round((received - fromByte) / elapsed);
          this.events.onUpdate({ ...entry.snapshot });
          if (!out.write(chunk)) {
            await once(out, 'drain');
          }
        }
        await finishWrite();
      } catch (streamErr) {
        // Flush what we have, then surface the failure.
        void finishWrite().catch(() => undefined);
        throw streamErr;
      }

      const finalSize = await this.partialSize(partialPath);
      if (finalSize !== total) {
        throw new YtmonError(
          finalSize < total
            ? 'Connection ended before the file was complete'
            : 'Received more data than the server declared',
          'incomplete',
        );
      }

      const destPath = entry.destPath;
      await fsp.rename(partialPath, destPath).catch(async (err: NodeJS.ErrnoException) => {
        if (err.code === 'EXDEV') {
          await fsp.copyFile(partialPath, destPath);
          await fsp.rm(partialPath, { force: true });
        } else throw err;
      });

      this.update(id, {
        status: 'completed',
        received: total,
        percent: 100,
        speedBytesPerSec: 0,
        error: null,
      });
      this.events.onCompleted({ ...entry.snapshot });
    } catch (err) {
      if (controller.signal.aborted || (err as Error)?.name === 'AbortError') {
        this.update(id, { status: 'cancelled', speedBytesPerSec: 0, error: null });
      } else {
        const y = networkError(err, this.api.base);
        this.update(id, { status: 'failed', speedBytesPerSec: 0, error: y.message });
      }
    } finally {
      this.active -= 1;
      entry.controller = null;
      this.pump();
    }
  }

  cancel(id: string): void {
    const entry = this.transfers.get(id);
    if (entry?.controller) entry.controller.abort();
    const idx = this.waiting.indexOf(id);
    if (idx >= 0) this.waiting.splice(idx, 1);
  }

  remove(id: string): void {
    const entry = this.transfers.get(id);
    if (entry?.controller) entry.controller.abort();
    this.transfers.delete(id);
    const idx = this.waiting.indexOf(id);
    if (idx >= 0) this.waiting.splice(idx, 1);
  }

  /** Discards a partial file (user chose "restart", not "resume"). */
  async discardPartial(destPath: string): Promise<void> {
    await fsp.rm(`${destPath}.part`, { force: true }).catch(() => undefined);
  }
}