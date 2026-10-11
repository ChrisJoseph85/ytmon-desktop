/**
 * Types mirrored from the server's OpenAPI schema (api v1, server 1.0.0).
 *
 * RULE: the server is the single source of truth. These are a hand-mirrored
 * subset of /openapi.json; `src/main/openapi.ts` validates live responses
 * against the same field names so a contract drift shows up as an explicit
 * error instead of silently undefined values.
 */

export const QUALITY_VALUES = [
  '144p',
  '240p',
  '360p',
  '480p',
  '720p',
  '1080p',
  '1440p',
  '2160p',
  'best',
] as const;
export type Quality = (typeof QUALITY_VALUES)[number];

/** Order mirrors the server's DownloadStateEnum exactly. */
export const DOWNLOAD_STATES = [
  'discovered',
  'queued',
  'downloading',
  'completed',
  'failed',
  'skipped',
  'unavailable',
] as const;
export type DownloadState = (typeof DOWNLOAD_STATES)[number];

/** What the server stores: a video file, or audio-only MP3. */
export const MEDIA_TYPES = ['video', 'audio'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

export const CONTENT_KINDS = ['video', 'short', 'unknown'] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

export const CONTENT_FILTERS = ['all', 'video', 'shorts'] as const;
export type ContentFilter = (typeof CONTENT_FILTERS)[number];

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export interface Video {
  id: number;
  video_id: string;
  channel_id: string;
  /** video = mp4/mkv, audio = MP3 with embedded cover art. */
  media_type: MediaType;
  /** Server-cached thumbnail, relative. Fetch via /videos/{id}/thumbnail. */
  thumbnail_path: string | null;
  /** Which source/playlist this item came from, when it came from one. */
  source_id: string | null;
  /**
   * "Keep permanently": survives delete-after-watch, retention_days and
   * max_library_items. An explicit manual DELETE still removes it.
   */
  pinned: boolean;
  title: string;
  description: string | null;
  thumbnail_url: string | null;
  published_at: string | null;
  duration: number | null;
  is_short: boolean | null;
  kind: ContentKind;
  file_path: string | null;
  file_size: number | null;
  quality: Quality | null;
  quality_height: number | null;
  watched: boolean;
  watched_at: string | null;
  status: DownloadState;
  error_message: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface Job {
  id: number;
  video_id: string;
  channel_id: string | null;
  /** Not present on the current server (verified against the live schema). */
  media_type?: MediaType;
  status: DownloadState;
  quality: Quality | null;
  progress: number;
  speed: number | null;
  downloaded_bytes: number | null;
  total_bytes: number | null;
  eta: number | null;
  attempts: number;
  next_attempt_at: string | null;
  error_message: string | null;
  created_at: string | null;
  updated_at: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface Channel {
  id: number;
  channel_id: string;
  url: string;
  title: string | null;
  enabled: boolean;
  /**
   * An OBJECT, not a bare quality string — the same shape as a source
   * override. Rendering it directly is a React "objects are not valid as a
   * child" crash, so always read `.quality` / `.media_type`.
   */
  quality_override: SourceQualityOverride | null;
  last_checked_at: string | null;
  last_uploaded_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface VideoPage {
  items: Video[];
  total: number;
  page: number;
  page_size: number;
}

export interface DeleteResult {
  deleted: number;
  files_deleted: number;
  files_missing: number;
  errors: string[];
}

/**
 * POST /videos/bulk-delete body. `video_ids` accepts EITHER the numeric row id
 * OR the YouTube video_id string.
 */
export interface DeleteRequest {
  video_ids: (number | string)[];
  delete_files: boolean;
  /** Preview only: counts what WOULD be erased, changes nothing. */
  dry_run?: boolean;
}

export interface MonitorScanResult {
  channels_scanned: number;
  discovered: number;
  queued: number;
  duplicates: number;
  filtered: number;
  errors: string[];
}

export interface ChannelImportResult {
  imported: number;
  updated: number;
  skipped: number;
  errors: string[];
}

export interface QueueStats {
  queued: number;
  downloading: number;
  completed: number;
  failed: number;
  skipped: number;
  unavailable: number;
}

export interface FileMetadata {
  video_id: string;
  filename: string;
  size_bytes: number;
  mime_type: string | null;
  quality: Quality | null;
  quality_height: number | null;
  duration: number | null;
  modified_at: string | null;
  supports_ranges: boolean;
}

export interface QualityOptions {
  options: Quality[];
  default: Quality;
  media_types?: MediaType[];
  per_channel_overrides: Record<string, { quality: Quality }>;
}

export interface QualitySettings {
  quality: Quality;
  /** Global default for what to store. */
  media_type: MediaType;
  prefer_mp4: boolean;
  embed_subs: boolean;
  /** yt-dlp subtitle language filter, e.g. "en.*". The server rejects "*"
   * with 400 invalid_sub_langs because it breaks every download. */
  sub_langs: string;
  embed_metadata: boolean;
  embed_thumbnail: boolean;
  write_description: boolean;
  max_concurrent_downloads: number;
  /** Directory on the PHONE. Existing files stay reachable after it changes. */
  download_dir: string | null;
}

export interface MonitorSettings {
  enabled: boolean;
  interval_minutes: number;
  window_hours: number;
  future_only: boolean;
  content_filter: ContentFilter;
}

/** GET /retention/preview — what the rules WOULD remove. Nothing is deleted. */
// ---- pin / keep permanently ---------------------------------------------

export interface PinSingle {
  pinned: boolean;
}

export interface PinRequest {
  /** Required — an empty body is a 422, not a silent no-op. */
  video_ids: (number | string)[];
  pinned: boolean;
}

// ---- library organisation -------------------------------------------------

export type MediaLayout = 'channel_id' | 'channel_title' | 'channel_source' | 'flat';
export type TreeOrder = 'newest' | 'oldest' | 'title' | 'duration';

export interface LibraryLayouts {
  options: MediaLayout[];
  descriptions: Record<string, string>;
  orders: TreeOrder[];
}

/** Everything storage-related in one place. PUT is a MERGE. */
export interface LibrarySettings {
  /** Where NEW downloads land on the phone. Existing files are not moved. */
  media_layout: MediaLayout;
  tree_order: TreeOrder;
  retention_days: number | null;
  max_library_items: number | null;
  delete_file_when_watched: boolean;
}

/** A partial update: every field is optional because the PUT merges. */
export type LibrarySettingsUpdate = Partial<LibrarySettings>;

export interface LibraryTreeItem {
  video_id?: string;
  id?: number;
  title?: string;
  media_type?: MediaType;
  duration?: number | null;
  file_size?: number | null;
  pinned?: boolean;
  watched?: boolean;
  published_at?: string | null;
  [k: string]: unknown;
}

export interface LibrarySubfolder {
  name: string;
  source_id: string | null;
  /** True total; `items` may be truncated by limit_per_folder. */
  item_count: number;
  items: LibraryTreeItem[];
}

export interface LibraryFolder {
  name: string;
  channel_id: string | null;
  /** Null for videos whose channel was never added — falls back to the UC id. */
  channel_title: string | null;
  item_count: number;
  total_bytes: number;
  subfolders: LibrarySubfolder[];
}

export interface LibraryTree {
  folders: LibraryFolder[];
  total_videos: number;
  total_folders: number;
  order: TreeOrder;
  media_dir: string;
}

export interface RetentionPlan {
  retention_days: number | null;
  max_library_items: number | null;
  completed_total: number;
  would_delete: number;
  bytes: number;
  video_ids: string[];
}

export interface RetentionResult {
  deleted: number;
  files_deleted: number;
  errors: string[];
}

export interface RetentionWorkerStatus {
  running: boolean;
  last_run: string | null;
  last_result: Record<string, unknown> | null;
}

/**
 * POST /videos/discover body. `channel_id` is STRICTLY typed: it must be a
 * canonical UC… id or an @handle, anything else is a 422.
 */
export interface DiscoverRequest {
  video_id: string;
  channel_id?: string | null;
  title?: string | null;
  /** Omit it: the server fetches thumbnails itself, and only https YouTube-CDN
   * URLs are stored (anything else is silently dropped). */
  thumbnail_url?: string | null;
  published_at?: string | null;
  duration?: number | null;
  kind?: ContentKind;
}

export interface RetentionSettings {
  delete_file_when_watched: boolean;
  retention_days: number | null;
  max_library_items: number | null;
}

export interface StorageInfo {
  bytes: number;
  files: number;
  free: number;
  /** Present on newer servers: watched + unwatched + orphaned === bytes. */
  watched_bytes?: number;
  unwatched_bytes?: number;
  orphaned_bytes?: number;
  /** Optional variant names the server may use for the same figures. */
  total_bytes?: number;
  [k: string]: unknown;
}

export interface ServerInfo {
  api_version: string;
  server_version: string;
  ffmpeg_path: string | null;
  bind_mode: string;
  [k: string]: unknown;
}

export interface WorkerState {
  active?: number;
  concurrency?: number;
  enabled?: boolean;
  interval_minutes?: number;
  running?: boolean;
  last_error?: string | null;
  [k: string]: unknown;
}

export interface HealthStatus {
  status: 'ok' | 'degraded' | string;
  version?: string;
  uptime_seconds?: number;
  database?: boolean;
  workers?: {
    download?: WorkerState;
    monitor?: WorkerState;
    sources?: WorkerState;
    retention?: RetentionWorkerStatus;
  };
  [k: string]: unknown;
}

// ---- sources (playlists + Watch Later) ---------------------------------

export interface SourceCounts {
  /** Live, derived from real video status — 13 of 19 downloaded, 6 failed. */
  total: number;
  downloaded: number;
  failed: number;
}

export interface SourceQualityOverride {
  quality?: Quality | null;
  media_type?: MediaType | null;
}

export interface Source {
  id: number;
  source_id: string;
  kind: 'playlist' | 'watch_later' | string;
  url: string;
  title: string | null;
  enabled: boolean;
  quality_override: SourceQualityOverride | null;
  last_checked_at: string | null;
  last_added_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  counts: SourceCounts;
}

export interface SourceCreate {
  url: string;
  title?: string | null;
  enabled?: boolean;
  quality_override?: SourceQualityOverride | null;
}

export interface SourceUpdate {
  title?: string | null;
  enabled?: boolean | null;
  quality_override?: SourceQualityOverride | null;
}

export interface SourcePreview {
  source_id: string;
  kind: 'playlist' | 'watch_later' | string;
  title: string | null;
  count: number;
  truncated: boolean;
  /** True when the server needs YouTube cookies to read this source. */
  cookies_required: boolean;
  entries: { title?: string; video_id?: string; url?: string }[];
}

export interface SourcesStatus {
  sources: number;
  enabled: number;
  running: boolean;
  last_error: string | null;
  /** Watch Later is empty without this. */
  cookies_configured: boolean;
  default_quality: string;
}

// ---- fetch by link -----------------------------------------------------

export interface FetchRequest {
  url: string;
  /** false = PREVIEW ONLY: resolves and reports, queues nothing. */
  download?: boolean;
  media_type?: MediaType | null;
  quality?: Quality | null;
  limit?: number;
  priority?: number;
  thumbnail?: boolean;
}

export interface FetchResult {
  kind: 'video' | 'playlist' | string;
  url?: string;
  playlist_title?: string | null;
  resolved: number;
  added: string[];
  queued: string[];
  duplicates: string[];
  unavailable: string[];
  truncated: boolean;
  /** null when download=false — expected, not a bug. */
  quality: string | null;
  media_type: string;
}

export interface ScanStats {
  source: string;
  seen: number;
  new: number;
  queued: number;
  duplicates: number;
  truncated: boolean;
  error: string | null;
}

export interface ScanAllResult {
  results: ScanStats[];
}

export interface TokenCreated {
  label: string;
  token: string;
  id: number;
  created_at: string;
}

export interface TokenRevoked {
  revoked: boolean;
  token_id: number;
}

/** Server error codes the client gives specific meaning to. */
export const ERROR_CODES = {
  missing_token: 'missing_token',
  invalid_token: 'invalid_token',
  unauthorized: 'unauthorized',
  not_found: 'not_found',
  invalid_path: 'invalid_path',
  validation_error: 'validation_error',
  invalid_sub_langs: 'invalid_sub_langs',
  not_retryable: 'not_retryable',
  not_cancellable: 'not_cancellable',
  method_not_allowed: 'method_not_allowed',
  empty_import: 'empty_import',
  unparseable_import: 'unparseable_import',
  channel_disabled: 'channel_disabled',
  payload_too_large: 'payload_too_large',
  invalid_url: 'invalid_url',
  origin_not_allowed: 'origin_not_allowed',
  invalid_download_dir: 'invalid_download_dir',
  invalid_host: 'invalid_host',
  not_a_playlist: 'not_a_playlist',
  source_disabled: 'source_disabled',
  invalid_range: 'invalid_range',
  empty_file: 'empty_file',
  incomplete: 'incomplete',
} as const;

/**
 * PUT /retention is strictly typed (additionalProperties: false) — sending any
 * other key is a 422. Only these three are ever sent.
 */
export interface RetentionUpdate {
  retention_days?: number | null;
  max_library_items?: number | null;
  delete_file_when_watched?: boolean;
}

export type VideoSortField =
  | 'published_at'
  | 'created_at'
  | 'title'
  | 'file_size'
  | 'duration'
  | 'id';

export interface VideoQuery {
  search?: string;
  media_type?: MediaType;
  channel_id?: string;
  status?: DownloadState;
  kind?: ContentKind;
  watched?: boolean;
  sort?: VideoSortField;
  order?: 'asc' | 'desc';
  page?: number;
  page_size?: number;
}