# API contract used by this client

Base URL: `<server-url>` (user setting). API prefix: `/api/v1`. Schema: `/openapi.json`.

**The server's OpenAPI schema is the single source of truth.** This document records exactly what the
desktop client calls today, so the Android client and the server can be verified against the same list.
Models are mirrored in `src/shared/types.ts`; the client validates at runtime and surfaces the
server's own error message rather than parsing text.

API version: `v1`. Expected server version: `1.0.0`.

## Endpoints called by this client

| Method | Path | Where |
| --- | --- | --- |
| GET | `/health` | Connection banner (public — no token required) |
| GET | `/server/info` | Connection screen: versions, ffmpeg path, bind mode (public) |
| GET | `/quality/options` | Settings dropdown; **render from this** |
| GET | `/quality` | Settings screen |
| PUT | `/quality` | Partial update — the server **merges** the fields you send |
| GET | `/retention` | Delete-after-watch state (always read before showing it) |
| PUT | `/retention` | Toggle delete-after-watch, retention days, max items |
| GET | `/monitor` | Monitoring settings |
| PUT | `/monitor` | Save monitoring settings |
| POST | `/monitor/scan` | "Scan now" button only — never on a timer from a client |
| GET | `/channels` | Channels screen (with `?enabled=`) |
| POST | `/channels` | Add a channel |
| PATCH | `/channels/{channel_id}` | Edit, enable/disable, quality override |
| DELETE | `/channels/{channel_id}` | Remove a channel |
| POST | `/channels/{channel_id}/scan` | Scan one channel now |
| POST | `/monitor/check` | Resolve a URL to a channel without adding it |
| GET | `/videos` | Library list (all documented query params) |
| GET | `/videos/by-id/{video_id}` | Single video (with `?include_formats=1` for yt-dlp probing) |
| PATCH | `/videos/{video_id}/watched` | Watched / unwatched toggle |
| DELETE | `/videos/{video_id}` | Delete one (`?delete_file=&dry_run=`) |
| POST | `/videos/bulk-delete` | Bulk delete / **dry-run preview** `{video_ids, delete_files, dry_run}` |
| POST | `/videos/discover` | Discovery (server dedupes; clients stay idempotent) |
| GET | `/queue/stats` | Downloads screen counters |
| GET | `/queue/{video_id}` | Live job progress while downloading |
| POST | `/queue/{video_id}/retry` | Retry a **failed** job |
| POST | `/queue/{video_id}/cancel` | Cancel a **queued** job |
| POST | `/queue/enqueue` | Enqueue video ids |
| GET | `/files/{video_id}/metadata` | Preflight: size, filename, mime, range support |
| GET | `/files/{video_id}/stream` | Playback (through `ytmon-media://`, auth injected) |
| GET | `/files/{video_id}/download` | Save to this computer (Range-resumable) |
| GET | `/storage` | Phone storage stats (with watched/unwatched/orphaned breakdown) |
| POST | `/logs` | Client-side error reporting |
| GET/POST/DELETE | `/tokens`, `/tokens/{id}`, `/tokens/by-value` | **Not used** — localhost-only on the server; see below |

Not used by the desktop client: `/channels/export/{csv|json}`, `/channels/import[/{csv|json}]`,
`/queue` (the paged queue listing — the client derives jobs from `/videos` + `/queue/{id}`).

### Token minting is intentionally not implemented here

`POST /tokens`, `GET /tokens` and `DELETE /tokens*` are **localhost-only on the server** — a remote
client gets `403` even with a valid token. The desktop app therefore never calls them. It asks the
user to mint a token on the phone (`127.0.0.1:8765/docs → POST /tokens`) and to revoke it there
(`DELETE /api/v1/tokens/{token_id}` or `DELETE /api/v1/tokens/by-value`).

## Authentication

- Loopback (`127.0.0.1`, `::1`) with LAN mode off: no header needed; the server trusts loopback.
- LAN mode on: **every** endpoint except `GET /health` and `GET /server/info` requires
  `Authorization: Bearer <token>`.
- This client sends the header on **every** request when a token is configured — harmless on loopback,
  required on LAN, and it means switching between the two needs no code change.
- A 401 is surfaced as a prompt for a token, not a dead end.
- The token lives only in the main process, encrypted with the OS keychain.

## Enum values (never invent new ones)

```text
QualityEnum:      144p 240p 360p 480p 720p 1080p 1440p 2160p best
DownloadState:    discovered queued downloading completed failed unavailable skipped
VideoKindEnum:    video short unknown
ContentFilter:    all video shorts
```

`QueueStats` has exactly `queued, downloading, completed, failed, skipped, unavailable` — note there
is **no** `discovered` in QueueStats.

### Quality semantics

`quality` is a **maximum permitted height**, not a guarantee. `best` is the only unbounded option.
After a download, `Video.quality` = requested, `Video.quality_height` = obtained. The client displays
`quality_height`. If nothing exists at or below the ceiling the server fails the job with a clear
error; the client never implies otherwise. Per-channel overrides win over the global default.

