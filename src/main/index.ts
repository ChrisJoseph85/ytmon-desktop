import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { YtmonApi } from './api';
import { shareFile, shareUrl } from './share';
import { publicSettings, readToken, saveSettings, setServerUrl, useLoopback, writeToken, loadSettings } from './settings';
import { TransferService, type TransferSnapshot } from './transfers';
import { toYtmonError, YtmonError } from '../shared/errors';
import { registerMediaProtocol, registerMediaSchemePrivileges } from './media';
import { fail, ok, type Result } from '../preload/types';
import { sanitizeFilename } from '../shared/format';
import { isQualityValue } from '../shared/quality';
import { isChannelKey, isChannelMode, isScheduleDay, normaliseDays, validateScheduleTime } from '../shared/schedule';
import type { ChannelPolicyUpdate, SourceQualityOverride } from '../shared/types';

// Dev mode is opt-in (npm run dev sets YTMON_DEV=1). Otherwise the built
// renderer is loaded from disk, so `npm start` works without a dev server.
const isDev = process.env.YTMON_DEV === '1';
const DEV_URL = 'http://localhost:5273';

let win: BrowserWindow | null = null;
let api: YtmonApi;
let transfers: TransferService;

function currentApi(): YtmonApi {
  const s = loadSettings();
  return new YtmonApi({ baseUrl: s.serverUrl, token: readToken() });
}

function broadcast(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: '#0e1015',
    title: 'YTMon Desktop',
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs require('electron')
      webSecurity: true,
      spellcheck: false,
    },
  });

  win.removeMenu?.();
  if (process.platform === 'darwin') Menu.setApplicationMenu(buildMenu());

  // Hardening: no new windows, no in-app navigation away, external links open
  // in the user's browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    const allowed = isDev && url.startsWith(DEV_URL);
    if (!allowed) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });

  win.webContents.on('did-finish-load', () => console.log('ytmon: window ready'));
  win.webContents.on('render-process-gone', (_e, details) =>
    console.error(`ytmon: renderer gone (${details.reason})`),
  );
  win.webContents.on('preload-error', (_e, preloadPath, error) =>
    console.error(`ytmon: preload failed (${preloadPath}): ${error.message}`),
  );

  if (isDev) {
    void win.loadURL(DEV_URL);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

function buildMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        {
          label: 'Save Video to This Computer…',
          accelerator: 'CmdOrCtrl+S',
          click: () => broadcast('menu:save-video', null),
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  return Menu.buildFromTemplate(template);
}

/** Wraps a handler so errors cross IPC as the app's error shape. */
function handle<T>(channel: string, fn: (...args: never[]) => Promise<T> | T): void {
  ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<Result<T>> => {
    try {
      // Refuse anything not coming from our own window.
      if (win && event.sender !== win.webContents) throw new YtmonError('Forbidden', 'forbidden');
      return ok(await fn(...(args as never[])));
    } catch (e) {
      const y = toYtmonError(e);
      api?.reportClientError('ERROR', 'ipc', `${channel}: ${y.message}`);
      // YtmonError carries an actionable hint for the documented error codes;
      // it rides along so the UI can say what to do next.
      return fail({ ...y.toJSON(), message: y.message, hint: y.hint });
    }
  });
}

/** Per-source override: only `quality` and `media_type` are accepted. */
function normaliseOverride(input: unknown): SourceQualityOverride | null {
  if (input === null) return null;
  const o = (input ?? {}) as Record<string, unknown>;
  const out: SourceQualityOverride = {};
  if (isQualityValue(o.quality)) out.quality = o.quality;
  if (o.media_type === 'audio' || o.media_type === 'video') out.media_type = o.media_type;
  return Object.keys(out).length > 0 ? out : null;
}

function validateVideoId(id: unknown): string {
  if (typeof id !== 'string' || id.length < 1 || id.length > 64 || !/^[\w-]+$/.test(id)) {
    throw new YtmonError('Invalid video id', 'invalid_video_id');
  }
  return id;
}

function validateChannelId(id: unknown): string {
  if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id)) {
    throw new YtmonError('Invalid channel id', 'invalid_channel');
  }
  return id;
}

/** A snapshot id is an opaque server-issued token: digits, uuid or slug. */
function validateSnapshotId(id: unknown): string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    throw new YtmonError('Invalid snapshot id', 'validation_error');
  }
  return id;
}

