import { create } from 'zustand';
import type { Result } from '../../preload/types';
import type { YtmonBridge } from '../../preload/types';
import type { FetchRequest, SourceCreate, SourceUpdate, TreeOrder } from '../../shared/types';

declare global {
  interface Window {
    ytmon?: YtmonBridge;
  }
}

/** Throws if the preload bridge is missing (never expected in a packaged app). */
export function bridge(): YtmonBridge {
  const b = window.ytmon;
  if (!b) throw new Error('Preload bridge unavailable — the app window is not trusted.');
  return b;
}

export interface BridgeError {
  message: string;
  code: string;
  status?: number;
  details?: unknown;
  /** Actionable next step for the codes the server documents. */
  hint?: string | null;
}

/** Best message to show: the server's own message, plus our hint when we have one. */
export function describeError(e: unknown): { message: string; hint: string | null; code: string } {
  const err = e as { message?: string; code?: string; hint?: string | null };
  return {
    message: err?.message ?? 'Unexpected error',
    hint: err?.hint ?? null,
    code: err?.code ?? 'unknown_error',
  };
}

/** Unwraps a Result, throwing an error that carries the server's own message. */
export async function call<T>(p: Promise<Result<T>>): Promise<T> {
  const res = await p;
  if (!res.ok) {
    const err = new Error(res.error.message) as Error & BridgeError;
    err.code = res.error.code;
    if (res.error.status !== undefined) err.status = res.error.status;
    if (res.error.details !== undefined) err.details = res.error.details;
    err.hint = res.error.hint ?? null;
    throw err;
  }
  return res.data;
}

const b = new Proxy({} as YtmonBridge, {
  get: (_t, prop) => (bridge() as unknown as Record<string, unknown>)[prop as string],
}) as YtmonBridge;

export const api = {
  health: () => call(b.api.health()),
  serverInfo: () => call(b.api.serverInfo()),
  storage: () => call(b.api.storage()),
  qualityOptions: () => call(b.api.qualityOptions()),
  getQuality: () => call(b.api.getQuality()),
  setQuality: (body: Parameters<YtmonBridge['api']['setQuality']>[0]) => call(b.api.setQuality(body)),
  listChannels: (enabled?: boolean) => call(b.api.listChannels(enabled ?? null)),
  addChannel: (x: Parameters<YtmonBridge['api']['addChannel']>[0]) => call(b.api.addChannel(x)),
  updateChannel: (id: string, x: Parameters<YtmonBridge['api']['updateChannel']>[1]) => call(b.api.updateChannel(id, x)),
  deleteChannel: (id: string) => call(b.api.deleteChannel(id)),
  scanChannel: (id: string) => call(b.api.scanChannel(id)),
  getMonitor: () => call(b.api.getMonitor()),
  setMonitor: (body: Parameters<YtmonBridge['api']['setMonitor']>[0]) => call(b.api.setMonitor(body)),
  scanNow: () => call(b.api.scanNow()),
  resolveChannel: (url: string) => call(b.api.resolveChannel(url)),
  importChannels: (body: string, format: 'csv' | 'json', updateExisting = true) =>
    call(b.api.importChannels(body, format, updateExisting)),
  importChannelsFromFile: (updateExisting = false) => call(b.api.importChannelsFromFile(updateExisting)),
  exportChannels: (format: 'csv' | 'json') => call(b.api.exportChannels(format)),
  listVideos: (q: Parameters<YtmonBridge['api']['listVideos']>[0]) => call(b.api.listVideos(q)),
  getVideo: (id: string, formats?: boolean) => call(b.api.getVideo(id, formats)),
  setWatched: (id: string, w: boolean) => call(b.api.setWatched(id, w)),
  deleteVideo: (id: string, del: boolean, dryRun = false) => call(b.api.deleteVideo(id, del, dryRun)),
  previewBulkDelete: (ids: (number | string)[], del: boolean) => call(b.api.previewBulkDelete(ids, del)),
  bulkDelete: (ids: (number | string)[], del: boolean, dryRun = false) => call(b.api.bulkDelete(ids, del, dryRun)),
  queueStats: () => call(b.api.queueStats()),
  job: (id: string) => call(b.api.job(id)),
  enqueue: (ids: string[], p?: number) => call(b.api.enqueue(ids, p ?? null)),
  retry: (id: string) => call(b.api.retry(id)),
  cancelJob: (id: string) => call(b.api.cancelJob(id)),
  getRetention: () => call(b.api.getRetention()),
  setRetention: (body: Parameters<YtmonBridge['api']['setRetention']>[0]) => call(b.api.setRetention(body)),
  fileMeta: (id: string) => call(b.api.fileMeta(id)),
  listTokens: () => call(b.api.listTokens()),
  createToken: (label: string) => call(b.api.createToken(label)),
  revokeToken: (id: number) => call(b.api.revokeToken(id)),
  reportError: (level: 'ERROR' | 'WARNING' | 'INFO', message: string) => call(b.api.reportError(level, message)),
  fetchLink: (body: FetchRequest) => call(b.api.fetchLink(body)),
  listSources: () => call(b.api.listSources()),
  getSource: (id: string) => call(b.api.getSource(id)),
  createSource: (body: SourceCreate) => call(b.api.createSource(body)),
  updateSource: (id: string, body: SourceUpdate) => call(b.api.updateSource(id, body)),
  deleteSource: (id: string) => call(b.api.deleteSource(id)),
  scanSource: (id: string) => call(b.api.scanSource(id)),
  scanAllSources: () => call(b.api.scanAllSources()),
  previewSource: (url: string) => call(b.api.previewSource(url)),
  sourcesStatus: () => call(b.api.sourcesStatus()),
  retentionPreview: () => call(b.api.retentionPreview()),
  setPinned: (videoId: string, pinned: boolean) => call(b.api.setPinned(videoId, pinned)),
  pinVideos: (videoIds: (number | string)[], pinned: boolean) => call(b.api.pinVideos(videoIds, pinned)),
  listPinned: () => call(b.api.listPinned()),
  libraryLayouts: () => call(b.api.libraryLayouts()),
  librarySettings: () => call(b.api.librarySettings()),
  updateLibrarySettings: (body: Parameters<YtmonBridge['api']['updateLibrarySettings']>[0]) =>
    call(b.api.updateLibrarySettings(body)),
  libraryTree: (order?: TreeOrder, limit?: number) => call(b.api.libraryTree(order, limit)),
  applyRetention: (dryRun = true) => call(b.api.applyRetention(dryRun)),
};

