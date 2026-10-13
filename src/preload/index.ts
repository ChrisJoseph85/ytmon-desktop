import { contextBridge, ipcRenderer } from 'electron';
import type { Result, YtmonBridge } from './types';
import { fail } from './types';

/** Server caps request bodies at 5 MB; keep the same ceiling in the bridge. */
const MAX_IMPORT_BYTES = 5_000_000;

const invoke = <T>(channel: string, ...args: unknown[]): Promise<Result<T>> =>
  ipcRenderer.invoke(channel, ...args) as Promise<Result<T>>;

/**
 * The entire surface available to renderer code. No Node integration, no fs,
 * no raw paths from the server, no token. Every value is re-validated in main.
 */
const bridge: YtmonBridge = {
  settings: {
    get: () => invoke('settings:get'),
    setServerUrl: (url) => invoke('settings:serverUrl', String(url).slice(0, 300)),
    setToken: (token, persist = true) =>
      invoke('settings:token', token === null ? null : String(token), persist !== false),
    setPreferences: (prefs) => invoke('settings:preferences', prefs ?? {}),
    useLoopback: () => invoke('settings:useLoopback'),
  },
  api: {
    health: () => invoke('api:health'),
    serverInfo: () => invoke('api:serverInfo'),
    storage: () => invoke('api:storage'),
    qualityOptions: () => invoke('api:qualityOptions'),
    getQuality: () => invoke('api:getQuality'),
    setQuality: (body) => invoke('api:setQuality', body),
    listChannels: (enabled) => invoke('api:listChannels', enabled ?? null),
    listSubscriptions: (mode, search) => invoke('api:listSubscriptions', mode ?? null, String(search ?? '').slice(0, 200)),
    subscriptionsStatus: () => invoke('api:subscriptionsStatus'),
    // Cap the paste at the IPC boundary, like every other method here. Main
    // also checks, but by then the whole payload has already been copied
    // across; this is what stops an accidental 100 MB paste from doing that.
    // Counted in UTF-8 BYTES, not characters: 4M accented characters is 8 MB
    // on the wire, and the server's 5 MB limit is about bytes.
    importSubscriptions: (body) => {
      const b = (body ?? {}) as { source?: string; data?: unknown };
      const data = typeof b.data === 'string' ? b.data : '';
      if (new TextEncoder().encode(data).length > MAX_IMPORT_BYTES) {
        return Promise.resolve(fail({
          message: 'That paste is too large to send.',
          code: 'payload_too_large',
          hint: 'The server accepts up to 5 MB. Import a shorter subscriptions.json.',
        }));
      }
      return invoke('api:importSubscriptions', b.source === 'feed' ? { source: 'feed' } : { source: 'takeout', data });
    },
    subscriptionSnapshot: (id) => invoke('api:subscriptionSnapshot', String(id ?? '').slice(0, 64)),
    setChannelPolicy: (channelId, body) => invoke('api:setChannelPolicy', channelId, body ?? {}),
    bulkChannelPolicy: (body) => invoke('api:bulkChannelPolicy', body),
    syncSubscriptions: () => invoke('api:syncSubscriptions'),
    channelUploads: (channelId, limit) => invoke('api:channelUploads', channelId, limit ?? 15),
    downloadChannelBacklog: (channelId, body) => invoke('api:downloadChannelBacklog', channelId, body ?? {}),
    cookiesInfo: () => invoke('api:cookiesInfo'),
    putCookies: (content) => invoke('api:putCookies', String(content ?? '').slice(0, 2_000_000)),
    deleteCookies: () => invoke('api:deleteCookies'),
    setRateLimits: (body) => invoke('api:setRateLimits', body ?? {}),
    addChannel: (body) => invoke('api:addChannel', body),
    updateChannel: (channelId, body) => invoke('api:updateChannel', channelId, body),
    deleteChannel: (channelId) => invoke('api:deleteChannel', channelId),
    scanChannel: (channelId) => invoke('api:scanChannel', channelId),
    getMonitor: () => invoke('api:getMonitor'),
    setMonitor: (body) => invoke('api:setMonitor', body),
    scanNow: () => invoke('api:scanNow'),
    resolveChannel: (url) => invoke('api:resolveChannel', String(url).slice(0, 500)),
    importChannels: (body: string, format: 'csv' | 'json', updateExisting = true) =>
      invoke('api:importChannels', String(body), format, updateExisting),
    importChannelsFromFile: (updateExisting?: boolean) => invoke('api:importChannelsFromFile', !!updateExisting),
    exportChannels: (format: 'csv' | 'json') => invoke('api:exportChannels', format),
    listVideos: (query) => invoke('api:listVideos', query ?? {}),
    getVideo: (videoId, includeFormats) => invoke('api:getVideo', videoId, !!includeFormats),
    setWatched: (videoId, watched) => invoke('api:setWatched', videoId, !!watched),
    deleteVideo: (videoId, deleteFile, dryRun) => invoke('api:deleteVideo', videoId, !!deleteFile, !!dryRun),
    previewBulkDelete: (videoIds, deleteFiles) =>
      invoke('api:previewBulkDelete', (videoIds ?? []).slice(0, 1000), !!deleteFiles),
    bulkDelete: (videoIds, deleteFiles, dryRun) =>
      invoke('api:bulkDelete', (videoIds ?? []).slice(0, 1000), !!deleteFiles, !!dryRun),
    queueStats: () => invoke('api:queueStats'),
    job: (videoId) => invoke('api:job', videoId),
    enqueue: (videoIds, priority) => invoke('api:enqueue', videoIds ?? [], priority ?? null),
    retry: (videoId) => invoke('api:retry', videoId),
    cancelJob: (videoId) => invoke('api:cancelJob', videoId),
    getRetention: () => invoke('api:getRetention'),
    setRetention: (body) => invoke('api:setRetention', body),
    fileMeta: (videoId) => invoke('api:fileMeta', videoId),
    listTokens: () => invoke('api:listTokens'),
    createToken: (label) => invoke('api:createToken', label),
    revokeToken: (id) => invoke('api:revokeToken', id),
    reportError: (level, message) => invoke('api:reportError', level, message),
    fetchLink: (body) => invoke('api:fetchLink', body),
    listSources: () => invoke('api:listSources'),
    getSource: (sourceId) => invoke('api:getSource', sourceId),
    createSource: (body) => invoke('api:createSource', body),
    updateSource: (sourceId, body) => invoke('api:updateSource', sourceId, body),
    deleteSource: (sourceId) => invoke('api:deleteSource', sourceId),
    scanSource: (sourceId) => invoke('api:scanSource', sourceId),
    scanAllSources: () => invoke('api:scanAllSources'),
    previewSource: (url) => invoke('api:previewSource', url),
    sourcesStatus: () => invoke('api:sourcesStatus'),
    retentionPreview: () => invoke('api:retentionPreview'),
    setPinned: (videoId: string, pinned: boolean) => invoke('api:setPinned', videoId, !!pinned),
    pinVideos: (videoIds: (number | string)[], pinned: boolean) => invoke('api:pinVideos', videoIds ?? [], !!pinned),
    listPinned: () => invoke('api:listPinned'),
    libraryLayouts: () => invoke('api:libraryLayouts'),
    librarySettings: () => invoke('api:librarySettings'),
    updateLibrarySettings: (body: unknown) => invoke('api:updateLibrarySettings', body),
    libraryTree: (order?: string, limitPerFolder?: number) =>
      invoke('api:libraryTree', order ?? null, limitPerFolder ?? null),
    applyRetention: (dryRun = true) => invoke('api:applyRetention', dryRun !== false),
  },
  files: {
    saveToComputer: (videoId, opts) => invoke('files:saveToComputer', videoId, opts ?? {}),
    pickAndResume: (transferId) => invoke('files:pickAndResume', transferId),
    list: () => invoke('files:list'),
    cancel: (transferId) => invoke('files:cancel', transferId),
    remove: (transferId) => invoke('files:remove', transferId),
    resume: (transferId) => invoke('files:resume', transferId),
    shareUrl: (videoId) => invoke('files:shareUrl', videoId),
    shareFile: (filePath) => invoke('files:shareFile', filePath),
    revealInFolder: (filePath) => invoke('files:revealInFolder', filePath),
    playLocal: (filePath) => invoke('files:playLocal', filePath),
    onTransferEvent: (cb) => {
      const handler = (_e: unknown, s: unknown) => cb(s as never);
      ipcRenderer.on('transfer:update', handler);
      ipcRenderer.on('transfer:completed', handler);
      return () => {
        ipcRenderer.off('transfer:update', handler);
        ipcRenderer.off('transfer:completed', handler);
      };
    },
    onMenuSave: (cb) => {
      const handler = () => cb();
      ipcRenderer.on('menu:save-video', handler);
      return () => ipcRenderer.off('menu:save-video', handler);
    },
  },
  app: {
    version: () => invoke('app:version'),
    platform: () => invoke('app:platform'),
    openExternal: (url) => invoke('app:openExternal', url),
  },
};

contextBridge.exposeInMainWorld('ytmon', bridge);