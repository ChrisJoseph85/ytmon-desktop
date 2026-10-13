import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup, within } from '@testing-library/react';
import React from 'react';
import { ChannelsScreen } from '../src/renderer/screens/ChannelsScreen';
import { Toasts } from '../src/renderer/components/Toasts';
import type { Result } from '../src/preload/types';
import type { Channel, SubscriptionImportRequest, SubscriptionImportResult } from '../src/shared/types';

/**
 * Channels screen: the Auto/Manual control, the schedule editor, the mode
 * filter and the subscriptions import sheet.
 *
 * These assert the SEMANTICS as well as the wiring — in particular that the
 * client writes policy through /policy, never flips imported channels to auto,
 * and says that manual still discovers.
 */

const ok = <T,>(data: T): Result<T> => ({ ok: true, data });
const UC = 'UCabcdefghijklmnopqrstuv';

function channel(over: Partial<Channel> = {}): Channel {
  return {
    id: 1,
    channel_id: UC,
    url: `https://www.youtube.com/channel/${UC}`,
    title: 'Lofi Channel',
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

type Bridge = Record<string, unknown>;

function fakeBridge(over: Bridge = {}): Bridge {
  const api = {
    listChannels: async () => ok([channel()]),
    listSubscriptions: async () => ok([]),
    subscriptionsStatus: async () => ok({ cookies_configured: false, subscriptions: 3 }),
    importSubscriptions: async (): Promise<Result<SubscriptionImportResult>> =>
      ok({ source: 'takeout', imported: 300, updated: 0, skipped: 2, total: 302, errors: [] }),
    setChannelPolicy: async () => ok(channel()),
    bulkChannelPolicy: async () => ok({ updated: 2 }),
    qualityOptions: async () => ok({ options: ['480p', '1080p'], default: '1080p', per_channel_overrides: {} }),
    scanChannel: async () => ok({ channels_scanned: 1, discovered: 2, queued: 0, duplicates: 0, filtered: 0, held: 2, errors: [] }),
    updateChannel: async () => ok(channel()),
    deleteChannel: async () => ok(true),
    ...over,
  };
  return {
    api,
    settings: { get: async () => ok({}), setPreferences: async () => ok({}) },
    files: {},
    app: {},
  };
}

function install(bridge: Bridge) {
  (window as unknown as { ytmon: unknown }).ytmon = bridge;
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('channels screen — auto / manual', () => {
  it('shows the mode control and switches a channel to manual via the policy endpoint', async () => {
    const setChannelPolicy = vi.fn(async () => ok(channel({ mode: 'manual' })));
    install(fakeBridge({ setChannelPolicy }));
    render(
      <>
        <ChannelsScreen />
        <Toasts />
      </>,
    );

    const group = await screen.findByRole('group', { name: /Downloads for Lofi Channel/i });
    const manual = within(group).getByRole('button', { name: 'Manual' });
    fireEvent.click(manual);

    await waitFor(() => expect(setChannelPolicy).toHaveBeenCalledTimes(1));
    expect(setChannelPolicy).toHaveBeenCalledWith(UC, { mode: 'manual' });
  });

  it('says manual still discovers, so the user is not left thinking discovery stopped', async () => {
    install(fakeBridge({ listChannels: async () => ok([channel({ mode: 'manual' })]) }));
    render(
      <>
        <ChannelsScreen />
        <Toasts />
      </>,
    );
    expect(await screen.findByText(/still discovered and show up in the library/i)).toBeTruthy();
  });

  it('does not offer a schedule as if it applied to a manual channel', async () => {
    install(fakeBridge({ listChannels: async () => ok([channel({ mode: 'manual' })]) }));
    render(
      <>
        <ChannelsScreen />
        <Toasts />
      </>,
    );
    await screen.findByText('Lofi Channel');
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('switch', { name: /only download on a schedule/i })).toHaveProperty('disabled', true);
  });

  it('renders the server-computed next_due rather than inventing one', async () => {
    install(
      fakeBridge({
        listChannels: async () =>
          ok([channel({ schedule_enabled: true, schedule_days: ['mon'], schedule_time: '08:30', due_now: false, next_due: '2026-10-13T08:30:00' })]),
      }),
    );
    render(
      <>
        <ChannelsScreen />
        <Toasts />
      </>,
    );
    expect(await screen.findByText(/Next: 2026-10-13T08:30:00/)).toBeTruthy();
  });
});

describe('channels screen — schedule editor', () => {
  it('sends days and time in one policy PATCH', async () => {
    const setChannelPolicy = vi.fn(async (_id: string, _body: unknown) => ok(channel()));
    install(fakeBridge({ setChannelPolicy }));
    render(
      <>
        <ChannelsScreen />
        <Toasts />
      </>,
    );
    await screen.findByText('Lofi Channel');
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mon' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fri' }));
    fireEvent.change(within(dialog).getByLabelText(/time \(24h, local\)/i), { target: { value: '08:30' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(setChannelPolicy).toHaveBeenCalled());
    const [, patch] = setChannelPolicy.mock.calls[0]!;
    expect(patch).toMatchObject({ schedule_enabled: true, schedule_days: ['mon', 'fri'], schedule_time: '08:30' });
  });

  it('blocks an invalid time with a reason instead of sending it', async () => {
    const setChannelPolicy = vi.fn(async (_id: string, _body: unknown) => ok(channel()));
    install(fakeBridge({ setChannelPolicy }));
    render(
      <>
        <ChannelsScreen />
        <Toasts />
      </>,
    );
    await screen.findByText('Lofi Channel');
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));

    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/time \(24h, local\)/i), { target: { value: '25:00' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    // The field-level error and the modal alert both carry the reason.
    await waitFor(() => expect(within(dialog).getAllByText(/24-hour HH:MM/i).length).toBeGreaterThan(1));
    expect(setChannelPolicy).not.toHaveBeenCalled();
  });

  it('explains that scheduling gates the download, not discovery', async () => {
    install(fakeBridge());
    render(
      <>
        <ChannelsScreen />
        <Toasts />
      </>,
    );
    await screen.findByText('Lofi Channel');
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Discovery never stops/i)).toBeTruthy();
  });
});

