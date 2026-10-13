import { useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Field, Modal, Switch } from './ui';
import { api, toast, type ChannelPolicyUpdate, type ChannelShape, type ScheduleDay } from '../lib/bridge';
import {
  DAY_LABELS,
  SCHEDULE_DAYS,
  channelMode,
  channelScheduleDays,
  cleanPolicyPatch,
  describePolicyError,
  scheduleSummary,
  toggleDay,
  validateScheduleTime,
} from '@shared/schedule';

/**
 * Auto / Manual + the per-channel download schedule.
 *
 * Two things this must not get wrong:
 *  - `mode: manual` does NOT stop discovery. Uploads keep appearing in the
 *    library as "discovered"; they are just not downloaded until the user asks.
 *  - `due_now` / `next_due` come from the server and are displayed, never
 *    recomputed here — the server owns the timezone and the window.
 */

export function PolicyEditorModal({
  channel,
  onClose,
  onDone,
}: {
  channel: ChannelShape | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [mode, setMode] = useState<'auto' | 'manual'>('auto');
  const [enabled, setEnabled] = useState(false);
  const [days, setDays] = useState<ScheduleDay[]>([]);
  const [time, setTime] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** True once the user actually touches the schedule switch, so an
   *  untouched save cannot overwrite a schedule the channel already had. */
  const [scheduleDirty, setScheduleDirty] = useState(false);

  useEffect(() => {
    if (!channel) return;
    setMode(channelMode(channel));
    setEnabled(channel.schedule_enabled === true);
    setDays(channelScheduleDays(channel));
    setTime(channel.schedule_time ?? '');
    setScheduleDirty(false);
    setError(null);
  }, [channel]);

  const timeCheck = validateScheduleTime(time);
  const manual = mode === 'manual';
  const scheduled = enabled && !manual && (days.length > 0 || Boolean(timeCheck.normalized));

  const save = async () => {
    if (!channel) return;
    if (!timeCheck.ok) {
      setError(timeCheck.reason ?? 'Invalid time.');
      return;
    }
    setBusy(true);
    setError(null);
    const patch: ChannelPolicyUpdate = cleanPolicyPatch({
      mode,
      // A manual channel never downloads automatically, but it can still hold
      // a schedule: flipping it back to auto should restore it. Sending
      // `schedule_enabled: false` here would silently destroy that stored
      // schedule on an otherwise untouched save, so the flag is left alone
      // unless the user actually changed the switch.
      ...(scheduleDirty ? { schedule_enabled: manual ? false : enabled } : {}),
      schedule_days: days,
      schedule_time: timeCheck.normalized,
    });
    try {
      await api.setChannelPolicy(channel.channel_id, patch);
      toast.success('Channel policy updated on the phone.');
      onDone();
    } catch (e) {
      const err = e as { message?: string; code?: string };
      setError(describePolicyError(err.code ?? '') ?? err.message ?? 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={channel !== null}
      title={`Downloads — ${channel?.title ?? channel?.channel_id ?? ''}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="field">
          <span className="label">Downloads</span>
          <div className="media-toggle" role="group" aria-label="Downloads">
            <button type="button" aria-pressed={mode === 'auto'} onClick={() => setMode('auto')}>
              Automatic
            </button>
            <button type="button" aria-pressed={mode === 'manual'} onClick={() => setMode('manual')}>
              Manual
            </button>
          </div>
          <span className="hint">
            {manual
              ? 'Uploads are still discovered and appear in your library — nothing is downloaded until you fetch it.'
              : 'Uploads are discovered and downloaded automatically, subject to any schedule below.'}
          </span>
        </div>

        <div className="toggle-row">
          <Switch
            label="Only download on a schedule"
            checked={enabled}
            disabled={manual}
            onChange={(v) => {
              setEnabled(v);
              setScheduleDirty(true);
            }}
          />
          <div>
            <strong>Schedule downloads</strong>
            <div className="hint">
              Gates the download only. Discovery never stops — a Monday-scheduled channel still lists its Tuesday
              upload on Tuesday.
            </div>
          </div>
        </div>

        {manual && enabled ? (
          <Alert tone="info">A manual channel never downloads automatically, so the schedule is inactive.</Alert>
        ) : null}

        <Field label="Days" hint="No days selected means every day.">
          <div className="day-chips">
            {SCHEDULE_DAYS.map((d) => (
              <button
                key={d}
                type="button"
                className="pill day-chip"
                aria-pressed={days.includes(d)}
                aria-label={DAY_LABELS[d]}
                disabled={manual}
                onClick={() => {
                  // Computed outside the updater: an updater must stay pure
                  // (React double-invokes it in StrictMode).
                  const next = toggleDay(days, d);
                  setDays(next);
                  // Picking a day implies you want a schedule; without this
                  // the save would send no schedule_enabled at all.
                  if (next.length > 0 && !enabled) {
                    setEnabled(true);
                    setScheduleDirty(true);
                  }
                }}
              >
                {DAY_LABELS[d]}
              </button>
            ))}
          </div>
        </Field>

        <Field
          label="Time (24h, UTC)"
          htmlFor="policy-time"
          hint="Optional. Leave empty for any time on the selected days. The server applies this in UTC."
          error={timeCheck.ok ? null : (timeCheck.reason ?? null)}
        >
          <input
            id="policy-time"
            className={`input${timeCheck.ok ? '' : ' input-error'}`}
            placeholder="08:30"
            value={time}
            disabled={manual}
            onChange={(e) => {
              setTime(e.target.value);
              // Same rule as the day chips: a time that is not applied would
              // be inert, so choosing one turns the schedule on.
              if (!enabled && validateScheduleTime(e.target.value).normalized) {
                setEnabled(true);
                setScheduleDirty(true);
              }
            }}
          />
        </Field>

        {scheduled ? (
          <div className="row row-wrap" style={{ gap: 8 }}>
            <Badge tone="accent">{scheduleSummary(days, timeCheck.normalized)}</Badge>
            {channel ? (
              <Badge tone={channel.due_now ? 'success' : 'default'} title="Computed by the server">
                {channel.due_now ? 'Due now' : channel.next_due ? `Next: ${channel.next_due}` : 'Not due yet'}
              </Badge>
            ) : null}
          </div>
        ) : null}

        {error ? <Alert tone="danger">{error}</Alert> : null}
      </div>
    </Modal>
  );
}

/**
 * Bulk policy: one PATCH-equivalent across many channels. Only the fields the
 * user actually touches are sent, so a "Make manual" run never wipes the
 * schedules of the channels it touches.
 */
export function BulkPolicyModal({
  channelIds,
  onClose,
  onDone,
}: {
  channelIds: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [mode, setMode] = useState<'auto' | 'manual' | 'unchanged'>('unchanged');
  const [enabled, setEnabled] = useState(false);
  const [days, setDays] = useState<ScheduleDay[]>([]);
  const [time, setTime] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset only when the SELECTION actually changes. Keying this on the
  // array itself is a trap: ChannelsScreen passes a freshly built array on
  // every background poll (~25s), so the effect re-ran and silently erased
  // whatever the user had typed. Comparing the contents makes a re-render
  // with the same selection a no-op.
  const selection = channelIds.join(' ');
  const lastSelection = useRef(selection);
  useEffect(() => {
    if (lastSelection.current === selection) return;
    lastSelection.current = selection;
    setMode('unchanged');
    setEnabled(false);
    setDays([]);
    setTime('');
    setError(null);
  }, [selection]);

  const count = channelIds.length;
  const timeCheck = validateScheduleTime(time);

  const apply = async () => {
    // Guard the time exactly like the single-channel editor does. Without
    // this, "25:00" becomes null and silently CLEARS the stored time on every
    // selected channel instead of telling the user what is wrong.
    if (!timeCheck.ok) {
      setError(timeCheck.reason ?? 'Invalid time.');
      return;
    }
    const patch: ChannelPolicyUpdate = cleanPolicyPatch({
      ...(mode === 'unchanged' ? {} : { mode }),
      // Only send schedule fields when the user opted into a schedule.
      ...(enabled ? { schedule_enabled: true, schedule_days: days, schedule_time: timeCheck.normalized ?? null } : {}),
    });
    if (Object.keys(patch).length === 0) {
      setError('Pick at least one thing to change.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api.bulkChannelPolicy({ ...patch, channel_ids: channelIds });
      toast.success(`Updated ${r.updated} of ${count} channel${count === 1 ? '' : 's'}.`);
      onDone();
    } catch (e) {
      const err = e as { message?: string; code?: string };
      setError(describePolicyError(err.code ?? '') ?? err.message ?? 'Could not apply.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={`Apply to ${count} channel${count === 1 ? '' : 's'}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void apply()}>
            Apply to {count}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Alert tone="info">
          Only the settings you change here are sent. Everything else stays exactly as it is on each channel.
        </Alert>

        <div className="field">
          <span className="label">Downloads</span>
          <div className="media-toggle" role="group" aria-label="Downloads">
            <button type="button" aria-pressed={mode === 'auto'} onClick={() => setMode('auto')}>
              Make automatic
            </button>
            <button type="button" aria-pressed={mode === 'manual'} onClick={() => setMode('manual')}>
              Make manual
            </button>
          </div>
          <span className="hint">Neither selected keeps each channel's current mode.</span>
        </div>

        <div className="toggle-row">
          <Switch label="Set a download schedule" checked={enabled} onChange={setEnabled} />
          <div>
            <strong>Set a download schedule</strong>
            <div className="hint">Off leaves each channel's current schedule alone.</div>
          </div>
        </div>

        {enabled ? (
          <>
            <Field label="Days" hint="No days selected means every day.">
              <div className="day-chips">
                {SCHEDULE_DAYS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    className="pill day-chip"
                    aria-pressed={days.includes(d)}
                    aria-label={DAY_LABELS[d]}
                    onClick={() => setDays((prev) => toggleDay(prev, d))}
                  >
                    {DAY_LABELS[d]}
                  </button>
                ))}
              </div>
            </Field>
            <Field
              label="Time (24h, UTC)"
              htmlFor="bulk-policy-time"
              hint="Optional. Leave empty for any time on the selected days. The server applies this in UTC."
              error={timeCheck.ok ? null : (timeCheck.reason ?? null)}
            >
              <input
                id="bulk-policy-time"
                className={`input${timeCheck.ok ? '' : ' input-error'}`}
                placeholder="08:30"
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </Field>
          </>
        ) : null}

        {error ? <Alert tone="danger">{error}</Alert> : null}
      </div>
    </Modal>
  );
}