# YTMon Desktop

An Electron desktop client for the **Termux YouTube Monitor** — the FastAPI server that runs on your
Android phone. The server is the single source of truth for channels, videos, download jobs, quality
settings and watched status. This app is a *client*: it does not implement monitoring or downloading.

```
┌───────────────────────────┐         HTTP + Bearer token        ┌──────────────────────────────┐
│  Electron (this app)      │  ───────────────────────────────▶  │  FastAPI server (Termux)     │
│  main: API + file writes   │   192.168.1.100:8765/api/v1        │  yt-dlp, FFmpeg, SQLite      │
│  preload: narrow bridge    │                                      │  scheduler, media library    │
│  renderer: UI only        │  ◀────────────────────────────────  │                              │
└───────────────────────────┘        /files/{id}/stream|download    └──────────────────────────────┘
```

## Check the real server first

The server lives at **`http://192.168.1.100:8765`** (this app's default). Before launching the UI,
run the read-only diagnostic — it tells you *why* something is wrong instead of guessing:

```bash
npm run check-server                                   # no token (loopback / LAN off)
npm run check-server -- http://192.168.1.100:8765 TOK # with a token (LAN mode on)
```

It probes TCP, `/health`, `/server/info`, `/quality/options`, `/queue/stats`, `/videos`, file
metadata and a real `Range` request, and checks the responses against the documented contract
(9 quality options, `QueueStats` keys, `Video` fields). It never writes anything.

### The token is stored for you

You only paste the token once.

* **Linux** — the app enables Electron's `gnome-libsecret` password store when a
  `gnome-keyring-daemon` is present (detected by what is installed, not by desktop
  name, so Hyprland/sway sessions work too). The token goes into the OS keyring.
* **macOS / Windows** — stored in Keychain / Credential Manager via `safeStorage`.
* **No keyring at all** — the token is encrypted with AES-256-GCM using a random
  machine-local key file (mode `0600`) beside the config. It is never written in
  plain text, but it protects the config file rather than someone who can already
  read your home directory.
* **This session only** — skips all of the above; you re-paste next launch.

The UI states which of these is in effect rather than making you guess. On launch it
decrypts the stored token, reconnects, and only shows the pairing screen if that
actually fails.

### Current status from this machine

```text
host 192.168.1.100 answers ping (same /24 subnet)
TCP 192.168.1.100:8765 → ECONNREFUSED
```

That is the documented "server is up but bound to loopback" case, not a client bug. On the phone:

1. Start the server (`./run.sh`).
2. Enable **LAN mode** so it binds the phone's LAN IP instead of `127.0.0.1`.
3. Confirm the address with `./scripts/lan-address.sh` (it changes when the phone joins a new Wi-Fi).
4. Re-run `npm run check-server`.

## Quick start

```bash
npm install
npm run dev          # vite dev server + esbuild watch + electron
# or
npm start            # production build, then electron
```

On first launch you are asked for:

1. **Server address** — default `http://192.168.1.100:8765`. The phone's IP changes when it joins a
   different Wi-Fi network, so it is a setting and is never hardcoded.
2. **Access token** — only needed when the phone has LAN mode enabled. Create it *on the phone*:
   open `http://127.0.0.1:8765/docs` → `POST /tokens` → label it → copy the `token` value.
   Token minting and revocation are localhost-only on the server by design, so this client cannot
   create one remotely.

Test connectivity from a desktop shell before touching the UI:

```bash
curl http://192.168.1.100:8765/api/v1/health
```

## What the app does

| Screen | Highlights |
| --- | --- |
| **Library** | All / New / Unwatched / Watched / Downloading / Completed / Failed / **Not downloaded** views, Shorts/regular/all filters, search, sorting, channel filter, pagination, shift-click multi-select, bulk delete, in-app player with seeking. Discovered-but-not-downloaded uploads get a one-click **Get**. |
| **Downloads** | The phone's queue (queued/downloading/completed/failed/skipped/unavailable), per-job progress and ETA, and separately the files moving to *this* computer with progress, cancel and resume. |
| **Channels** | Add / enable / pause / scan / remove, per-channel quality overrides, and **Add in bulk** — paste a subscriptions list (URLs, @handles, bare UC ids, a Takeout CSV) or import a file. |
| **Auto / Manual + schedules** | Per-channel **Auto ↔ Manual** toggle and a download schedule (weekday chips + 24h time picker). Multi-select any number of channels for **Make automatic** / **Make manual** / **Set schedule**. Manual channels are still *discovered* — they just are never auto-downloaded. Due state is read from the server (`due_now` / `next_due`), never computed on the client. |
| **Import subscriptions** | Paste a Google Takeout `subscriptions.json` (the default — needs nothing configured on the phone) or import from your YouTube feed via the server's cookies. Shows imported / updated / skipped counts, the "last imported … from takeout" line, and explains up front that the feed option needs `YTMON_COOKIES_FILE` when cookies are missing. Imported channels arrive **manual**, so a 300-channel import doesn't start 300 downloads. |
| **Files** | The library as the phone stores it: folders → subfolders → items from `GET /library/tree`, with an order selector and a per-folder item limit. Shows *"showing N of M"* when a folder is truncated. |
| **Playlists** | Subscribe to playlists and Watch Later, live per-source counts ("13 of 19 downloaded, 6 failed"), a per-source quality **and** Video/Audio override that beats the global setting, manual scans, and an explicit explanation when Watch Later is empty because cookies are not set. |
| **Fetch a link** | Paste any video/playlist/channel link. Always previews first (`download:false`) so nothing is queued by surprise, then confirms. Duplicates and unavailable items are shown, never dropped. |
| **Settings** | Connection + token, quality (all 9 values from `/quality/options`), container/subtitle/metadata/thumbnail/description options, subtitle language filter, phone download directory and concurrency, monitoring interval and publication window, retention and delete-after-watch, phone storage with a watched/unwatched/orphaned breakdown. |
| **Connection** | Reachability, health status, server versions, bind mode, and troubleshooting hints. |

## Architecture

```
src/
  main/        Electron main process — the ONLY place with Node, network and fs
    index.ts     window creation, security hardening, IPC handlers, media protocol
    api.ts       YtmonApi — one typed client for the documented REST contract
    transfers.ts streaming pull with HTTP Range resume, progress and cancellation
    media.ts     ytmon-media:// protocol — streams with auth, no token in the renderer
    share.ts     platform-specific share behaviour (Windows/macOS/Linux)
    settings.ts  settings.json + OS keychain (safeStorage) for the token
  preload/     contextBridge surface — narrow, validated, nothing else
  shared/      types mirrored from the OpenAPI schema, error shape, quality semantics
  renderer/    React UI: design system, screens, state
tests/         vitest: API client, quality semantics, transfers, cross-client consistency
```

### Security posture

- `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true`.
- The renderer never performs network I/O and never holds the bearer token. All requests go through
  main process over IPC; every IPC payload is re-validated in main (video ids, channel ids, tokens,
  numeric ranges, absolute-path checks).
- Playback streams through the `ytmon-media://` custom protocol, which injects `Authorization`
  server-side and forwards `Range` headers. The URL carries only a video id — no filesystem path.
- The token is encrypted with the OS keychain via Electron `safeStorage`. If no keychain is
  available the token is **refused** rather than written to disk in plain text.
- Destination paths always come from the native save dialog; paths from API responses are never used
  for writes, and server-supplied filenames are re-sanitised.
- The renderer CSP forbids remote script/connect; `window.open` is denied and external links open in
  the user's browser.
- Report crashes and IPC errors to the server's `POST /logs` so failures are visible from Android.

## Quality settings (a ceiling, not a promise)

`GET /quality/options` returns the shared option list and the server's active default. The dropdown is
populated from it so both clients stay identical:

```
144p  240p  360p  480p  720p  1080p  1440p  2160p  best
```

- Every resolution is a **maximum permitted video height**. `720p` means "720p or lower".
- If nothing exists at or below the ceiling the job fails with a clear error — it never silently jumps
  higher. `best` is the only unbounded option.
- After download, `Video.quality` is what was requested and `Video.quality_height` is what was
  actually obtained. **The UI shows `quality_height` as "what you have".**
- Per-channel overrides (`Channel.quality_override`) win over the global setting.
- yt-dlp inspects available formats; separate streams are merged when FFmpeg is present on the phone.

## Sharing: URL and file are different things

| Action | Requires | Implementation |
| --- | --- | --- |
| **Share URL** — open the original on YouTube | nothing | `https://www.youtube.com/watch?v=<video_id>`; no server call, no file implied. |
| **Copy link** | nothing | Clipboard copy of the same URL. |
| **Save to this computer** | `status == completed` and a file exists | `GET /files/{id}/metadata` (preflight) → native save dialog → `GET /files/{id}/download` streamed to disk with `Range` resume. |
| **Share file** | a completed transfer on this computer | Windows: Explorer select file · macOS: reveal in Finder · Linux: open the folder. There is no generic OS share sheet on desktop, so **Save to this computer is the reliable fallback everywhere.** |

## Subtitle languages

`sub_langs` is validated before it is sent. The server rejects `*` with `400 invalid_sub_langs`
because it makes yt-dlp fetch every subtitle track and breaks every download — the client blocks it
inline and explains why, and surfaces the server's error if one still arrives.

## File transfer: how resume works

1. Preflight `GET /api/v1/files/{video_id}/metadata` for the real size and a safe filename.
2. Open the native save dialog — the destination always comes from the user.
3. Stream to `<destination>.part`, emitting progress after each chunk.
4. If the connection drops or the user cancels, the partial file is **flushed**, not discarded.
5. Retry requests `Range: bytes=<bytes-already-on-disk>-`.
   * `206` → verify `Content-Range` starts at exactly that offset and `Content-Length` matches
     `end - start + 1`, then append. A mismatch means the file changed on the phone, so it restarts
     rather than writing a corrupt file.
   * `200` → the server ignored the Range; truncate and start clean so the file cannot corrupt.
   * `416` → the partial is stale; delete it and restart from zero.
6. On success the partial file is renamed to the destination. The file is complete only when the
   bytes on disk **equal** the declared total — both are needed for `<video>` seeking to work.

Transfers run at most `maxParallelTransfers` at a time (independent of the phone's own download
concurrency).

## Synchronisation

There is no websocket or SSE. Screens are pull-based, and every mutating call is followed by a
re-fetch of the affected list:

| What | Cadence |
| --- | --- |
| Health banner | `GET /health` every 5 s |
| Library list | `GET /videos` every 20 s, plus after every mutation and on refresh |
| Active jobs | `GET /queue/{video_id}` every 1.5 s **only while** something is downloading/queued |
| Channels | every 25 s |
| Settings | read on open; re-read after every write |

The server never caches settings authoritatively on the client: after a write the client re-reads and
shows the stored value, because the Android app may have written concurrently (last-write-wins).

## Status handling

| Status | UI behaviour |
| --- | --- |
| `discovered` | Found by discovery but **not downloaded** — the resting state of a manual channel, or of one that is not due yet. Labelled *"Found by discovery — not downloaded yet"* with a one-click **Get** to fetch it. No file actions (there is no file yet). |
| `queued` / `downloading` | Progress + speed + ETA; unqueue/cancel allowed where the server permits. |
| `completed` | Save / play / share file available. |
| `failed` | `error_message` shown plus a **Retry** button. |
| `unavailable` | "Not available (private, removed, or restricted)". **No Retry** — this is permanent and not the user's error. |
| `skipped` | Neutral label. |

## Deletion semantics

Deleting is always a **two-step**: preview, then confirm.

1. Opening the delete dialog sends a **dry run** (`dry_run=true`) and shows how many library records
   and how many files on the phone would be erased. Nothing is touched.
2. Only after you confirm does the real request go out.

So you always see "this erases N files" before it happens, and nothing can be destroyed by a stray
click or a typo in a batch.

- `DELETE /videos/{id}?delete_file=&dry_run=` and `POST /videos/bulk-delete {video_ids, delete_files, dry_run}`.
- `video_ids` accepts either the numeric row id or the YouTube `video_id` string.
- The database row is always removed; the file is removed only when the flag is true.
- Results report `deleted`, `files_deleted`, `files_missing` and `errors[]` — a missing file is not an error.
- The server refuses to delete anything outside its media directory and reports it in `errors[]`.
- Settings are written as **partial updates**: the server merges only the fields you send, so
  changing one toggle never resets the others. The client re-reads after every write.
- Bulk deletion always requires an explicit confirmation dialog that states whether files are erased.
- **Delete-after-watch is off by default.** Enabling it requires a real confirmation dialog stating
  that the file is permanently erased when you finish watching; when on, marking a video watched
  deletes the file but keeps the library row.

## Local network notes

- Bind the server to the LAN **on the phone** (`0.0.0.0`) for remote access. The default `127.0.0.1`
  binding will refuse connections from the desktop — connection refused usually means exactly this.
- Both devices must be on the same subnet and **not** on a guest/isolated Wi-Fi (AP/client isolation
  is the most common cause of "unreachable").
- Never port-forward the server to the public internet. Require a token for remote clients and
  revoke tokens from the phone when needed.
- Android: exempt Termux from battery optimisation, and grant storage access (`termux-setup-storage`)
  so downloads can be written.
- macOS: the packaged app allows local-network cleartext HTTP (`NSAllowsLocalNetworking`) so a LAN
  address over `http://` works; Windows and Linux have no equivalent restriction.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Watch build + Vite dev server + Electron. |
| `npm run build` | Build main/preload (esbuild) and the renderer (Vite). |
| `npm start` | Build, then run Electron. |
| `npm run typecheck` | Type-check renderer and main separately. |
| `npm test` | Run the vitest suite. |
| `npm run package` | Package for the current platform. |
| `npm run package:linux` / `:win` / `:mac` | Package for a specific platform. |

See [`docs/BUILD.md`](docs/BUILD.md) for cross-platform build instructions and
[`docs/API.md`](docs/API.md) for the endpoints and models this client depends on.
## Keep permanently (pin)

A pinned video survives **all** automatic deletion — delete-after-watch, `retention_days` and
`max_library_items`. An explicit manual Delete still removes it.

- 📌 on a library row toggles it; shift-click a range then **Pin selected** for many at once.
- Pinned cards get a warning-coloured border and a `📌 Pinned` badge.
- The library shows a **"N pinned"** count, so it is obvious *why* something was never cleaned up.
- Settings shows the same reason when the retention preview excludes items.

Retention is **never** applied without an explicit confirmation showing the real count:

1. `GET /retention/preview` → "N completed · M would be deleted · X would be freed" (deletes nothing).
2. **Dry run** calls `POST /retention/apply` — the server defaults `dry_run=true`, so it only counts.
3. **Apply retention now** is behind a confirmation dialog, then sends `dry_run=false`.

## Storage layout (where new files land)

`PUT /library/settings` is a **merge**, so every control sends only the field you changed and the
response is re-read — nothing else resets.

| Layout | Path on the phone |
| --- | --- |
| `channel_id` | `media/<UCxxxx>/<id>.ext` (default, rename-safe) |
| `channel_title` | `media/<Channel Name>/<id>.ext` |
| `channel_source` | `media/<Channel>/<Playlist|video>/<id>.ext` |
| `flat` | `media/<id>.ext` |

Existing files are **not** moved — only new downloads follow the layout. A known gap: `channel_title`
is null for videos whose channel was never added (e.g. playlist-sourced items), which fall back to the
raw `UC…` id; the browser marks those folders *"id only"*.

## Media types: video and audio

The server stores either a video file or an audio-only MP3 with embedded cover art, and reports
which via `Video.media_type`.

- The player and every card branch on **`media_type`**, never on the file extension. Audio plays in
  an `<audio>` element with cover art; video plays in a `<video>` one.
- `/files/{id}/metadata` reports `mime_type` (`audio/mpeg` for MP3s) — used as-is, never hardcoded.
- Settings has a **Video / Audio** global toggle (`PUT /quality {"media_type": "audio"}`).
- Per-source overrides on the Playlists screen carry both `quality` and `media_type`, and win over
  the global setting.
- MP3s save and share through exactly the same `/files/{id}/download` path — one code path.

## Thumbnails

`Video.thumbnail_url` points at YouTube and does not load on an offline phone, and a plain `<img>`
cannot send a bearer token. Thumbnails are loaded through the authenticated
`ytmon-media://thumb/<video_id>` proxy, which calls `GET /videos/{id}/thumbnail` and handles all
three documented responses: `200` (server-cached bytes), `307` (nothing cached yet) and `404` (no
image) — the last two render a placeholder instead of a broken image.

## Adding a channel (and why it sometimes finds nothing)

Always add using the **canonical `/channel/UC…` URL**. If you paste an `@handle`, the server stores
`channel_id = "@handle"` while discovered videos carry the canonical `UC…` id — so every scan returns
`{discovered: 0, filtered: N}` and the channel silently finds nothing. The Add dialog resolves the
handle first and submits the canonical URL for you.

Two independent things can make a scan return nothing, and the app now explains both:

1. **Handle vs canonical id** — fixed above.
2. **The publication window** — the server only considers videos published within
   `MonitorSettings.window_hours` (yours is 24). A channel that uploads weekly will always come back
   empty. The app says so explicitly and points at Settings → Monitoring; widening it to 720h turned
   the same scan into `discovered: 4, queued: 4`.

## Verification

```bash
npm run verify      # typecheck + lint + unit tests + end-to-end smoke test
npm test            # 67 unit tests (vitest)
npm run smoke       # real Electron app against a fake Termux server
npm run screenshots # renders every screen to release/screenshots/*.png
```

| Suite | Covers |
| --- | --- |
| `tests/api.test.ts` | URL validation, filename safety, bearer token on every request, error envelope, query mapping, 401 handling. |
| `tests/quality.test.ts` | Exactly 9 quality values in order, ceiling semantics, fallback when a resolution is missing, no silent upgrade, state labels, `unavailable` never retryable. |
| `tests/transfers.test.ts` | Authenticated streaming download, real size from metadata, progress monotonicity, `Range: bytes=N-` resume, 200-vs-206 handling, cancellation keeping a valid partial, parallel limit, no stray files. |
| `tests/consistency.test.ts` | Two clients sharing one server: quality writes, watched flags, deletions, delete-after-watch, dedupe, 401 on protected and destructive endpoints, library query mapping, media scheme. |
| `tests/renderer.test.tsx` | Connection screen validation and probing, app shell rendering, 401 prompting a token, error boundary. |
| `scripts/smoke.mjs` | Launches the real Electron build against a fake server and exercises the vertical slice end to end. |
| `scripts/screenshots.mjs` | Drives the running app over the DevTools protocol and captures each screen. |
| `scripts/e2e-live.mjs` | **Against the real server**: pairs the real app with a real token, adds a channel through the UI, and scans it. Run with `YTMON_TOKEN=<token>`. |
| `scripts/verify-contract.mjs` | Compares the client's mirrored types against the live `/openapi.json` and reports server-side schema gaps. |
| `scripts/e2e-features.mjs` | **Against the real server**: media types, sources, fetch-by-link preview, retry semantics, thumbnails, error shape, 401. |
| `scripts/debug-stream.mjs` | Proves playback: video vs audio element, thumbnail proxy, and that seeking round-trips. |
| `scripts/check-server.mjs` | Read-only diagnosis of a server by address. |
