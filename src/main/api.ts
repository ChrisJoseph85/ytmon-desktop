import { YtmonError } from '../shared/errors';
import { API_PREFIX, validateServerUrl } from '../shared/format';
import type {
  Channel,
  ChannelMode,
  ChannelPolicyBulkRequest,
  ChannelPolicyBulkResult,
  ChannelPolicyUpdate,
  DeleteRequest,
  LibraryLayouts,
  LibrarySettings,
  LibrarySettingsUpdate,
  LibraryTree,
  PinRequest,
  PinSingle,
  TreeOrder,
  DiscoverRequest,
  RetentionPlan,
  RetentionResult,
  FetchRequest,
  FetchResult,
  RetentionUpdate,
  ScanAllResult,
  Source,
  SourceCreate,
  SourcePreview,
  SourcesStatus,
  SourceUpdate,
  SourceQualityOverride,
  SubscriptionImportRequest,
  SubscriptionImportResult,
  SubscriptionsStatus,
  SubscriptionSnapshot,
  TokenRevoked,
  ChannelImportResult,
  DeleteResult,
  FileMetadata,
  HealthStatus,
  Job,
  MonitorScanResult,
  MonitorSettings,
  Quality,
  QualityOptions,
  QualitySettings,
  QueueStats,
  RetentionSettings,
  ServerInfo,
  StorageInfo,
  TokenCreated,
  Video,
  VideoPage,
  VideoQuery,
} from '../shared/types';

export interface ApiClientOptions {
  baseUrl: string;
  token?: string | null;
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT = 15_000;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  timeoutMs?: number;
  signal?: AbortSignal;
  raw?: boolean;
}

/**
 * The one API client. All calls go through main process; the renderer never
 * performs network I/O. The bearer token is sent on EVERY request — harmless on
 * loopback, required on LAN.
 */
export class YtmonApi {
  readonly base: string;
  private token: string | null;
  private timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  /** The raw transport, so other main-process services (transfers, media)
   * share the same implementation and stay injectable in tests. */
  get http(): typeof fetch {
    return this.fetchImpl;
  }

  constructor(opts: ApiClientOptions) {
    const v = validateServerUrl(opts.baseUrl);
    if (!v.ok || !v.normalized) {
      throw new YtmonError(v.reason ?? 'Invalid server URL', 'invalid_server_url');
    }
    this.base = v.normalized;
    this.token = opts.token?.trim() ? opts.token.trim() : null;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  get hasToken(): boolean {
    return this.token !== null;
  }

  get apiBase(): string {
    return `${this.base}${API_PREFIX}`;
  }

  setToken(token: string | null): void {
    this.token = token?.trim() ? token.trim() : null;
  }

  headers(json = false): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/json' };
    if (json) h['content-type'] = 'application/json';
    if (this.token) h['Authorization'] = `Bearer ${this.token}`;
    return h;
  }

