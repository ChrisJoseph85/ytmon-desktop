/** Result envelope used for every IPC call. Errors never cross as raw exceptions. */
export type Result<T> = { ok: true; data: T } | { ok: false; error: BridgeError };

export interface BridgeError {
  message: string;
  code: string;
  status?: number;
  details?: unknown;
  /** Actionable next step, derived from the documented error codes. */
  hint?: string | null;
}

export const ok = <T>(data: T): Result<T> => ({ ok: true, data });
export const fail = (e: unknown): Result<never> => {
  const err = e as { message?: string; code?: string; status?: number; details?: unknown; hint?: string | null };
  return {
    ok: false,
    error: {
      message: err?.message ?? 'Unexpected error',
      code: err?.code ?? 'unknown_error',
      status: err?.status,
      details: err?.details,
      hint:
        err?.hint ??
        (err && 'hint' in err ? (err as { hint?: string | null }).hint ?? null : null),
    },
  };
};

export interface PublicSettings {
  serverUrl: string;
  lastDownloadDir: string | null;
  maxParallelTransfers: number;
  pollIntervalMs: number;
  theme: 'system' | 'dark' | 'light';
  hasToken: boolean;
  tokenKeychain: boolean;
  /** Token is in memory only and will be forgotten when the app quits. */
  tokenSessionOnly: boolean;
  /** Where the token is actually kept: keychain | encrypted-file | memory | none. */
  tokenStorage: 'keychain' | 'encrypted-file' | 'memory' | 'none';
}

export interface SaveResult {
  cancelled: boolean;
  transfer?: import('../main/transfers').TransferSnapshot;
}

export interface ShareResultDto {
  method: 'external-url' | 'reveal' | 'mail' | 'unsupported';
  message: string;
}

export interface TokenCreatedDto {
  label: string;
  token: string;
  id: number;
  created_at: string;
}

/**
 * The complete surface exposed to renderer code via contextBridge.
 * Deliberately narrow: no Node, no fs, no token, no server-provided paths.
 */
export interface YtmonBridge {
  settings: {
    /** Public settings only — the token is never returned to the renderer. */
    get(): Promise<Result<PublicSettings>>;
    setServerUrl(url: string): Promise<Result<PublicSettings>>;
    /** persist=false keeps the token in memory for this session only. */
    setToken(token: string | null, persist?: boolean): Promise<Result<PublicSettings>>;
    setPreferences(prefs: {
      lastDownloadDir?: string | null;
      maxParallelTransfers?: number;
      pollIntervalMs?: number;
      theme?: 'system' | 'dark' | 'light';
    }): Promise<Result<PublicSettings>>;
    useLoopback(): Promise<Result<PublicSettings>>;
  };