describe('channels screen — bulk policy', () => {
  it('applies a mode to every selected channel in one bulk call', async () => {
    const bulkChannelPolicy = vi.fn(async () => ok({ updated: 2 }));
    install(
      fakeBridge({
        bulkChannelPolicy,
        listChannels: async () => ok([channel({ channel_id: UC }), channel({ id: 2, channel_id: '@other', title: 'Other' })]),
      }),
    );
    render(
      <>
        <ChannelsScreen />
        <Toasts />
      </>,
    );

    await screen.findByText('Lofi Channel');
    fireEvent.click(screen.getByLabelText('Select Lofi Channel'));
    fireEvent.click(screen.getByLabelText('Select Other'));
    fireEvent.click(await screen.findByRole('button', { name: 'Make manual' }));

    await waitFor(() => expect(bulkChannelPolicy).toHaveBeenCalledTimes(1));
    expect(bulkChannelPolicy).toHaveBeenCalledWith({ channel_ids: [UC, '@other'], mode: 'manual' });
  });
});

describe('channels screen — mode filter', () => {
  it('filters the visible list by mode', async () => {
    install(
      fakeBridge({
        listChannels: async () =>
          ok([channel({ channel_id: UC }), channel({ id: 2, channel_id: '@manual', title: 'Manual One', mode: 'manual' })]),
      }),
    );
    render(
      <>
        <ChannelsScreen />
        <Toasts />
      </>,
    );
    expect(await screen.findByText('Manual One')).toBeTruthy();

    fireEvent.click(within(screen.getByRole('group', { name: /Filter channels/i })).getByRole('button', { name: /Manual/ }));
    await waitFor(() => expect(screen.queryByText('Lofi Channel')).toBeNull());
    expect(screen.getByText('Manual One')).toBeTruthy();
  });
});