  buildUrl(path: string, query?: RequestOptions['query']): string {
    const url = `${this.apiBase}${path.startsWith('/') ? path : `/${path}`}`;
    if (!query) return url;
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      p.set(k, String(v));
    }
    const qs = p.toString();
    return qs ? `${url}?${qs}` : url;
  }

  async request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    const method = opts.method ?? 'GET';
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;

    let res: Response;
    try {
      res = await this.fetchImpl(this.buildUrl(path, opts.query), {
        method,
        headers: this.headers(opts.body !== undefined),
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal,
      });
    } catch (err) {
      throw networkError(err, this.base);
    }

    const text = await res.text().catch(() => '');
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }

    if (!res.ok) {
      const body = json as { error?: { code?: string; message?: string; details?: unknown } } | null;
      const err = body?.error;
      throw new YtmonError(
        err?.message || `${method} ${path} failed (${res.status})`,
        err?.code ?? `http_${res.status}`,
        res.status,
        err?.details,
      );
    }
    return json as T;
  }

  // ---- health / server -------------------------------------------------
  health(signal?: AbortSignal) {
    return this.request<HealthStatus>('/health', { signal });
  }
  serverInfo(signal?: AbortSignal) {
    return this.request<ServerInfo>('/server/info', { signal });
  }
  storage(signal?: AbortSignal) {
    return this.request<StorageInfo>('/storage', { signal });
  }

  // ---- quality ---------------------------------------------------------
  qualityOptions(signal?: AbortSignal) {
    return this.request<QualityOptions>('/quality/options', { signal });
  }
  getQuality(signal?: AbortSignal) {
    return this.request<QualitySettings>('/quality', { signal });
  }
  setQuality(body: Partial<QualitySettings>, signal?: AbortSignal) {
    return this.request<QualitySettings>('/quality', { method: 'PUT', body, signal });
  }

  // ---- channels --------------------------------------------------------
  listChannels(enabled?: boolean, signal?: AbortSignal) {
    return this.request<Channel[]>('/channels', { query: { enabled }, signal });
  }
  /**
   * GET /subscriptions — the same channel objects, filterable server-side.
   * Returns channels carrying `mode` / `schedule_*` / `due_now` / `next_due`.
   */
  listSubscriptions(mode?: ChannelMode, signal?: AbortSignal) {
    return this.request<Channel[]>('/subscriptions', { query: { mode }, signal });
  }
  /** Whether the server can read the YouTube feed at all (cookies present). */
  subscriptionsStatus(signal?: AbortSignal) {
    return this.request<SubscriptionsStatus>('/subscriptions/status', { signal });
  }
  /**
   * POST /subscriptions/import.
   * `source: 'takeout'` REQUIRES `data` (the pasted subscriptions.json) and
   * needs nothing configured on the phone; `source: 'feed'` uses the server's
   * cookies and fails with `import_failed` when they have expired.
   * Imported channels land as mode="manual" on purpose — the server does not
   * start downloading 300 channels because a list was pasted.
   */
  importSubscriptions(body: SubscriptionImportRequest, signal?: AbortSignal) {
    const payload: SubscriptionImportRequest = { source: body.source };
    if (body.source === 'takeout') payload.data = body.data ?? '';
    return this.request<SubscriptionImportResult>('/subscriptions/import', {
      method: 'POST',
      body: payload,
      timeoutMs: 120_000,
      signal,
    });
  }
  /** Re-read a stored import at any time; survives cookie expiry. */
  subscriptionSnapshot(id: string, signal?: AbortSignal) {
    return this.request<SubscriptionSnapshot>(`/subscriptions/snapshots/${encodeURIComponent(id)}`, { signal });
  }
  addChannel(body: {
    url: string;
    channel_id?: string;
    title?: string;
    enabled?: boolean;
    /** An object ({ quality?, media_type? }), not a bare string. */
    quality_override?: SourceQualityOverride | null;
  }, signal?: AbortSignal) {
    return this.request<Channel>('/channels', { method: 'POST', body, signal });
  }
  updateChannel(
    channelId: string,
    body: { url?: string; title?: string; enabled?: boolean; quality_override?: Quality | null },
    signal?: AbortSignal,
  ) {
    return this.request<Channel>(`/channels/${encodeURIComponent(channelId)}`, {
      method: 'PATCH',
      body,
      signal,
    });
  }
  deleteChannel(channelId: string, signal?: AbortSignal) {
    return this.request<unknown>(`/channels/${encodeURIComponent(channelId)}`, { method: 'DELETE', signal });
  }
  /**
   * PATCH /channels/{channel_id}/policy — the only endpoint that writes
   * mode / schedule_enabled / schedule_days / schedule_time. The path takes a
   * canonical "UC…" id or an "@handle", never the numeric row id.
   */
  setChannelPolicy(channelId: string, body: ChannelPolicyUpdate, signal?: AbortSignal) {
    return this.request<Channel>(`/channels/${encodeURIComponent(channelId)}/policy`, {
      method: 'PATCH',
      body,
      signal,
    });
  }
  /** POST /channels/policy/bulk — one patch across many channels. */
  bulkChannelPolicy(body: ChannelPolicyBulkRequest, signal?: AbortSignal) {
    return this.request<ChannelPolicyBulkResult>('/channels/policy/bulk', { method: 'POST', body, signal });
  }
  scanChannel(channelId: string, signal?: AbortSignal) {
    return this.request<MonitorScanResult>(`/channels/${encodeURIComponent(channelId)}/scan`, {
      method: 'POST',
      signal,
    });
  }
  /** POST /channels/import/{fmt} takes the raw file bytes, not a JSON wrapper. */
  async importChannels(
    format: 'csv' | 'json',
    rawBody: string,
    updateExisting = true,
    signal?: AbortSignal,
  ): Promise<ChannelImportResult> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let res: Response;
    try {
      res = await this.fetchImpl(this.buildUrl(`/channels/import/${format}`, { update_existing: updateExisting }), {
        method: 'POST',
        headers: { ...this.headers(false), 'content-type': format === 'json' ? 'application/json' : 'text/csv' },
        body: rawBody,
        signal: combined,
      });
    } catch (err) {
      throw networkError(err, this.base);
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const e = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
      throw new YtmonError(e?.message || `Import failed (${res.status})`, e?.code ?? `http_${res.status}`, res.status, e?.details);
    }
    return json as ChannelImportResult;
  }

  // ---- monitoring ------------------------------------------------------
  getMonitor(signal?: AbortSignal) {
    return this.request<MonitorSettings>('/monitor', { signal });
  }
  setMonitor(body: Partial<MonitorSettings>, signal?: AbortSignal) {
    return this.request<MonitorSettings>('/monitor', { method: 'PUT', body, signal });
  }
  scanNow(signal?: AbortSignal) {
    return this.request<MonitorScanResult>('/monitor/scan', { method: 'POST', signal });
  }
  resolveChannel(url: string, signal?: AbortSignal) {
    return this.request<Channel>('/monitor/check', { method: 'POST', body: { url }, signal });
  }

  // ---- library ---------------------------------------------------------
  listVideos(query: VideoQuery = {}, signal?: AbortSignal) {
    // Drop undefined/null so we never send `?media_type=` and get a 422.
    const q: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') q[k] = v;
    return this.request<VideoPage>('/videos', { query: q as VideoQuery as Record<string, never>, signal });
  }
  getVideo(videoId: string, includeFormats = false, signal?: AbortSignal) {
    return this.request<Video>(`/videos/by-id/${encodeURIComponent(videoId)}`, {
      query: includeFormats ? { include_formats: 1 } : undefined,
      signal,
    });
  }
  setWatched(videoId: string, watched: boolean, signal?: AbortSignal) {
    return this.request<Video>(`/videos/${encodeURIComponent(videoId)}/watched`, {
      method: 'PATCH',
      body: { watched },
      signal,
    });
  }
  /**
   * DELETE /videos/{video_id}?delete_file=&dry_run=
   * With dry_run=true the server counts what WOULD be erased and changes
   * nothing, so the UI can confirm before destroying real files.
   */
  deleteVideo(videoId: string, deleteFile = true, dryRun = false, signal?: AbortSignal) {
    return this.request<DeleteResult>(`/videos/${encodeURIComponent(videoId)}`, {
      method: 'DELETE',
      query: { delete_file: deleteFile, dry_run: dryRun },
      signal,
    });
  }

  /** Preview a bulk delete without touching anything. */
  previewBulkDelete(videoIds: (number | string)[], deleteFiles = true, signal?: AbortSignal) {
    return this.request<DeleteResult>('/videos/bulk-delete', {
      method: 'POST',
      body: { video_ids: videoIds, delete_files: deleteFiles, dry_run: true } satisfies DeleteRequest,
      signal,
    });
  }

  bulkDelete(videoIds: (number | string)[], deleteFiles = true, dryRun = false, signal?: AbortSignal) {
    return this.request<DeleteResult>('/videos/bulk-delete', {
      method: 'POST',
      body: { video_ids: videoIds, delete_files: deleteFiles, dry_run: dryRun } satisfies DeleteRequest,
      signal,
    });
  }

  // ---- queue -----------------------------------------------------------
  queueStats(signal?: AbortSignal) {
    return this.request<QueueStats>('/queue/stats', { signal });
  }
  job(videoId: string, signal?: AbortSignal) {
    return this.request<Job>(`/queue/${encodeURIComponent(videoId)}`, { signal });
  }
  enqueue(videoIds: string[], priority?: number, signal?: AbortSignal) {
    return this.request<unknown>('/queue/enqueue', { method: 'POST', body: { video_ids: videoIds, priority }, signal });
  }
  retry(videoId: string, signal?: AbortSignal) {
    return this.request<unknown>(`/queue/${encodeURIComponent(videoId)}/retry`, { method: 'POST', signal });
  }
  cancelJob(videoId: string, signal?: AbortSignal) {
    return this.request<unknown>(`/queue/${encodeURIComponent(videoId)}/cancel`, { method: 'POST', signal });
  }

  // ---- retention -------------------------------------------------------
  getRetention(signal?: AbortSignal) {
    return this.request<RetentionSettings>('/retention', { signal });
  }
  /**
   * PUT /retention is strictly typed (additionalProperties: false) — any extra
   * key is a 422. Only these three keys are ever sent.
   */
  setRetention(body: RetentionUpdate, signal?: AbortSignal) {
    const payload: RetentionUpdate = {};
    if (body.retention_days !== undefined) payload.retention_days = body.retention_days;
    if (body.max_library_items !== undefined) payload.max_library_items = body.max_library_items;
    if (body.delete_file_when_watched !== undefined) payload.delete_file_when_watched = body.delete_file_when_watched;
    return this.request<RetentionSettings>('/retention', { method: 'PUT', body: payload, signal });
  }

  // ---- fetch by link ---------------------------------------------------
  /**
   * POST /videos/fetch — add a video/playlist/channel and download on demand.
   * `download: false` is a PREVIEW: it resolves and reports, queues nothing.
   * Hits the network via yt-dlp, so it is slow and must never be auto-retried.
   */
  fetchLink(body: FetchRequest, signal?: AbortSignal) {
    return this.request<FetchResult>('/videos/fetch', { method: 'POST', body, timeoutMs: 120_000, signal });
  }

  // ---- sources (playlists + Watch Later) --------------------------------
  listSources(signal?: AbortSignal) {
    return this.request<Source[]>('/sources', { signal });
  }
  getSource(sourceId: string, signal?: AbortSignal) {
    return this.request<Source>(`/sources/${encodeURIComponent(sourceId)}`, { signal });
  }
  createSource(body: SourceCreate, signal?: AbortSignal) {
    return this.request<Source>('/sources', { method: 'POST', body, timeoutMs: 60_000, signal });
  }
  updateSource(sourceId: string, body: SourceUpdate, signal?: AbortSignal) {
    return this.request<Source>(`/sources/${encodeURIComponent(sourceId)}`, { method: 'PATCH', body, signal });
  }
  deleteSource(sourceId: string, signal?: AbortSignal) {
    return this.request<unknown>(`/sources/${encodeURIComponent(sourceId)}`, { method: 'DELETE', signal });
  }
  scanSource(sourceId: string, signal?: AbortSignal) {
    return this.request<unknown>(`/sources/${encodeURIComponent(sourceId)}/scan`, { method: 'POST', timeoutMs: 120_000, signal });
  }
  scanAllSources(signal?: AbortSignal) {
    return this.request<ScanAllResult>('/sources/scan', { method: 'POST', timeoutMs: 180_000, signal });
  }
  /** Resolve a playlist/watch-later URL WITHOUT subscribing. */
  previewSource(url: string, signal?: AbortSignal) {
    return this.request<SourcePreview>('/sources/preview', { method: 'POST', body: { url }, timeoutMs: 60_000, signal });
  }
  sourcesStatus(signal?: AbortSignal) {
    return this.request<SourcesStatus>('/sources/status', { signal });
  }

  // ---- retention --------------------------------------------------------
  /** What the current rules WOULD remove. Deletes nothing. */
  retentionPreview(signal?: AbortSignal) {
    return this.request<RetentionPlan>('/retention/preview', { signal });
  }
  /** dry_run is the server default and the safe default here too. */
  applyRetention(dryRun = true, signal?: AbortSignal) {
    return this.request<RetentionResult>('/retention/apply', {
      method: 'POST',
      query: { dry_run: dryRun },
      timeoutMs: 120_000,
      signal,
    });
  }

  // ---- pin / keep permanently -------------------------------------------
  setPinned(videoId: string, pinned: boolean, signal?: AbortSignal) {
    return this.request<Video>(`/videos/${encodeURIComponent(videoId)}/pinned`, {
      method: 'PATCH',
      body: { pinned } satisfies PinSingle,
      signal,
    });
  }
  /** video_ids is REQUIRED; unknown ids are skipped silently by the server. */
  pinVideos(videoIds: (number | string)[], pinned: boolean, signal?: AbortSignal) {
    if (videoIds.length === 0) {
      return Promise.reject(new YtmonError('Select at least one video.', 'validation_error'));
    }
    return this.request<unknown>('/videos/pin', {
      method: 'POST',
      body: { video_ids: videoIds, pinned } satisfies PinRequest,
      signal,
    });
  }
  listPinned(signal?: AbortSignal) {
    return this.request<Video[]>('/videos/pinned', { signal });
  }

  // ---- library organisation --------------------------------------------
  libraryLayouts(signal?: AbortSignal) {
    return this.request<LibraryLayouts>('/library/layouts', { signal });
  }
  librarySettings(signal?: AbortSignal) {
    return this.request<LibrarySettings>('/library/settings', { signal });
  }
  /** MERGE: sending one field changes only that field. */
  updateLibrarySettings(body: LibrarySettingsUpdate, signal?: AbortSignal) {
    const payload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) if (v !== undefined) payload[k] = v;
    return this.request<LibrarySettings>('/library/settings', { method: 'PUT', body: payload, signal });
  }
  libraryTree(order?: TreeOrder, limitPerFolder = 200, signal?: AbortSignal) {
    return this.request<LibraryTree>('/library/tree', {
      query: { order, limit_per_folder: limitPerFolder },
      signal,
    });
  }

  // ---- discover ---------------------------------------------------------
  /**
   * POST /videos/discover is strictly typed: channel_id must be a canonical
   * UC… id or an @handle, and thumbnail_url must be an https YouTube-CDN URL
   * (better: omit it and let the server fetch the thumbnail).
   */
  discover(body: DiscoverRequest, signal?: AbortSignal) {
    if (body.channel_id && !/^(UC[A-Za-z0-9_-]{22}|@[A-Za-z0-9._-]{1,64})$/.test(body.channel_id)) {
      return Promise.reject(
        new YtmonError(
          'channel_id must be a canonical UC… id or an @handle.',
          'invalid_channel',
        ),
      );
    }
    const payload: DiscoverRequest = { ...body };
    if (payload.thumbnail_url && !isYouTubeCdnUrl(payload.thumbnail_url)) delete payload.thumbnail_url;
    return this.request<Record<string, unknown>>('/videos/discover', { method: 'POST', body: payload, signal });
  }

  // ---- files (metadata only; bytes go through the transfer service) ----
  fileMeta(videoId: string, signal?: AbortSignal) {
    return this.request<FileMetadata>(`/files/${encodeURIComponent(videoId)}/metadata`, { signal });
  }
  /** Raw fetch of the thumbnail endpoint so the caller can see 200/307/404. */
  async thumbnail(videoId: string, signal?: AbortSignal): Promise<{ status: number; type: string | null; bytes: Uint8Array | null }> {
    const res = await this.fetchImpl(this.thumbnailUrl(videoId), { headers: this.headers(), signal });
    if (res.status === 200) {
      const buf = new Uint8Array(await res.arrayBuffer());
      return { status: 200, type: res.headers.get('content-type') ?? 'image/jpeg', bytes: buf };
    }
    return { status: res.status, type: res.headers.get('content-type'), bytes: null };
  }
  streamUrl(videoId: string): string {
    return this.buildUrl(`/files/${encodeURIComponent(videoId)}/stream`);
  }
  /** Server-cached thumbnail. 200 = cached bytes, 307 = follow to YouTube, 404 = none. */
  thumbnailUrl(videoId: string): string {
    return this.buildUrl(`/videos/${encodeURIComponent(videoId)}/thumbnail`);
  }

  // ---- tokens (localhost-only on the server) ---------------------------
  createToken(label: string, signal?: AbortSignal) {
    return this.request<TokenCreated>('/tokens', { method: 'POST', body: { label }, signal });
  }
  listTokens(signal?: AbortSignal) {
    return this.request<{ id: number; label: string; created_at: string; last_used_at: string | null }[]>(
      '/tokens',
      { signal },
    );
  }
  /** Server returns { revoked: true, token_id } — not a count. */
  revokeToken(id: number, signal?: AbortSignal) {
    return this.request<TokenRevoked>(`/tokens/${id}`, { method: 'DELETE', signal });
  }
  revokeTokenByValue(token: string, signal?: AbortSignal) {
    return this.request<unknown>('/tokens/by-value', { method: 'DELETE', body: { token }, signal });
  }

  // ---- logs ------------------------------------------------------------
  reportClientError(level: 'ERROR' | 'WARNING' | 'INFO', logger: string, message: string) {
    return this.request<unknown>('/logs', { method: 'POST', body: { level, logger, message } }).catch(() => undefined);
  }
}