### Status-specific client behaviour

- `unavailable` — permanent (private / removed / age-restricted / DRM). No Retry button, no error
  framing. Never retried automatically.
- `failed` — shows `error_message` plus a Retry button → `POST /queue/{video_id}/retry`.
- `completed` — file actions enabled (`status == completed` **and** `file_path !== null`).

## Models

Mirrored verbatim in `src/shared/types.ts`:

```text
Video:        id, video_id, channel_id, title, description, thumbnail_url,
              published_at, duration, is_short, kind, file_path, file_size,
              quality, quality_height, watched, watched_at, status,
              error_message, created_at, updated_at
Job:          id, video_id, channel_id, status, quality, progress, speed,
              downloaded_bytes, total_bytes, eta, attempts, next_attempt_at,
              error_message, created_at, updated_at, started_at, completed_at
Channel:      id, channel_id, url, title, enabled, quality_override,
              last_checked_at, last_uploaded_at, created_at, updated_at
VideoPage:    items[], total, page, page_size
DeleteResult: deleted, files_deleted, files_missing, errors[]
MonitorScanResult: channels_scanned, discovered, queued, duplicates, filtered, errors[]
ChannelImportResult: imported, updated, skipped, errors[]
FileMetadata: video_id, filename, size_bytes, mime_type, quality, quality_height,
              duration, modified_at, supports_ranges
```

Timestamps are ISO-8601 UTC strings or `null`. `speed` is bytes/sec, `eta` is seconds, `progress` is
0–100, `published_at` can be `null`.

**`Video.file_path` is display/debug only.** It is the phone's path, not a path on the desktop.
Bytes are always obtained through `/files/{video_id}/...`.

## GET /videos query parameters

```text
search, channel_id, status, kind, watched, sort, order, page (>=1), page_size (1..200, default 50)

sort:  published_at | created_at | title | file_size | duration | id
order: asc | desc
```

## File transfer contract

```text
GET /api/v1/files/{video_id}/metadata
  -> { video_id, filename, size_bytes, mime_type, quality, quality_height,
       duration, modified_at, supports_ranges }
  -> 404 when the video has no downloaded file (handled gracefully)

GET /api/v1/files/{video_id}/download    Content-Disposition: attachment, supports Range
GET /api/v1/files/{video_id}/stream      inline playback, supports Range
  Accept-Ranges: bytes
  200 full | 206 partial (success, not an error)
  416 with Content-Range: bytes */<size> when the range is unsatisfiable
```

Client rules: preflight with `/metadata` before allocating anything; always send
`Authorization: Bearer`; treat 206 as success; never construct a filesystem path from a response
(the server rejects anything escaping the media dir with `invalid_path`); the destination always comes
from the native save dialog.

## Error shape

Every non-2xx response — auth, routing, framework and domain alike:

```json
{ "error": { "code": "not_found", "message": "video not found", "details": null } }
```

There are **no** bare FastAPI `{"detail": ...}` responses any more, so reading `error.code` is always
safe. `401` also carries `WWW-Authenticate: Bearer`.

Codes this client handles explicitly:

| Code | Status | Client behaviour |
| --- | --- | --- |
| `missing_token` | 401 | Prompt for a token; explain how to mint one on the phone. |
| `invalid_token` | 401 | Say the token was rejected or revoked, not "wrong address". |
| `invalid_sub_langs` | 400 | Blocked client-side before sending; shows why `*` is rejected. |
| `not_retryable` | 400 | The job is not in a retryable state — disable Retry. |
| `not_cancellable` | 400 | The job already started downloading — disable Cancel. |
| `invalid_path` | 400 | The server refused a path outside its media directory. |
| `method_not_allowed` | 405 | Wrong verb for that endpoint. |
| `empty_import` / `unparseable_import` | 400 | CSV import rejected (binary data, bare CRs, oversized fields). |
| `validation_error` | 422 | Field errors mapped onto form fields. |
| `not_found`, `invalid_channel`, `invalid_video_id`, `invalid_quality`, `payload_too_large`, `channel_disabled`, `forbidden` | 400–409 | Message surfaced verbatim. |

The client always surfaces `error.message` plus a short actionable hint derived from the code.

## Filters are validated

Bad query values return **422** instead of silently returning an empty list:

```text
sort=DROP  → 422      status=nope → 422      import/xml → 422
```

This is why the client only ever sends values from the documented enums, and maps 422 field errors
onto the offending control rather than showing "no videos found".

## Quality settings are merged, not replaced

`PUT /quality` applies only the fields present in the body. Sending `{ "quality": "480p" }` leaves
`prefer_mp4`, `sub_langs`, concurrency and the rest untouched. This client relies on that: every
control sends only what changed, then re-reads `GET /quality` and displays the stored value.

Current `QualitySettings` fields:

```text
quality, prefer_mp4, embed_subs, sub_langs ("en.*"), embed_metadata,
embed_thumbnail, write_description, download_dir, max_concurrent_downloads
```