describe('channels screen — subscriptions import', () => {
  it('defaults to Takeout and never offers the feed option when cookies are absent', async () => {
    install(fakeBridge({ subscriptionsStatus: async () => ok({ cookies_configured: false }) }));
    render(
      <>
        <ChannelsScreen />
        <Toasts />
      </>,
    );
    await screen.findByText('Lofi Channel');
    fireEvent.click(screen.getByRole('button', { name: /import subscriptions/i }));

    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByLabelText(/Source/i) as HTMLInputElement).value).toBe('takeout');
    // The feed option is disabled rather than silently failing later.
    const feed = within(dialog).getByRole('option', { name: /Your YouTube account/i }) as HTMLInputElement;
    expect(feed.disabled).toBe(true);
    // And the reason is explained rather than left to a raw 400.
    expect(within(dialog).getByText(/YTMON_COOKIES_FILE/)).toBeTruthy();
  });

  it('sends the pasted Takeout payload and reports imported/updated/skipped', async () => {
    const importSubscriptions = vi.fn(async (_body: SubscriptionImportRequest) =>
      ok({ source: 'takeout', imported: 300, updated: 4, skipped: 2, total: 306, errors: [] } as SubscriptionImportResult),
    );
    install(fakeBridge({ importSubscriptions }));
    render(
      <>
        <ChannelsScreen />
        <Toasts />
      </>,
    );
    await screen.findByText('Lofi Channel');
    fireEvent.click(screen.getByRole('button', { name: /import subscriptions/i }));

    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/subscriptions\.json/i), {
      target: { value: '[{"contentDetails":{"channelId":"UC…"}}]' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import' }));

    await waitFor(() => expect(importSubscriptions).toHaveBeenCalled());
    expect(importSubscriptions.mock.calls[0]![0]).toEqual({
      source: 'takeout',
      data: '[{"contentDetails":{"channelId":"UC…"}}]',
    });
    expect(await within(dialog).findByText('300')).toBeTruthy();
    expect(within(dialog).getByText('4')).toBeTruthy();
    expect(within(dialog).getByText('2')).toBeTruthy();
  });

  it('tells the user imported channels are manual, not automatic', async () => {
    install(fakeBridge());
    render(
      <>
        <ChannelsScreen />
        <Toasts />
      </>,
    );
    await screen.findByText('Lofi Channel');
    fireEvent.click(screen.getByRole('button', { name: /import subscriptions/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/subscriptions\.json/i), { target: { value: '[]' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
    expect(await within(dialog).findByText(/manual/i)).toBeTruthy();
  });

  it('shows the last import line from the status endpoint', async () => {
    install(
      fakeBridge({
        subscriptionsStatus: async () =>
          ok({ cookies_configured: true, last_import_at: '2026-10-10T12:00:00Z', last_import_source: 'takeout' }),
      }),
    );
    render(
      <>
        <ChannelsScreen />
        <Toasts />
      </>,
    );
    expect(await screen.findByText(/Last imported .* from takeout/i)).toBeTruthy();
  });
});

describe('scan result `held`', () => {
  it('is reported as information, not as a failure', async () => {
    install(fakeBridge({ scanChannel: async () => ok({ channels_scanned: 1, discovered: 2, queued: 0, duplicates: 0, filtered: 0, held: 2, errors: [] }) }));
    render(
      <>
        <ChannelsScreen />
        <Toasts />
      </>,
    );
    await screen.findByText('Lofi Channel');
    fireEvent.click(screen.getByRole('button', { name: /scan now/i }));
    const toast = await screen.findByText(/2 held for later/i);
    expect(toast.textContent).not.toMatch(/error|failed/i);
    expect(toast.textContent).toMatch(/nothing downloaded/i);
  });
});
/**
 * Regressions found by review. Each failed before the fix; the first one
 * silently destroyed whatever the user had typed.
 */
describe('bulk policy modal — regressions', () => {
  const openBulk = async () => {
    const bulkChannelPolicy = vi.fn(async () => ok({ updated: 2 }));
    const listChannels = vi.fn(async () =>
      ok([channel({ channel_id: UC }), channel({ id: 2, channel_id: '@other', title: 'Other' })]),
    );
    install(fakeBridge({ bulkChannelPolicy, listChannels }));
    render(
      <>
        <ChannelsScreen />
        <Toasts />
      </>,
    );
    await screen.findByText('Lofi Channel');
    fireEvent.click(screen.getByLabelText('Select Lofi Channel'));
    fireEvent.click(screen.getByLabelText('Select Other'));
    fireEvent.click(await screen.findByRole('button', { name: 'Set schedule…' }));
    return { bulkChannelPolicy, listChannels, dialog: await screen.findByRole('dialog') };
  };

  it('keeps in-progress input when the screen polls in the background', async () => {
    // The channels list is replaced by a 25s background poll. ChannelsScreen
    // rebuilds the selected-id array each time, which used to re-run the
    // modal's reset effect and wipe the form roughly every 25 seconds.
    const { dialog, listChannels } = await openBulk();
    fireEvent.click(within(dialog).getByRole('switch', { name: /Set a download schedule/i }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mon' }));
    fireEvent.change(within(dialog).getByLabelText(/Time \(24h, local\)/i), { target: { value: '08:30' } });

    // Same selection, new array identity — exactly what a poll produces.
    const before = listChannels.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    // Wait for the refetch to actually land. Without this the assertion runs
    // before the async poll resolves and passes against the very bug it is
    // meant to catch.
    await waitFor(() => expect(listChannels.mock.calls.length).toBeGreaterThan(before));
    // The section must still be there, with the user's values intact.
    await waitFor(() => expect(within(dialog).getByLabelText(/Time \(24h, local\)/i)).toBeTruthy());
    expect((within(dialog).getByLabelText(/Time \(24h, local\)/i) as HTMLInputElement).value).toBe('08:30');
    expect(within(dialog).getByRole('button', { name: 'Mon' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(dialog).getByRole('switch', { name: /Set a download schedule/i }).getAttribute('aria-checked')).toBe('true');
  });

  it('refuses to apply an invalid time instead of clearing the stored one', async () => {
    // "25:00" previously became schedule_time:null — a valid "any time"
    // schedule — and was written to every selected channel.
    const { bulkChannelPolicy, dialog } = await openBulk();
    fireEvent.click(within(dialog).getByRole('switch', { name: /Set a download schedule/i }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mon' }));
    fireEvent.change(within(dialog).getByLabelText(/Time \(24h, local\)/i), { target: { value: '25:00' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^Apply to/ }));

    await waitFor(() => expect(within(dialog).getAllByText(/24-hour HH:MM/i).length).toBeGreaterThan(1));
    expect(bulkChannelPolicy).not.toHaveBeenCalled();
  });
});

describe('single-channel policy modal — regressions', () => {
  it('does not destroy a stored schedule when saving an untouched manual channel', async () => {
    // A manual channel can legitimately hold schedule_enabled:true; flipping
    // it back to auto should restore that schedule, so an untouched save
    // must not send schedule_enabled:false.
    const setChannelPolicy = vi.fn(async (_id: string, _b: unknown) => ok(channel()));
    install(
      fakeBridge({
        setChannelPolicy,
        listChannels: async () => ok([channel({ mode: 'manual', schedule_enabled: true, schedule_days: ['mon'], schedule_time: '08:30' })]),
      }),
    );
    render(<ChannelsScreen />);
    await screen.findByText('Lofi Channel');
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(setChannelPolicy).toHaveBeenCalled());
    expect(setChannelPolicy.mock.calls[0]![1]).not.toHaveProperty('schedule_enabled');
  });
});