export function networkError(err: unknown, base: string): YtmonError {
  if (err instanceof YtmonError) return err;
  if (err instanceof Error) {
    if (err.name === 'AbortError') return new YtmonError('Request cancelled', 'cancelled');
    if (err.name === 'TimeoutError') {
      return new YtmonError(`No response from ${base} — the phone may be asleep or the address changed.`, 'timeout');
    }
    return new YtmonError(`Cannot reach ${base}: ${err.message}`, 'unreachable');
  }
  return new YtmonError(`Cannot reach ${base}`, 'unreachable');
}

/** Only https URLs on YouTube's image CDNs are accepted and stored. */
export function isYouTubeCdnUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /(^|\.)(i\.ytimg\.com|img\.youtube\.com|yt3\.ggpht\.com)$/.test(u.hostname);
  } catch {
    return false;
  }
}

export function describeScanResult(r: MonitorScanResult): string {
  const bits = [
    `${r.channels_scanned} channel${r.channels_scanned === 1 ? '' : 's'} scanned`,
    `${r.discovered} new`,
    `${r.queued} queued`,
  ];
  if (r.duplicates > 0) bits.push(`${r.duplicates} duplicate${r.duplicates === 1 ? '' : 's'} skipped`);
  if (r.filtered > 0) bits.push(`${r.filtered} filtered`);
  // `held` is a policy outcome, not a failure: the videos WERE discovered,
  // they were just not downloaded because the channel is manual or not due.
  if (r.held && r.held > 0) bits.push(`${r.held} held (manual / not due)`);
  if (r.errors.length > 0) bits.push(`${r.errors.length} error${r.errors.length === 1 ? '' : 's'}`);
  return bits.join(' · ');
}