`sub_langs` is validated client-side: `*` is rejected by the server with `invalid_sub_langs`
because it makes yt-dlp fetch every subtitle track and breaks every download.

`download_dir` is an absolute path **on the phone**. Changing it no longer orphans existing files —
previously repointing it made every already-downloaded file return `400 invalid_path` and killed
playback and download entirely. The client validates it is absolute and traversal-free before sending.

## Deletion: preview first

Both delete endpoints accept `dry_run`:

```text
POST /videos/bulk-delete  {"video_ids":["a","b"], "delete_files": true, "dry_run": true}
  → {"deleted":0, "files_deleted":2, "files_missing":0, "errors":[]}
```

The client **always previews first**: opening the delete dialog runs a dry run, shows exactly how
many library records and how many files on the phone would go, and only sends the real request after
the user confirms. Nothing is destroyed before that confirmation.

`video_ids` accepts either the numeric row id or the YouTube `video_id` string (max 1000 per
request).

## File transfer contract

```text
GET /api/v1/files/{video_id}/metadata
  -> { video_id, filename, size_bytes, mime_type, quality, quality_height,
       duration, modified_at, supports_ranges }
  -> 404 when the video has no downloaded file (handled gracefully)

GET /api/v1/files/{video_id}/download    Content-Disposition: attachment, supports Range
GET /api/v1/files/{video_id}/stream      inline playback, supports Range
  Accept-Ranges: bytes
  200 full | 206 partial (success, not an error)
  416 with Content-Range: bytes */<size> when the range is unsatisfiable
```

`206` now carries **`Content-Range` and `Content-Length`**. Without them `<video>` and Media3 cannot
seek or scrub, which silently broke playback. The client validates both:

* `Content-Range` must start at the exact byte we requested — otherwise the partial file and the
  server disagree, so it restarts from zero instead of writing a corrupt file.
* `Content-Range` total overrides the metadata size if the file changed on the phone.
* `Content-Length` must equal `end - start + 1`.
* A transfer is complete only when the bytes on disk equal the declared total — no longer "at least".

`Content-Disposition` sends a percent-encoded `filename*=UTF-8''…`, which is what non-ASCII YouTube
titles require. The client takes the filename from `/files/{id}/metadata` (ASCII-sanitised
server-side) and re-sanitises it before touching the filesystem.

## Polling contract

No websocket/SSE exists — screens are pull-based.

| Screen | Calls | Interval |
| --- | --- | --- |
| Connectivity banner | `GET /health` | 5 s |
| Active download | `GET /queue/stats`, `GET /queue/{id}` | 1.5 s **only while active** |
| Library | `GET /videos` | 20 s, plus after every mutation |
| Channels | `GET /channels` | 25 s / on focus |
| Settings | `GET /quality`, `GET /monitor`, `GET /retention` | on open and after every write |

The client never calls `POST /monitor/scan` on a timer — the server scans on its own interval.

## Server-side schema gaps (reported by `npm run verify-contract`)

The client validates itself against the live schema on every run. Three things are implemented by
the server but **not declared in `/openapi.json`**, so codegen clients cannot discover them:

1. `GET /files/{video_id}/download` and `/stream` implement `206 Partial Content` (with
   `Content-Range` and `Content-Length`) but the schema documents only `200/400/401/403/404/416/422`.
   Adding a `206` response with its headers would let generated clients know seeking is supported.
2. `GET /storage` returns `additionalProperties: true` — `orphaned_bytes` and the watched/unwatched
   split are invisible to codegen. A `StorageInfo` schema would fix it.
3. `GET /retention` also returns `additionalProperties: true` — `delete_file_when_watched`,
   `retention_days` and `max_library_items` are undeclared.

The client handles all three defensively: it reads the fields if present and degrades cleanly when
they are not (the storage breakdown only renders when all three numbers arrive).

## Other client-side notes

Two behaviours are expressed using documented parameters because no dedicated one exists:

1. **`GET /videos` has no `published_after` / date-range parameter.** The library therefore offers
   date *sorting* (newest/oldest) rather than an absolute date-range filter. The publication *window*
   is a server-side monitoring setting (`MonitorSettings.window_hours`). If an absolute date filter is
   wanted, add `published_after` / `published_before` query params to `GET /videos` and this client
   will wire them up — the client will not invent them.
2. **`QueueStats` has no `discovered` counter**, so the "New" library view is expressed with the
   documented combination `watched=false` sorted by `published_at desc` rather than a dedicated
   parameter.

## Acquisition notes

The server uses the YouTube Data API v3 / channel feeds for discovery and yt-dlp for formats and
retrieval. The YouTube Data API is **not** a general-purpose video-file download API. Not every video
is downloadable and not every resolution exists; unavailable/private/restricted/removed/DRM-protected
videos get the `unavailable` state and are never retried. This client does not bypass DRM or any
access control, and only handles content the user's rights permit.