  api: {
    health(): Promise<Result<import('../shared/types').HealthStatus>>;
    serverInfo(): Promise<Result<import('../shared/types').ServerInfo>>;
    storage(): Promise<Result<import('../shared/types').StorageInfo>>;
    qualityOptions(): Promise<Result<import('../shared/types').QualityOptions>>;
    getQuality(): Promise<Result<import('../shared/types').QualitySettings>>;
    setQuality(body: Partial<import('../shared/types').QualitySettings>): Promise<Result<import('../shared/types').QualitySettings>>;
    listChannels(enabled?: boolean | null): Promise<Result<import('../shared/types').Channel[]>>;
    addChannel(body: {
      url: string;
      channel_id?: string;
      title?: string;
      enabled?: boolean;
      /** An object ({ quality?, media_type? }), not a bare string. */
      quality_override?: import('../shared/types').SourceQualityOverride | null;
    }): Promise<Result<import('../shared/types').Channel>>;
    updateChannel(
      channelId: string,
      body: {
        url?: string;
        title?: string;
        enabled?: boolean;
        quality_override?: import('../shared/types').SourceQualityOverride | null;
      },
    ): Promise<Result<import('../shared/types').Channel>>;
    deleteChannel(channelId: string): Promise<Result<unknown>>;
    scanChannel(channelId: string): Promise<Result<import('../shared/types').MonitorScanResult>>;
    getMonitor(): Promise<Result<import('../shared/types').MonitorSettings>>;
    setMonitor(body: Partial<import('../shared/types').MonitorSettings>): Promise<Result<import('../shared/types').MonitorSettings>>;
    scanNow(): Promise<Result<import('../shared/types').MonitorScanResult>>;
    resolveChannel(url: string): Promise<Result<import('../shared/types').Channel>>;
    /** Bulk import from text (CSV/JSON body). */
    importChannels(body: string, format: 'csv' | 'json', updateExisting?: boolean): Promise<Result<import('../shared/types').ChannelImportResult>>;
    /** Bulk import from a file chosen in a native dialog. */
    importChannelsFromFile(
      updateExisting?: boolean,
    ): Promise<Result<{ cancelled: boolean; format?: string; result?: import('../shared/types').ChannelImportResult }>>;
    /** Export all channels to a file chosen in a native save dialog. */
    exportChannels(format: 'csv' | 'json'): Promise<Result<{ cancelled: boolean; path?: string; bytes?: number }>>;
    listVideos(query: import('../shared/types').VideoQuery): Promise<Result<import('../shared/types').VideoPage>>;
    getVideo(videoId: string, includeFormats?: boolean): Promise<Result<import('../shared/types').Video>>;
    setWatched(videoId: string, watched: boolean): Promise<Result<import('../shared/types').Video>>;
    deleteVideo(videoId: string, deleteFile: boolean, dryRun?: boolean): Promise<Result<import('../shared/types').DeleteResult>>;
    /** Dry run: counts what WOULD be erased without deleting anything. */
    previewBulkDelete(videoIds: (number | string)[], deleteFiles: boolean): Promise<Result<import('../shared/types').DeleteResult>>;
    bulkDelete(videoIds: (number | string)[], deleteFiles: boolean, dryRun?: boolean): Promise<Result<import('../shared/types').DeleteResult>>;
    queueStats(): Promise<Result<import('../shared/types').QueueStats>>;
    job(videoId: string): Promise<Result<import('../shared/types').Job>>;
    enqueue(videoIds: string[], priority?: number | null): Promise<Result<unknown>>;
    retry(videoId: string): Promise<Result<unknown>>;
    cancelJob(videoId: string): Promise<Result<unknown>>;
    getRetention(): Promise<Result<import('../shared/types').RetentionSettings>>;
    setRetention(body: Partial<import('../shared/types').RetentionSettings>): Promise<Result<import('../shared/types').RetentionSettings>>;
    fileMeta(videoId: string): Promise<Result<import('../shared/types').FileMetadata>>;
    listTokens(): Promise<Result<{ id: number; label: string; created_at: string; last_used_at: string | null }[]>>;
    createToken(label: string): Promise<Result<TokenCreatedDto>>;
    revokeToken(id: number): Promise<Result<import('../shared/types').TokenRevoked>>;
    reportError(level: 'ERROR' | 'WARNING' | 'INFO', message: string): Promise<Result<unknown>>;

    /** Preview (download:false) or fetch-and-download a video/playlist/channel link. */
    fetchLink(body: import('../shared/types').FetchRequest): Promise<Result<import('../shared/types').FetchResult>>;

    listSources(): Promise<Result<import('../shared/types').Source[]>>;
    getSource(sourceId: string): Promise<Result<import('../shared/types').Source>>;
    createSource(body: import('../shared/types').SourceCreate): Promise<Result<import('../shared/types').Source>>;
    updateSource(sourceId: string, body: import('../shared/types').SourceUpdate): Promise<Result<import('../shared/types').Source>>;
    deleteSource(sourceId: string): Promise<Result<unknown>>;
    scanSource(sourceId: string): Promise<Result<unknown>>;
    scanAllSources(): Promise<Result<import('../shared/types').ScanAllResult>>;
    previewSource(url: string): Promise<Result<import('../shared/types').SourcePreview>>;
    sourcesStatus(): Promise<Result<import('../shared/types').SourcesStatus>>;

    /** What the retention rules WOULD remove. Deletes nothing. */
    retentionPreview(): Promise<Result<import('../shared/types').RetentionPlan>>;
    /** dry_run defaults to true on the server and here. */
    applyRetention(dryRun?: boolean): Promise<Result<import('../shared/types').RetentionResult>>;

    /** "Keep permanently": survives all automatic deletion, not a manual one. */
    setPinned(videoId: string, pinned: boolean): Promise<Result<import('../shared/types').Video>>;
    pinVideos(
      videoIds: (number | string)[],
      pinned: boolean,
    ): Promise<Result<unknown>>;
    listPinned(): Promise<Result<import('../shared/types').Video[]>>;

    libraryLayouts(): Promise<Result<import('../shared/types').LibraryLayouts>>;
    librarySettings(): Promise<Result<import('../shared/types').LibrarySettings>>;
    /** MERGE — sending one field changes only that field. */
    updateLibrarySettings(body: import('../shared/types').LibrarySettingsUpdate): Promise<Result<import('../shared/types').LibrarySettings>>;
    libraryTree(order?: import('../shared/types').TreeOrder, limitPerFolder?: number): Promise<Result<import('../shared/types').LibraryTree>>;
  };

  files: {
    /** Opens the native save dialog, then streams the file with resume support. */
    saveToComputer(videoId: string, opts?: { resumePath?: string | null }): Promise<Result<SaveResult>>;
    pickAndResume(transferId: string): Promise<Result<SaveResult>>;
    list(): Promise<Result<import('../main/transfers').TransferSnapshot[]>>;
    cancel(transferId: string): Promise<Result<unknown>>;
    remove(transferId: string): Promise<Result<unknown>>;
    resume(transferId: string): Promise<Result<unknown>>;
    /** (a) Share the YouTube URL — always available. */
    shareUrl(videoId: string): Promise<Result<ShareResultDto>>;
    /** (b) Share an actual local file with the OS. */
    shareFile(filePath: string): Promise<Result<ShareResultDto>>;
    revealInFolder(filePath: string): Promise<Result<boolean>>;
    playLocal(filePath: string): Promise<Result<boolean>>;
    onTransferEvent(cb: (snapshot: import('../main/transfers').TransferSnapshot) => void): () => void;
    onMenuSave(cb: () => void): () => void;
  };

  app: {
    version(): Promise<Result<string>>;
    platform(): Promise<Result<string>>;
    openExternal(url: string): Promise<Result<boolean>>;
  };
}