/**
 * Policy paths take the channel KEY — a canonical "UC…" id or an "@handle" —
 * never the numeric row id. A numeric id would silently address a different
 * channel (or nothing) with no error, so it is refused here.
 */
function validateChannelKey(id: unknown): string {
  if (!isChannelKey(id)) {
    throw new YtmonError('Use the channel id (UC…) or its @handle, not the numeric row id.', 'invalid_channel');
  }
  return id.trim();
}

/**
 * Whitelists the policy fields before they cross the boundary. `undefined`
 * keys are dropped so a PATCH never clears something the user did not touch —
 * the server treats a present key as "set this".
 */
function policyPatch(body: unknown): ChannelPolicyUpdate {
  const b = (body ?? {}) as Record<string, unknown>;
  const patch: ChannelPolicyUpdate = {};
  if (b.mode !== undefined) {
    if (!isChannelMode(b.mode)) throw new YtmonError('Mode must be "auto" or "manual".', 'invalid_mode');
    patch.mode = b.mode;
  }
  if (b.schedule_enabled !== undefined) {
    if (typeof b.schedule_enabled !== 'boolean') {
      throw new YtmonError('schedule_enabled must be true or false.', 'validation_error');
    }
    patch.schedule_enabled = b.schedule_enabled;
  }
  if (b.schedule_days !== undefined) {
    const raw = b.schedule_days;
    if (!Array.isArray(raw)) throw new YtmonError('schedule_days must be a list of weekdays.', 'invalid_schedule_days');
    // Seven unique days is the whole domain; a huge array here is a bug or an
    // attack, and normaliseDays would walk all of it before collapsing to 7.
    if (raw.length > 7) {
      throw new YtmonError('schedule_days accepts at most the 7 weekdays.', 'invalid_schedule_days');
    }
    for (const d of raw) {
      if (typeof d !== 'string' || !isScheduleDay(d)) {
        throw new YtmonError(`"${String(d)}" is not a weekday. Use mon..sun.`, 'invalid_schedule_days');
      }
    }
    // Monday-first, de-duplicated: [] legitimately means "every day".
    patch.schedule_days = normaliseDays(raw);
  }
  if (b.schedule_time !== undefined) {
    const t = b.schedule_time;
    if (t === null) patch.schedule_time = null;
    else if (typeof t !== 'string') {
      throw new YtmonError('schedule_time must be HH:MM (24h), or null.', 'invalid_schedule_time');
    } else {
      const v = validateScheduleTime(t);
      if (!v.ok || v.normalized === null) {
        throw new YtmonError('schedule_time must be HH:MM (24h), or null.', 'invalid_schedule_time');
      }
      patch.schedule_time = v.normalized;
    }
  }
  return patch;
}

function validateToken(token: unknown): string | null {
  if (token === null) return null;
  if (typeof token !== 'string' || token.length < 8 || token.length > 512 || !/^[\w.-]+$/.test(token)) {
    throw new YtmonError('That token looks malformed.', 'invalid_token');
  }
  return token;
}

