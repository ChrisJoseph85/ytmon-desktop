import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup, within } from '@testing-library/react';
import React from 'react';
import { ChannelsScreen } from '../src/renderer/screens/ChannelsScreen';
import { ChannelUploadsModal } from '../src/renderer/components/ChannelUploadsModal';
import { CookiesCard } from '../src/renderer/components/CookiesInfoPanel';
import { Toasts } from '../src/renderer/components/Toasts';
import { DownloadsScreen } from '../src/renderer/screens/DownloadsScreen';
import { isQueuePaused } from '../src/shared/types';
import { inQuietHours, validateQuietHours, validateRateLimit, isDownloadKind } from '../src/shared/ratelimit';
import { YtmonError } from '../src/shared/errors';
import type { Channel, ChannelUploads } from '../src/shared/types';

/**
 * Subscriptions auto-sync, channel uploads preview, trigger-download and rate
 * limits.
 *
 * The rules from the server update that are easy to get wrong, and are pinned
 * here:
 *  - the uploads endpoint is a PREVIEW: it queues and downloads nothing
 *  - its `kind` is always "unknown" and Shorts cannot be detected, so there
 *    must be no Shorts filter
 *  - "Download all" must dry-run first, and only download after a confirm
 *  - unavailable items get no retry affordance
 *  - paused_reason must be rendered, or the Downloads screen looks broken
 */

const ok = <T,>(data: T) => ({ ok: true as const, data });
const UC = 'UCabcdefghijklmnopqrstuv';

function channel(over: Partial<Channel> = {}): Channel {
  return {
    id: 1,
    channel_id: UC,
    url: `https://www.youtube.com/channel/${UC}`,
    // Many imported channels have no title yet; the id is the label.
    title: null,
    enabled: true,
    quality_override: null,
    mode: 'auto',
    schedule_enabled: false,
    schedule_days: [],
    schedule_time: null,
    due_now: false,
    next_due: null,
    last_checked_at: null,
    last_uploaded_at: null,
    created_at: null,
    updated_at: null,
    ...over,
  };
}

function uploads(over: Partial<ChannelUploads> = {}): ChannelUploads {
  return {
    channel_id: UC,
    channel_title: null,
    count: 2,
    shorts_detectable: false,
    uploads: [
      { video_id: 'aaaaaaaaaaa', title: 'Newest upload', channel_id: UC, channel_title: null, published_at: '2026-10-01T10:00:00+00:00', thumbnail: 'https://i.ytimg.com/vi/aaaaaaaaaaa/hq.jpg', kind: 'unknown' },
      { video_id: 'bbbbbbbbbbb', title: 'Older upload', channel_id: UC, channel_title: null, published_at: '2026-09-01T10:00:00+00:00', thumbnail: null, kind: 'unknown' },
    ],
    ...over,
  };
}

function fakeBridge(api: Record<string, unknown>) {
  return {
    api: {
      listChannels: async () => ok([channel()]),
      listSubscriptions: async () => ok([channel()]),
      subscriptionsStatus: async () => ok({ cookies_configured: true, subscriptions: 1 }),
      qualityOptions: async () => ok({ options: ['480p'], default: '480p', per_channel_overrides: {} }),
      queueStats: async () => ok({ queued: 0, downloading: 0, completed: 0, failed: 0, skipped: 0, unavailable: 0 }),
      listVideos: async () => ok({ items: [], total: 0, page: 1, page_size: 24 }),
      ...api,
    },
    settings: { get: async () => ok({}), setPreferences: async () => ok({}) },
    files: { list: async () => ok([]), onTransferEvent: () => () => undefined, onMenuSave: () => () => undefined },
    app: {},
  };
}

beforeEach(() => useToastsReset());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function useToastsReset() {
  // Toast store is module-global; drain it so tests cannot match a stale one.
  return import('../src/renderer/lib/bridge').then(({ useToasts }) => useToasts.setState({ toasts: [] }));
}

