import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { ConnectionScreen } from '../src/renderer/screens/ConnectionScreen';
import { App } from '../src/renderer/App';
import { ErrorBoundary } from '../src/renderer/components/ErrorBoundary';
import { useConnection } from '../src/renderer/state/connection';
import type { Result } from '../src/preload/types';
import type { VideoPage } from '../src/shared/types';

/**
 * Renderer smoke tests against a fake preload bridge. They verify the vertical
 * slice renders and that an unreachable server produces a retryable state
 * rather than a blank screen.
 */

const ok = <T,>(data: T): Result<T> => ({ ok: true, data });

function fakeBridge(overrides: Record<string, unknown> = {}) {
  const settings = {
    serverUrl: 'http://192.168.1.100:8765',
    lastDownloadDir: null,
    maxParallelTransfers: 2,
    pollIntervalMs: 5000,
    theme: 'system' as const,
    hasToken: false,
    tokenKeychain: true,
    tokenSessionOnly: false,
  };
  return {
    settings: {
      get: async () => ok(settings),
      setServerUrl: async (u: string) => ok({ ...settings, serverUrl: u }),
      setToken: async () => ok({ ...settings, hasToken: true }),
      setPreferences: async () => ok(settings),
      useLoopback: async () => ok({ ...settings, serverUrl: 'http://127.0.0.1:8765' }),
    },
    api: {
      health: async () => ok({ status: 'ok' }),
      serverInfo: async () => ok({ api_version: 'v1', server_version: '1.0.0', bind_mode: 'lan', ffmpeg_path: '/usr/bin/ffmpeg' }),
      listVideos: async () => ok({ items: [], total: 0, page: 1, page_size: 24 } as VideoPage),
      listChannels: async () => ok([]),
      qualityOptions: async () =>
        ok({ options: ['144p', '240p', '360p', '480p', '720p', '1080p', '1440p', '2160p', 'best'], default: '1080p', per_channel_overrides: {} }),
      getQuality: async () => ok({ quality: '1080p', prefer_mp4: true, embed_subs: false, embed_metadata: true, max_concurrent_downloads: 2 }),
      setQuality: async () => ok({ quality: '720p', prefer_mp4: true, embed_subs: false, embed_metadata: true, max_concurrent_downloads: 2 }),
      getMonitor: async () => ok({ enabled: true, interval_minutes: 15, window_hours: 24, future_only: true, content_filter: 'all' as const }),
      setMonitor: async (b: unknown) => ok(b),
      getRetention: async () => ok({ delete_file_when_watched: false, retention_days: null, max_library_items: null }),
      setRetention: async (b: unknown) => ok(b),
      storage: async () => ok({ bytes: 1024, files: 2, free: 2048 }),
      queueStats: async () => ok({ queued: 0, downloading: 0, completed: 3, failed: 0, skipped: 0, unavailable: 1 }),
      scanNow: async () => ok({ channels_scanned: 2, discovered: 3, queued: 2, duplicates: 1, filtered: 0, errors: [] }),
      resolveChannel: async () => ok({ id: 1, channel_id: 'UCabc', url: 'https://x', title: 'Chan', enabled: true, quality_override: null, last_checked_at: null, last_uploaded_at: null }),
      addChannel: async () => ok({}),
      updateChannel: async () => ok({}),
      deleteChannel: async () => ok(true),
      scanChannel: async () => ok({ channels_scanned: 1, discovered: 1, queued: 1, duplicates: 0, filtered: 0, errors: [] }),
      getVideo: async () => ok({}),
      setWatched: async () => ok({}),
      deleteVideo: async () => ok({ deleted: 1, files_deleted: 1, files_missing: 0, errors: [] }),
      bulkDelete: async () => ok({ deleted: 0, files_deleted: 0, files_missing: 0, errors: [] }),
      job: async () => ok({}),
      enqueue: async () => ok(true),
      retry: async () => ok(true),
      cancelJob: async () => ok(true),
      fileMeta: async () =>
        ok({ video_id: 'a', filename: 'a.mp4', size_bytes: 10, mime_type: 'video/mp4', quality: '1080p', quality_height: 1080, duration: 1, modified_at: null, supports_ranges: true }),
      listTokens: async () => ok([]),
      createToken: async () => ok({ label: 'x', token: 't', id: 1, created_at: '' }),
      revokeToken: async () => ok(true),
      reportError: async () => ok(true),
      listPinned: async () => ok([]),
      setPinned: async () => ok({ video_id: 'a', pinned: true }),
      pinVideos: async () => ok(true),
      libraryLayouts: async () => ok({ options: [], descriptions: {}, orders: [] }),
      librarySettings: async () =>
        ok({ media_layout: 'channel_id', tree_order: 'newest', retention_days: null, max_library_items: null, delete_file_when_watched: false }),
      updateLibrarySettings: async () =>
        ok({ media_layout: 'channel_id', tree_order: 'newest', retention_days: null, max_library_items: null, delete_file_when_watched: false }),
      libraryTree: async () => ok({ folders: [], total_videos: 0, total_folders: 0, order: 'newest', media_dir: '/x' }),
      retentionPreview: async () =>
        ok({ retention_days: null, max_library_items: null, completed_total: 0, would_delete: 0, bytes: 0, video_ids: [] }),
      applyRetention: async () => ok({ deleted: 0, files_deleted: 0, errors: [] }),
      sourcesStatus: async () => ok({ sources: 0, enabled: 0, running: false, last_error: null, cookies_configured: false, default_quality: 'best' }),
      listSources: async () => ok([]),
      scanSource: async () => ok(true),
      scanAllSources: async () => ok({ results: [] }),
      previewSource: async () => ok({ source_id: 'PL', kind: 'playlist', count: 0, truncated: false, cookies_required: false, entries: [] }),
      createSource: async () => ok({}),
      updateSource: async () => ok({}),
      deleteSource: async () => ok(true),
      getSource: async () => ok({}),
      fetchLink: async () =>
        ok({ kind: 'video', resolved: 0, added: [], queued: [], duplicates: [], unavailable: [], truncated: false, quality: null, media_type: 'video' }),
      importChannels: async () => ok({ imported: 0, updated: 0, skipped: 0, errors: [] }),
      importChannelsFromFile: async () => ok({ cancelled: true }),
      exportChannels: async () => ok({ cancelled: true }),
    },
    files: {
      saveToComputer: async () => ok({ cancelled: true }),
      pickAndResume: async () => ok({ cancelled: true }),
      list: async () => ok([]),
      cancel: async () => ok(true),
      remove: async () => ok(true),
      resume: async () => ok(true),
      shareUrl: async () => ok({ method: 'external-url', message: 'Opened on YouTube.' }),
      shareFile: async () => ok({ method: 'reveal', message: 'Revealed in Finder.' }),
      revealInFolder: async () => ok(true),
      playLocal: async () => ok(true),
      onTransferEvent: () => () => undefined,
      onMenuSave: () => () => undefined,
    },
    app: {
      version: async () => ok('0.1.0'),
      platform: async () => ok('linux'),
      openExternal: async () => ok(true),
    },
    ...overrides,
  };
}