function registerIpc(): void {
  const A = () => (api ??= currentApi());

  // ---- settings --------------------------------------------------------
  handle('settings:get', () => publicSettings());
  handle('settings:serverUrl', (url: unknown) => {
    const r = setServerUrl(String(url ?? ''));
    if (!r.ok) throw new YtmonError(r.reason ?? 'Invalid URL', 'invalid_server_url');
    api = currentApi();
    return publicSettings();
  });
  handle('settings:token', (token: unknown, persist: unknown) => {
    const r = writeToken(validateToken(token), persist !== false);
    if (!r.ok) throw new YtmonError(r.reason ?? 'Could not store the token', 'keychain_unavailable');
    api = currentApi();
    return publicSettings();
  });
  handle('settings:preferences', (prefs: Record<string, unknown>) => {
    const next: Record<string, unknown> = {};
    if (typeof prefs.lastDownloadDir === 'string' || prefs.lastDownloadDir === null) {
      next.lastDownloadDir = prefs.lastDownloadDir;
    }
    const parallel = Number(prefs.maxParallelTransfers);
    if (Number.isFinite(parallel) && parallel >= 1 && parallel <= 6) next.maxParallelTransfers = Math.floor(parallel);
    const poll = Number(prefs.pollIntervalMs);
    if (Number.isFinite(poll) && poll >= 1000 && poll <= 120_000) next.pollIntervalMs = Math.floor(poll);
    if (prefs.theme === 'system' || prefs.theme === 'dark' || prefs.theme === 'light') next.theme = prefs.theme;
    saveSettings(next);
    transfers.setMaxParallel(loadSettings().maxParallelTransfers);
    return publicSettings();
  });
  handle('settings:useLoopback', () => {
    useLoopback();
    api = currentApi();
    return publicSettings();
  });

  // ---- read-only api ---------------------------------------------------
  handle('api:health', () => A().health());
  handle('api:serverInfo', () => A().serverInfo());
  handle('api:storage', () => A().storage());
  handle('api:qualityOptions', () => A().qualityOptions());
  handle('api:getQuality', () => A().getQuality());
  handle('api:listChannels', (enabled?: unknown) =>
    A().listChannels(enabled === true || enabled === false ? enabled : undefined));
  handle('api:listSubscriptions', (mode?: unknown) => {
    // Dropping a bad mode to "no filter" would silently return ALL channels,
    // which reads as "the filter is broken". Say what was wrong instead.
    if (mode !== null && mode !== undefined && !isChannelMode(mode)) {
      throw new YtmonError('mode must be "auto" or "manual".', 'invalid_mode');
    }
    return A().listSubscriptions(isChannelMode(mode) ? mode : undefined);
  });
  handle('api:subscriptionsStatus', () => A().subscriptionsStatus());
  handle('api:importSubscriptions', (body: unknown) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const source = b.source === 'feed' ? 'feed' : b.source === 'takeout' ? 'takeout' : null;
    if (!source) throw new YtmonError('Choose a source: Takeout or feed.', 'validation_error');
    if (source === 'feed') {
      // The feed source reads YouTube with the phone's cookies. Checked here
      // so the user gets the real reason instead of a bare 400 import_failed.
      return A()
        .subscriptionsStatus()
        .then((status) => {
          if (!status.cookies_configured) {
            throw new YtmonError(
              'The server has no YouTube cookies, so it cannot read your subscription feed.',
              'import_failed',
            );
          }
          return A().importSubscriptions({ source });
        });
    }
    // Only a string may be pasted. Coercing with String() would turn a number
    // or object into "12345"/"[object Object]" and forward that to the server,
    // which answers 400 invalid_takeout — a far worse error than a local one.
    if (b.data !== undefined && typeof b.data !== 'string') {
      throw new YtmonError('Paste the raw text of subscriptions.json.', 'invalid_takeout');
    }
    const data = String(b.data ?? '');
    if (!data.trim()) {
      throw new YtmonError('Paste the contents of your Takeout subscriptions.json first.', 'data_required');
    }
    // The server caps the body at 5 MB; refuse early with a readable reason.
    // Measured in bytes, because that is what the server counts.
    if (Buffer.byteLength(data, 'utf8') > 5_000_000) {
      throw new YtmonError('That paste is over 5 MB. Import a shorter list.', 'payload_too_large');
    }
    return A().importSubscriptions({ source: 'takeout', data });
  });
  handle('api:subscriptionSnapshot', (id: unknown) => A().subscriptionSnapshot(validateSnapshotId(id)));
  handle('api:getMonitor', () => A().getMonitor());
  handle('api:listVideos', (q: unknown) => A().listVideos((q ?? {}) as Record<string, never>));
  handle('api:getVideo', (id: unknown, formats?: unknown) =>
    A().getVideo(validateVideoId(id), formats === true));
  handle('api:queueStats', () => A().queueStats());
  handle('api:job', (id: unknown) => A().job(validateVideoId(id)));
  handle('api:getRetention', () => A().getRetention());
  handle('api:fileMeta', (id: unknown) => A().fileMeta(validateVideoId(id)));
  handle('api:listTokens', () => A().listTokens());
  handle('api:resolveChannel', (url: unknown) => {
    const u = String(url ?? '').trim();
    if (!/^https?:\/\//i.test(u)) throw new YtmonError('Enter a channel URL or id.', 'invalid_channel');
    return A().resolveChannel(u);
  });

  // ---- mutations -------------------------------------------------------
  handle('api:setQuality', (body: unknown) => A().setQuality(body as never));
  handle('api:addChannel', (body: unknown) => A().addChannel(body as never));
  handle('api:updateChannel', (id: unknown, body: unknown) =>
    A().updateChannel(validateChannelId(id), body as never));
  handle('api:deleteChannel', (id: unknown) => A().deleteChannel(validateChannelId(id)));
  handle('api:scanChannel', (id: unknown) => A().scanChannel(validateChannelId(id)));
  // The policy fields live on their own endpoint; PATCH /channels/{id} does
  // not write them.
  handle('api:setChannelPolicy', (id: unknown, body: unknown) => {
    const patch = policyPatch(body);
    if (Object.keys(patch).length === 0) throw new YtmonError('Nothing to change.', 'validation_error');
    return A().setChannelPolicy(validateChannelKey(id), patch);
  });
  handle('api:bulkChannelPolicy', (body: unknown) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const raw = b.channel_ids;
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new YtmonError('Select at least one channel.', 'validation_error');
    }
    if (raw.length > 500) throw new YtmonError('Too many channels selected (max 500).', 'payload_too_large');
    const channelIds = [...new Set(raw.map(validateChannelKey))];
    const patch = policyPatch(b);
    if (Object.keys(patch).length === 0) throw new YtmonError('Nothing to change.', 'validation_error');
    return A().bulkChannelPolicy({ ...patch, channel_ids: channelIds });
  });
  handle('api:setMonitor', (body: unknown) => A().setMonitor(body as never));
  handle('api:scanNow', () => A().scanNow());

  // ---- fetch by link ---------------------------------------------------
  handle('api:fetchLink', (body: unknown) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const url = String(b.url ?? '').trim();
    if (!url) throw new YtmonError('Paste a link first.', 'invalid_url');
    if (url.length > 500) throw new YtmonError('That link is too long.', 'invalid_url');
    const mediaType = b.media_type === 'audio' || b.media_type === 'video' ? b.media_type : undefined;
    const limit = Number(b.limit);
    const priority = Number(b.priority);
    return A().fetchLink({
      url,
      download: b.download !== false,
      ...(mediaType ? { media_type: mediaType } : {}),
      ...(isQualityValue(b.quality) ? { quality: b.quality } : {}),
      ...(Number.isInteger(limit) && limit >= 1 && limit <= 50 ? { limit } : {}),
      ...(Number.isInteger(priority) && priority >= -10 && priority <= 10 ? { priority } : {}),
      thumbnail: b.thumbnail !== false,
    });
  });

  // ---- sources (playlists + Watch Later) -------------------------------
  handle('api:listSources', () => A().listSources());
  handle('api:getSource', (id: unknown) => A().getSource(String(id ?? '')));
  handle('api:createSource', (body: unknown) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const url = String(b.url ?? '').trim();
    if (!url) throw new YtmonError('Enter a playlist URL or "watch_later".', 'invalid_url');
    return A().createSource({
      url,
      ...(b.title ? { title: String(b.title) } : {}),
      enabled: b.enabled !== false,
      quality_override: normaliseOverride(b.quality_override),
    });
  });
  handle('api:updateSource', (id: unknown, body: unknown) => {
    const b = (body ?? {}) as Record<string, unknown>;
    return A().updateSource(String(id ?? ''), {
      ...(b.title !== undefined ? { title: b.title === null ? null : String(b.title) } : {}),
      ...(b.enabled !== undefined ? { enabled: b.enabled !== false } : {}),
      ...(b.quality_override !== undefined ? { quality_override: normaliseOverride(b.quality_override) } : {}),
    });
  });
  handle('api:deleteSource', (id: unknown) => A().deleteSource(String(id ?? '')));
  handle('api:scanSource', (id: unknown) => A().scanSource(String(id ?? '')));
  handle('api:scanAllSources', () => A().scanAllSources());
  handle('api:previewSource', (url: unknown) => {
    const u = String(url ?? '').trim();
    if (!u) throw new YtmonError('Enter a playlist URL or "watch_later".', 'invalid_url');
    return A().previewSource(u);
  });
  handle('api:sourcesStatus', () => A().sourcesStatus());

  // ---- retention --------------------------------------------------------
  handle('api:retentionPreview', () => A().retentionPreview());

  // ---- pin / keep permanently -------------------------------------------
  handle('api:setPinned', (id: unknown, pinned: unknown) =>
    A().setPinned(validateVideoId(id), pinned === true));
  handle('api:pinVideos', (ids: unknown, pinned: unknown) => {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new YtmonError('Select at least one video.', 'validation_error');
    }
    if (ids.length > 1000) throw new YtmonError('Too many videos selected (max 1000).', 'payload_too_large');
    return A().pinVideos(ids.map((raw) => {
      if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
      return validateVideoId(raw);
    }), pinned === true);
  });
  handle('api:listPinned', () => A().listPinned());

  // ---- library organisation --------------------------------------------
  handle('api:libraryLayouts', () => A().libraryLayouts());
  handle('api:librarySettings', () => A().librarySettings());
  handle('api:updateLibrarySettings', (body: unknown) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (b.media_layout === 'channel_id' || b.media_layout === 'channel_title' || b.media_layout === 'channel_source' || b.media_layout === 'flat') {
      patch.media_layout = b.media_layout;
    }
    if (b.tree_order === 'newest' || b.tree_order === 'oldest' || b.tree_order === 'title' || b.tree_order === 'duration') {
      patch.tree_order = b.tree_order;
    }
    if (b.retention_days === null || typeof b.retention_days === 'number') patch.retention_days = b.retention_days;
    if (b.max_library_items === null || typeof b.max_library_items === 'number') patch.max_library_items = b.max_library_items;
    if (typeof b.delete_file_when_watched === 'boolean') patch.delete_file_when_watched = b.delete_file_when_watched;
    // PUT is a merge, so only the keys we recognised are ever sent.
    if (Object.keys(patch).length === 0) throw new YtmonError('Nothing to change.', 'validation_error');
    return A().updateLibrarySettings(patch as never);
  });
  handle('api:libraryTree', (order: unknown, limit: unknown) => {
    const n = Number(limit);
    const validOrder = ['newest', 'oldest', 'title', 'duration'].includes(String(order)) ? (String(order) as 'newest') : undefined;
    return A().libraryTree(validOrder, Number.isInteger(n) && n >= 1 && n <= 1000 ? n : 200);
  });
  handle('api:applyRetention', (dryRun: unknown) => A().applyRetention(dryRun !== false));

  // ---- bulk channel import / export -----------------------------------
  const IMPORT_FORMATS = new Set(['csv', 'json']);

  handle('api:importChannels', (body: unknown, fmt: unknown, updateExisting: unknown) => {
    const format = String(fmt ?? 'csv');
    if (!IMPORT_FORMATS.has(format)) throw new YtmonError('Unsupported import format', 'validation_error');
    const text = String(body ?? '');
    if (!text.trim()) throw new YtmonError('Nothing to import.', 'empty_import');
    return A().importChannels(format as 'csv' | 'json', text, updateExisting !== false);
  });

  /** Native open dialog -> reads the file -> imports it. */
  handle('api:importChannelsFromFile', async (updateExisting: unknown) => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Import channels',
      properties: ['openFile'],
      filters: [
        { name: 'Channel lists', extensions: ['csv', 'json', 'txt'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (res.canceled || res.filePaths.length === 0) return { cancelled: true };

    const filePath = res.filePaths[0]!;
    // The path came from the user's own native dialog, not from the network.
    const name = path.basename(filePath).toLowerCase();
    const format = IMPORT_FORMATS.has(name.split('.').pop() ?? '')
      ? (name.split('.').pop() as 'csv' | 'json')
      : name.endsWith('.json')
        ? 'json'
        : 'csv';
    const text = fs.readFileSync(filePath, 'utf8');
    if (!text.trim()) throw new YtmonError('That file is empty.', 'empty_import');
    const result = await A().importChannels(format, text, updateExisting !== false);
    return { cancelled: false, format, result };
  });

  /** Native save dialog -> writes GET /channels/export/{fmt}. */
  handle('api:exportChannels', async (fmt: unknown) => {
    const format = String(fmt ?? 'json');
    if (!IMPORT_FORMATS.has(format)) throw new YtmonError('Unsupported export format', 'validation_error');

    const res = await dialog.showSaveDialog(win!, {
      title: 'Export channels',
      defaultPath: path.join(app.getPath('downloads'), `ytmon-channels.${format}`),
      filters: [format === 'csv' ? { name: 'CSV', extensions: ['csv'] } : { name: 'JSON', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePath) return { cancelled: true };

    const url = A().buildUrl(`/channels/export/${format}`);
    const r = await A().http(url, { headers: A().headers() });
    if (!r.ok) {
      const body = (await r.json().catch(() => null)) as { error?: { message?: string; code?: string } } | null;
      throw new YtmonError(body?.error?.message ?? `Export failed (${r.status})`, body?.error?.code ?? `http_${r.status}`, r.status);
    }
    const text = await r.text();
    fs.writeFileSync(res.filePath, text, 'utf8');
    return { cancelled: false, path: res.filePath, bytes: Buffer.byteLength(text) };
  });
  handle('api:setWatched', (id: unknown, watched: unknown) =>
    A().setWatched(validateVideoId(id), watched === true));
  handle('api:deleteVideo', (id: unknown, del: unknown, dryRun: unknown) =>
    A().deleteVideo(validateVideoId(id), del !== false, dryRun === true));
  /** Accepts the numeric row id OR the YouTube video_id, per the contract. */
  const deleteIds = (ids: unknown): (number | string)[] => {
    if (!Array.isArray(ids) || ids.length === 0) throw new YtmonError('Select at least one video.', 'validation_error');
    if (ids.length > 1000) throw new YtmonError('Too many videos selected (max 1000).', 'payload_too_large');
    return ids.map((raw) => {
      if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
      return validateVideoId(raw);
    });
  };
  handle('api:previewBulkDelete', (ids: unknown, del: unknown) =>
    A().previewBulkDelete(deleteIds(ids), del !== false));
  handle('api:bulkDelete', (ids: unknown, del: unknown, dryRun: unknown) =>
    A().bulkDelete(deleteIds(ids), del !== false, dryRun === true));
  handle('api:enqueue', (ids: unknown, priority?: unknown) => {
    if (!Array.isArray(ids) || ids.length === 0) throw new YtmonError('Select at least one video.', 'validation_error');
    return A().enqueue(ids.map(validateVideoId), typeof priority === 'number' ? priority : undefined);
  });
  handle('api:retry', (id: unknown) => A().retry(validateVideoId(id)));
  handle('api:cancelJob', (id: unknown) => A().cancelJob(validateVideoId(id)));
  handle('api:setRetention', (body: unknown) => A().setRetention(body as never));
  handle('api:createToken', (label: unknown) => A().createToken(String(label ?? 'desktop')));
  handle('api:revokeToken', (id: unknown) => {
    const n = Number(id);
    if (!Number.isInteger(n) || n < 1) throw new YtmonError('Invalid token id', 'validation_error');
    return A().revokeToken(n);
  });
  handle('api:reportError', (level: unknown, message: unknown) => {
    const l = level === 'ERROR' || level === 'WARNING' ? level : 'INFO';
    return A().reportClientError(l, 'desktop', String(message ?? '').slice(0, 1000));
  });

  // ---- files / transfer ------------------------------------------------
  handle('files:list', () => transfers.list());
  handle('files:cancel', (id: unknown) => transfers.cancel(String(id)));
  handle('files:remove', (id: unknown) => transfers.remove(String(id)));

  handle('files:saveToComputer', async (videoId: unknown, opts?: { resumePath?: string | null }) => {
    const id = validateVideoId(videoId);
    // 1. Preflight metadata for the real size + a safe filename.
    const meta = await A().fileMeta(id);
    const filename = sanitizeFilename(meta.filename, `${id}.mp4`);

    // 2. Ask the user where it goes. Paths NEVER come from the API.
    const defaultDir = opts?.resumePath ? path.dirname(opts.resumePath) : loadSettings().lastDownloadDir ?? app.getPath('downloads');
    const res = await dialog.showSaveDialog(win!, {
      title: 'Save video to this computer',
      defaultPath: path.join(defaultDir, filename),
      buttonLabel: 'Save',
    });
    if (res.canceled || !res.filePath) return { cancelled: true };

    saveSettings({ lastDownloadDir: path.dirname(res.filePath) });
    const transferId = `t-${id}`;
    const snapshot = await transfers.start({ id: transferId, videoId: id, destPath: res.filePath });
    return { cancelled: false, transfer: snapshot };
  });

  handle('files:pickAndResume', async (transferId: unknown) => {
    const t = transfers.get(String(transferId));
    if (!t || !t.destPath) throw new YtmonError('No partial file to resume', 'not_found');
    const res = await dialog.showSaveDialog(win!, {
      title: 'Resume download to…',
      defaultPath: t.destPath,
      buttonLabel: 'Resume',
    });
    if (res.canceled || !res.filePath) return { cancelled: true };
    const snapshot = await transfers.start({ id: t.id, videoId: t.videoId, destPath: res.filePath });
    return { cancelled: false, transfer: snapshot };
  });

  handle('files:resume', async (transferId: unknown) => {
    const t = transfers.get(String(transferId));
    if (!t || !t.destPath) throw new YtmonError('No partial file to resume', 'not_found');
    const snapshot = await transfers.start({ id: t.id, videoId: t.videoId, destPath: t.destPath });
    return snapshot;
  });

  handle('files:openInPlayer', async (videoId: unknown) => {
    const id = validateVideoId(videoId);
    const meta = await A().fileMeta(id);
    const dest = path.join(app.getPath('temp'), 'ytmon-stream', sanitizeFilename(meta.filename, `${id}.mp4`));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // Reuse the transfer engine: stream with Range support into a temp copy.
    const snapshot = await transfers.start({ id: `play-${id}`, videoId: id, destPath: dest, forceRestart: true });
    return snapshot;
  });

  handle('files:shareUrl', (id: unknown) => shareUrl(validateVideoId(id)));
  handle('files:shareFile', async (filePath: unknown) => {
    // The path must be an absolute local path the user picked; we additionally
    // refuse anything that still carries a transfer .part suffix.
    const p = String(filePath ?? '');
    if (!p || !path.isAbsolute(p)) throw new YtmonError('Invalid local path', 'invalid_path');
    if (p.endsWith('.part')) throw new YtmonError('That transfer is not finished.', 'incomplete');
    return shareFile(win, p);
  });
  handle('files:revealInFolder', (filePath: unknown) => {
    const p = String(filePath ?? '');
    if (!path.isAbsolute(p)) throw new YtmonError('Invalid local path', 'invalid_path');
    shell.showItemInFolder(p);
    return true;
  });
  handle('files:playLocal', async (filePath: unknown) => {
    const p = String(filePath ?? '');
    if (!path.isAbsolute(p)) throw new YtmonError('Invalid local path', 'invalid_path');
    if (!fs.existsSync(p)) throw new YtmonError('The local file no longer exists.', 'file_missing');
    const err = await shell.openPath(p);
    if (err) throw new YtmonError(err, 'open_failed');
    return true;
  });

  // ---- app -------------------------------------------------------------
  handle('app:version', () => app.getVersion());
  handle('app:platform', () => process.platform);
  handle('app:openExternal', (url: unknown) => {
    const u = String(url ?? '');
    if (!/^https?:\/\//i.test(u)) throw new YtmonError('Only http(s) links can be opened.', 'invalid_path');
    return shell.openExternal(u);
  });
}

// ---- lifecycle ----------------------------------------------------------
registerMediaSchemePrivileges();

/**
 * On Linux, Electron does not use a real OS keyring unless told which backend to
 * use — without this, safeStorage reports "unavailable" and the token can only
 * live in memory, so it has to be re-entered on every launch.
 *
 * Detection is by what is actually installed, not by desktop name: a plain
 * session (Hyprland/sway/i3) can perfectly well have gnome-keyring, and a KDE
 * session should keep kwallet.
 */
function hasGnomeKeyring(): boolean {
  const searchPath = process.env.PATH ?? '';
  for (const dir of searchPath.split(':')) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, 'gnome-keyring-daemon'), fs.constants.X_OK);
      return true;
    } catch {
      /* keep looking */
    }
  }
  return false;
}

if (process.platform === 'linux') {
  const desktop = `${process.env.XDG_CURRENT_DESKTOP ?? ''} ${process.env.DESKTOP_SESSION ?? ''}`.toLowerCase();
  if (/gnome|unity|ubuntu|cinnamon|xfce|mate/.test(desktop) || hasGnomeKeyring()) {
    app.commandLine.appendSwitch('password-store', 'gnome-libsecret');
  }
}

void app.whenReady().then(() => {
  api = currentApi();
  registerMediaProtocol(() => (api ??= currentApi()));
  transfers = new TransferService(api, {
    onUpdate: (s: TransferSnapshot) => broadcast('transfer:update', s),
    onCompleted: (s: TransferSnapshot) => broadcast('transfer:completed', s),
  });
  transfers.setMaxParallel(loadSettings().maxParallelTransfers);
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
});