describe('channel uploads preview', () => {
  it('is a preview: opening it queues nothing', async () => {
    const fetchLink = vi.fn(async () => ok({ kind: 'video', resolved: 0, added: [], queued: [], duplicates: [], unavailable: [], truncated: false, quality: null, media_type: 'video' }));
    (window as unknown as { ytmon: unknown }).ytmon = fakeBridge({
      channelUploads: async () => ok(uploads()),
      fetchLink,
    });
    render(
      <>
        <ChannelUploadsModal channel={channel()} onClose={() => undefined} />
        <Toasts />
      </>,
    );
    await screen.findByText('Newest upload');
    // Merely rendering the preview must not have downloaded anything.
    expect(fetchLink).not.toHaveBeenCalled();
    expect(screen.getByText(/Nothing is queued by opening this/i)).toBeTruthy();
  });

  it('offers no Shorts filter, because the feed cannot detect Shorts', async () => {
    (window as unknown as { ytmon: unknown }).ytmon = fakeBridge({ channelUploads: async () => ok(uploads()) });
    render(
      <>
        <ChannelUploadsModal channel={channel()} onClose={() => undefined} />
        <Toasts />
      </>,
    );
    await screen.findByText('Newest upload');
    // No Shorts filter CONTROL. The prose explains why; that is fine.
    expect(screen.queryByRole('button', { name: /shorts?/i })).toBeNull();
    expect(screen.queryByRole('tab', { name: /shorts?/i })).toBeNull();
    expect(screen.getByText(/shown as plain videos/i)).toBeTruthy();
  });

  it('labels a title-less channel by its id', async () => {
    (window as unknown as { ytmon: unknown }).ytmon = fakeBridge({ channelUploads: async () => ok(uploads()) });
    render(
      <>
        <ChannelUploadsModal channel={channel()} onClose={() => undefined} />
        <Toasts />
      </>,
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(UC)).toBeTruthy();
    expect(within(dialog).getByText('No title yet')).toBeTruthy();
  });

  it('downloads an upload that is not in the library yet', async () => {
    const fetchLink = vi.fn(async (_body: { url: string; download: boolean }) =>
      ok({ kind: 'video', resolved: 1, added: [], queued: ['aaaaaaaaaaa'], duplicates: [], unavailable: [], truncated: false, quality: null, media_type: 'video' }),
    );
    (window as unknown as { ytmon: unknown }).ytmon = fakeBridge({
      channelUploads: async () => ok(uploads()),
      getVideo: async () => { throw new YtmonError('not found', 'not_found', 404); },
      fetchLink,
    });
    render(
      <>
        <ChannelUploadsModal channel={channel()} onClose={() => undefined} />
        <Toasts />
      </>,
    );
    fireEvent.click(await screen.findByText('Newest upload'));
    await waitFor(() => expect(fetchLink).toHaveBeenCalled());
    expect(fetchLink.mock.calls[0]![0]).toMatchObject({ url: expect.stringContaining('aaaaaaaaaaa'), download: true });
  });
});

describe('Download all is always previewed first', () => {
  const open = async (downloadChannelBacklog: ReturnType<typeof vi.fn>) => {
    (window as unknown as { ytmon: unknown }).ytmon = fakeBridge({
      channelUploads: async () => ok(uploads()),
      downloadChannelBacklog,
    });
    render(
      <>
        <ChannelUploadsModal channel={channel()} onClose={() => undefined} />
        <Toasts />
      </>,
    );
    await screen.findByText('Newest upload');
    fireEvent.click(screen.getByRole('button', { name: /Download all discovered/i }));
    return screen.findByRole('dialog');
  };

  it('dry-runs, shows counts, and downloads nothing until confirmed', async () => {
    const bulk = vi.fn(async (_id: string, body: { dry_run?: boolean }) =>
      ok({ channel_id: UC, considered: 40, queued: body.dry_run ? 12 : 12, already_downloaded: 28, video_ids: [], dry_run: body.dry_run === true }),
    );
    await open(bulk as never);
    await waitFor(() => expect(bulk).toHaveBeenCalledTimes(1));
    // First call must be a dry run, or the user never got a choice.
    expect(bulk.mock.calls[0]![1]).toMatchObject({ dry_run: true });

    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByText(/12 would be queued/i)).toBeTruthy());
    // Nothing real has been sent yet.
    expect(bulk).toHaveBeenCalledTimes(1);

    fireEvent.click(within(dialog).getByRole('button', { name: /^Queue 12$/ }));
    await waitFor(() => expect(bulk).toHaveBeenCalledTimes(2));
    expect(bulk.mock.calls[1]![1]).toMatchObject({ dry_run: false });
  });

  it('lets the user back out without queueing anything', async () => {
    const bulk = vi.fn(async (_id: string, body: { dry_run?: boolean }) =>
      ok({ channel_id: UC, considered: 40, queued: 12, already_downloaded: 28, video_ids: [], dry_run: body.dry_run === true }),
    );
    const dialog = await open(bulk as never);
    await waitFor(() => expect(bulk).toHaveBeenCalledTimes(1));
    fireEvent.click(within(dialog).getByRole('button', { name: /^Cancel$/ }));
    await waitFor(() => expect(screen.queryByText(/would be queued/i)).toBeNull());
    expect(bulk).toHaveBeenCalledTimes(1);
  });
});