export const files = {
  saveToComputer: (videoId: string, opts?: { resumePath?: string | null }) => call(b.files.saveToComputer(videoId, opts)),
  list: () => call(b.files.list()),
  cancel: (id: string) => call(b.files.cancel(id)),
  remove: (id: string) => call(b.files.remove(id)),
  resume: (id: string) => call(b.files.resume(id)),
  shareUrl: (videoId: string) => call(b.files.shareUrl(videoId)),
  shareFile: (filePath: string) => call(b.files.shareFile(filePath)),
  revealInFolder: (filePath: string) => call(b.files.revealInFolder(filePath)),
  playLocal: (filePath: string) => call(b.files.playLocal(filePath)),
  onTransferEvent: (cb: Parameters<YtmonBridge['files']['onTransferEvent']>[0]) => b.files.onTransferEvent(cb),
  onMenuSave: (cb: () => void) => b.files.onMenuSave(cb),
};

export const settingsApi = {
  get: () => call(b.settings.get()),
  setServerUrl: (url: string) => call(b.settings.setServerUrl(url)),
  setToken: (t: string | null, persist = true) => call(b.settings.setToken(t, persist)),
  setPreferences: (p: Parameters<YtmonBridge['settings']['setPreferences']>[0]) => call(b.settings.setPreferences(p)),
  useLoopback: () => call(b.settings.useLoopback()),
};

export const appApi = {
  version: () => call(b.app.version()),
  platform: () => call(b.app.platform()),
  openExternal: (url: string) => call(b.app.openExternal(url)),
};

// Re-exported response models so screens import from one place.
export type {
  Video as VideoShape,
  VideoPage as VideoPageShape,
  Job as JobShape,
  Channel as ChannelShape,
  MonitorScanResult as ScanResult,
  DeleteResult as DeleteResultShape,
  QueueStats as QueueStatsShape,
  QualitySettings as QualitySettingsShape,
  MonitorSettings as MonitorShape,
  RetentionSettings as RetentionShape,
  FileMetadata as FileMetaShape,
  StorageInfo as StorageShape,
  ChannelImportResult,
  MediaType,
  Source,
  SourceCounts,
  SourceQualityOverride,
  SourceCreate,
  SourceUpdate,
  SourcePreview,
  SourcesStatus,
  FetchRequest,
  FetchResult,
  ScanStats,
  ScanAllResult,
  RetentionUpdate,
  RetentionPlan,
  RetentionResult,
  LibraryLayouts,
  LibrarySettings,
  LibraryTree,
  TreeOrder,
  MediaLayout,
  Quality,
  HealthStatus,
  WorkerState,
} from '../../shared/types';
export type { TransferSnapshot as TransferShape } from '../../main/transfers';
export type { PublicSettings } from '../../preload/types';

// ---- transient UI-only store -------------------------------------------
export const useToasts = create<{
  toasts: { id: number; kind: 'info' | 'success' | 'error'; text: string }[];
  push(kind: 'info' | 'success' | 'error', text: string): void;
  dismiss(id: number): void;
}>((set) => ({
  toasts: [],
  push: (kind, text) => {
    const id = Date.now() + Math.random();
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
    setTimeout(
      () => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
      kind === 'error' ? 8000 : 4000,
    );
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const toast = {
  info: (t: string) => useToasts.getState().push('info', t),
  success: (t: string) => useToasts.getState().push('success', t),
  error: (t: string) => useToasts.getState().push('error', t),
  /** Renders the server's message plus our actionable hint for known codes. */
  fromError: (e: unknown) => {
    const d = describeError(e);
    useToasts.getState().push('error', d.hint ? `${d.message} — ${d.hint}` : d.message);
  },
};