const FAKE_SETTINGS = {
  serverUrl: 'http://192.168.1.100:8765',
  lastDownloadDir: null,
  maxParallelTransfers: 2,
  pollIntervalMs: 5000,
  theme: 'system' as const,
  hasToken: false,
  tokenKeychain: true,
  tokenSessionOnly: false,
};

beforeEach(() => {
  useConnection.setState({
    settings: FAKE_SETTINGS,
    health: 'unknown',
    healthMessage: null,
    ready: false,
    serverInfo: null,
    bootError: null,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('connection screen (vertical slice: pairing)', () => {
  it('renders the server address field and never asks for a token it cannot use', async () => {
    (window as unknown as { ytmon: unknown }).ytmon = fakeBridge();
    render(<ConnectionScreen />);
    expect(await screen.findByLabelText('Server address')).toBeTruthy();
    expect((screen.getByLabelText('Server address') as HTMLInputElement).value).toBe('http://192.168.1.100:8765');
    // The LAN address means a token will be needed; the hint tells the user
    // where to create one (on the phone), never inline.
    expect(screen.getByText(/Paste a token you created/i)).toBeTruthy();
  });

  it('rejects an invalid address with a clear reason and disables Test connection', async () => {
    (window as unknown as { ytmon: unknown }).ytmon = fakeBridge();
    render(<ConnectionScreen />);
    const input = await screen.findByLabelText('Server address');
    fireEvent.change(input, { target: { value: 'ftp://nope' } });
    await waitFor(() => expect(screen.getByText(/Only http:\/\/ and https:\/\//)).toBeTruthy());
    const btn = screen.getByRole('button', { name: /test connection/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('probes /health and reports reachability', async () => {
    (window as unknown as { ytmon: unknown }).ytmon = fakeBridge();
    render(<ConnectionScreen />);
    fireEvent.click(await screen.findByRole('button', { name: /test connection/i }));
    await waitFor(() => expect(screen.getByText(/Reachable — server status "ok"/)).toBeTruthy());
  });

  it('shows troubleshooting guidance when the server is unreachable', async () => {
    (window as unknown as { ytmon: unknown }).ytmon = fakeBridge();
    useConnection.setState({
      health: 'unreachable',
      healthMessage: 'Cannot reach http://192.168.1.100:8765',
      ready: false,
    });
    render(<ConnectionScreen />);
    expect(await screen.findByText(/Server unreachable/i)).toBeTruthy();
    expect(screen.getByText(/isolated Wi-Fi/i)).toBeTruthy();
    expect(screen.getByText(/LAN mode must be enabled/i)).toBeTruthy();
  });
});

describe('app shell', () => {
  it('mounts, connects, and shows the library without crashing', async () => {
    (window as unknown as { ytmon: unknown }).ytmon = fakeBridge();
    useConnection.setState({ settings: null });
    render(<App />);
    // Health resolves and the shell (not onboarding) takes over.
    await waitFor(() => expect(screen.getByRole('tablist')).toBeTruthy(), { timeout: 4000 });
    expect(screen.getByText('Connected')).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Library/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Settings/i })).toBeTruthy();
    // Library empty state rather than a blank grid.
    expect(await screen.findByText(/Your library is empty/i)).toBeTruthy();
  });

  it('renders the library with the 9 quality options reported by the server', async () => {
    (window as unknown as { ytmon: unknown }).ytmon = fakeBridge();
    useConnection.setState({ settings: null });
    render(<App />);
    await waitFor(() => expect(screen.getByRole('tablist')).toBeTruthy(), { timeout: 4000 });
    await waitFor(() => expect(screen.getByText(/maximum height, set on the phone/i)).toBeTruthy());
    const text = screen.getByText(/maximum height, set on the phone/i).textContent ?? '';
    for (const q of ['144p', '240p', '360p', '480p', '720p', '1080p', '1440p', '2160p', 'best']) {
      expect(text).toContain(q);
    }
  });

  it('prompts for a token instead of showing a dead-end error when the server returns 401', async () => {
    const bridge = fakeBridge();
    bridge.api.health = async () => ({
      ok: false,
      error: { code: 'unauthorized', message: 'missing token', status: 401 },
    });
    (window as unknown as { ytmon: unknown }).ytmon = bridge;
    useConnection.setState({ health: 'unknown', healthMessage: null, ready: false, settings: null });
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText('Server address')).toBeTruthy(), { timeout: 4000 });
    expect(screen.getByLabelText('Access token')).toBeTruthy();
    expect(screen.getByText(/Paste a token you created/i)).toBeTruthy();
    expect(screen.getByText(/127\.0\.0\.1:8765\/docs/)).toBeTruthy();
  });
});

describe('error boundary', () => {
  it('catches a render crash and offers a reload', async () => {
    const Boom = () => {
      throw new Error('kaboom');
    };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    (window as unknown as { ytmon: unknown }).ytmon = fakeBridge();
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Something went wrong')).toBeTruthy();
    expect(screen.getByText('kaboom')).toBeTruthy();
    expect(screen.getByRole('button', { name: /reload window/i })).toBeTruthy();
    spy.mockRestore();
  });
});