describe('paused_reason is rendered on the Downloads screen', () => {
  const renderDownloads = async (stats: Record<string, unknown>) => {
    (window as unknown as { ytmon: unknown }).ytmon = fakeBridge({ queueStats: async () => ok(stats) });
    render(
      <>
        <DownloadsScreen />
        <Toasts />
      </>,
    );
  };

  it('says why downloads are paused instead of looking broken', async () => {
    await renderDownloads({
      queued: 3, downloading: 0, completed: 1, failed: 0, skipped: 0, unavailable: 0,
      max_downloads_per_day: 50, started_last_24h: 50, paused_reason: 'daily cap of 50 reached',
    });
    expect(await screen.findByText(/Downloads are paused/i)).toBeTruthy();
    expect(screen.getByText(/daily cap of 50 reached/)).toBeTruthy();
    // Progress for anything already running must still be possible.
    expect(screen.getByText(/keeps going/i)).toBeTruthy();
  });

  it('shows nothing when downloads are not paused', async () => {
    await renderDownloads({
      queued: 0, downloading: 0, completed: 1, failed: 0, skipped: 0, unavailable: 0, paused_reason: null,
    });
    await screen.findByText(/Nothing in flight/i);
    expect(screen.queryByText(/Downloads are paused/i)).toBeNull();
  });

  it('treats an older server with no paused_reason as not paused', () => {
    expect(isQueuePaused({ queued: 0, downloading: 0, completed: 0, failed: 0, skipped: 0, unavailable: 0 })).toBe(false);
    expect(isQueuePaused(null)).toBe(false);
    expect(isQueuePaused({ paused_reason: '' } as never)).toBe(false);
  });
});

describe('rate limit validation', () => {
  it('accepts 0 as "off" and rejects out-of-range values', () => {
    expect(validateRateLimit('min_seconds_between_downloads', '0').value).toBe(0);
    expect(validateRateLimit('min_seconds_between_downloads', '3600').ok).toBe(true);
    expect(validateRateLimit('min_seconds_between_downloads', '3601').ok).toBe(false);
    expect(validateRateLimit('max_downloads_per_day', '200').value).toBe(200);
    expect(validateRateLimit('max_downloads_per_day', '10001').ok).toBe(false);
    expect(validateRateLimit('subscriptions_autosync_minutes', '4').ok).toBe(false);
    expect(validateRateLimit('subscriptions_autosync_minutes', '360').ok).toBe(true);
    expect(validateRateLimit('max_downloads_per_day', 'lots').ok).toBe(false);
  });

  it('allows an overnight quiet-hours window', () => {
    expect(validateQuietHours('22:00-07:00')).toEqual({ ok: true, normalized: '22:00-07:00' });
    expect(validateQuietHours('').normalized).toBeNull();
    expect(validateQuietHours('25:00-07:00').ok).toBe(false);
    expect(validateQuietHours('22:00').ok).toBe(false);
    // Same start and end is not "all day", it is a mistake.
    expect(validateQuietHours('22:00-22:00').ok).toBe(false);
  });

  it('treats an overnight window as wrapping past midnight', () => {
    const at = (h: number, m: number) => new Date(2026, 0, 1, h, m);
    expect(inQuietHours('22:00-07:00', at(23, 0))).toBe(true);
    expect(inQuietHours('22:00-07:00', at(3, 0))).toBe(true);
    expect(inQuietHours('22:00-07:00', at(12, 0))).toBe(false);
    expect(inQuietHours('09:00-17:00', at(12, 0))).toBe(true);
    expect(inQuietHours(null, at(3, 0))).toBe(false);
  });

  it('accepts only the documented download kinds', () => {
    expect(isDownloadKind('video')).toBe(true);
    expect(isDownloadKind('short')).toBe(true);
    expect(isDownloadKind('unknown')).toBe(true);
    expect(isDownloadKind('all')).toBe(false);
  });
});

describe('cookies', () => {
  it('explains that non-YouTube cookies are dropped', () => {
    const e = new YtmonError('not configured', 'cookies_not_configured', 400);
    expect(e.hint).toBeTruthy();
    // The message must be shown verbatim, not replaced with a generic error.
    expect(e.message).toBe('not configured');
  });

  it('renders the dropped-cookie count so a small result is explained', async () => {
    (window as unknown as { ytmon: unknown }).ytmon = fakeBridge({
      cookiesInfo: async () => ok({ configured: true, path: '/data/cookies.txt', exists: true, size_bytes: 4096, cookie_count: 59, dropped_non_youtube: 812 }),
    });
    render(
      <>
        <CookiesCard />
        <Toasts />
      </>,
    );
    expect(await screen.findByText(/non-YouTube cookies dropped/i)).toBeTruthy();
    expect(screen.getByText(/59 cookies stored/i)).toBeTruthy();
  });
});

describe('subscription auto-sync is never implied when off', () => {
  it('says the list does not update by itself', async () => {
    (window as unknown as { ytmon: unknown }).ytmon = fakeBridge({
      subscriptionsStatus: async () => ok({ cookies_configured: true, subscriptions: 5, autosync_enabled: false }),
    });
    render(
      <>
        <ChannelsScreen />
        <Toasts />
      </>,
    );
    expect(await screen.findByText(/Auto-sync is off/i)).toBeTruthy();
    expect(screen.getByText(/does not update by itself/i)).toBeTruthy();
  });

  it('surfaces an autosync error, which is usually logged-out cookies', async () => {
    (window as unknown as { ytmon: unknown }).ytmon = fakeBridge({
      subscriptionsStatus: async () => ok({ cookies_configured: true, autosync_enabled: true, autosync_error: 'cookies logged out' }),
    });
    render(
      <>
        <ChannelsScreen />
        <Toasts />
      </>,
    );
    expect(await screen.findByText(/cookies logged out/)).toBeTruthy();
  });
});