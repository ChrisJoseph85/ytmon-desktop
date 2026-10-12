import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Field, Loading, Modal, PillGroup, Select, Switch } from '../components/ui';
import { api, toast, type ChannelShape, type SubscriptionsStatus } from '../lib/bridge';
import { usePolling } from '../lib/hooks';
import { BulkAddModal } from '../components/BulkAddModal';
import { PolicyEditorModal, BulkPolicyModal } from '../components/PolicyEditorModal';
import {
  CookiesBadge,
  ImportSubscriptionsModal,
  LastImportLine,
} from '../components/ImportSubscriptionsModal';
import { qualityLabelsFrom } from '../lib/labels';
import { pickCanonicalUrl, pickChannelId } from '../lib/channel-url';
import { formatDateTime } from '@shared/format';
import {
  channelMode,
  describePolicy,
  filterChannels,
  isScheduled,
  scheduleSummary,
  channelScheduleDays,
  type ChannelFilter,
} from '@shared/schedule';
import type { MediaType, Quality } from '@shared/types';

/** Stable empty array so the memos below do not re-run on every render. */
const EMPTY_CHANNELS: ChannelShape[] = [];

export function ChannelsScreen() {
  const channels = usePolling(() => api.listChannels(), 25_000);
  const [options, setOptions] = useState<{ value: string; label: string }[]>([]);
  const [editing, setEditing] = useState<ChannelShape | null>(null);
  const [policyFor, setPolicyFor] = useState<ChannelShape | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<ChannelShape | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [subStatus, setSubStatus] = useState<SubscriptionsStatus | null>(null);
  const [filter, setFilter] = useState<ChannelFilter>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkPolicyOpen, setBulkPolicyOpen] = useState(false);

  useEffect(() => {
    void api
      .qualityOptions()
      .then((q) => setOptions(qualityLabelsFrom(q.options)))
      .catch(() => undefined);
    void api.subscriptionsStatus().then(setSubStatus).catch(() => undefined);
  }, []);

  const scan = async (c: ChannelShape) => {
    try {
      const r = await api.scanChannel(c.channel_id);
      const parts = [`${r.discovered} new`, `${r.queued} queued`, `${r.duplicates} duplicates skipped`];
      // `held` is an outcome, not a failure: the uploads WERE discovered, they
      // just were not downloaded because the channel is manual or not due.
      if (r.held && r.held > 0) parts.push(`${r.held} held for later`);
      // discovered 0 + a big filtered count almost always means the server's
      // publication window is narrower than the channel's upload cadence.
      if (r.discovered === 0 && r.filtered > 0) {
        const m = await api.getMonitor().catch(() => null);
        parts.push(`${r.filtered} filtered by the ${m?.window_hours ?? '?'}h publication window`);
        toast.info(`${c.title || c.channel_id}: nothing new. ${parts.join(' · ')} — widen it in Settings → Monitoring if this channel uploads rarely.`);
      } else if (r.held && r.held > 0 && r.queued === 0) {
        toast.info(
          `${c.title || c.channel_id}: ${parts.join(' · ')}. Nothing downloaded — the channel is manual or not due yet.`,
        );
      } else {
        toast.success(`${c.title || c.channel_id}: ${parts.join(' · ')}.`);
      }
      channels.refresh();
    } catch (e) {
      toast.fromError(e);
    }
  };

  const setMode = async (c: ChannelShape, mode: 'auto' | 'manual') => {
    try {
      await api.setChannelPolicy(c.channel_id, { mode });
      toast.success(
        mode === 'manual'
          ? `${c.title || c.channel_id} is manual. Uploads are still discovered — fetch one to download it.`
          : `${c.title || c.channel_id} is automatic again.`,
      );
      channels.refresh();
    } catch (e) {
      toast.fromError(e);
    }
  };

  const list = channels.data ?? EMPTY_CHANNELS;
  const visible = useMemo(() => filterChannels(list, filter), [list, filter]);
  const counts = useMemo(
    () => ({
      all: list.length,
      auto: list.filter((c) => channelMode(c) === 'auto').length,
      manual: list.filter((c) => channelMode(c) === 'manual').length,
      scheduled: list.filter((c) => isScheduled(c)).length,
    }),
    [list],
  );

  const selectedIds = useMemo(() => [...selected].filter((id) => list.some((c) => c.channel_id === id)), [selected, list]);

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const refreshAll = () => {
    channels.refresh();
    void api.subscriptionsStatus().then(setSubStatus).catch(() => undefined);
  };

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row">
        <span className="muted">
          {list.length} channel{list.length === 1 ? '' : 's'} tracked
        </span>
        <span className="spacer" />
        <Button onClick={refreshAll} loading={channels.loading}>
          Refresh
        </Button>
        <Button onClick={() => setBulkOpen(true)} title="Paste or import a whole list of channels">
          Add in bulk
        </Button>
        <Button onClick={() => setImportOpen(true)} title="Import your YouTube subscriptions (Takeout or feed)">
          Import subscriptions
        </Button>
        <Button variant="primary" onClick={() => setAdding(true)}>
          Add channel
        </Button>
      </div>

      <div className="row row-wrap" style={{ gap: 10 }}>
        <PillGroup
          value={filter}
          ariaLabel="Filter channels"
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All', count: counts.all },
            { value: 'auto', label: 'Auto', count: counts.auto },
            { value: 'manual', label: 'Manual', count: counts.manual },
            { value: 'scheduled', label: 'Scheduled', count: counts.scheduled },
          ]}
        />
        <span className="spacer" />
        <LastImportLine status={subStatus} />
        <CookiesBadge status={subStatus} />
      </div>

      {selectedIds.length > 0 ? (
        <div className="row row-wrap" style={{ gap: 8 }}>
          <Badge tone="accent">{selectedIds.length} selected</Badge>
          <Button
            size="sm"
            onClick={() =>
              void api
                .bulkChannelPolicy({ channel_ids: selectedIds, mode: 'auto' })
                .then((r) => {
                  toast.success(`Made ${r.updated} channel${r.updated === 1 ? '' : 's'} automatic.`);
                  setSelected(new Set());
                  channels.refresh();
                })
                .catch((e: Error) => toast.fromError(e))
            }
          >
            Make automatic
          </Button>
          <Button
            size="sm"
            onClick={() =>
              void api
                .bulkChannelPolicy({ channel_ids: selectedIds, mode: 'manual' })
                .then((r) => {
                  toast.success(`Made ${r.updated} channel${r.updated === 1 ? '' : 's'} manual. Their uploads are still discovered.`);
                  setSelected(new Set());
                  channels.refresh();
                })
                .catch((e: Error) => toast.fromError(e))
            }
          >
            Make manual
          </Button>
          <Button size="sm" onClick={() => setBulkPolicyOpen(true)}>
            Set schedule…
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      ) : null}

      {channels.error ? <Alert tone="danger">{channels.error}</Alert> : null}

      {channels.loading && list.length === 0 ? (
        <Loading />
      ) : list.length === 0 ? (
        <Card>
          <p className="muted">
            No channels yet. Add one by pasting a channel URL or id, or import your whole YouTube subscription list —
            the server resolves them and schedules downloads itself.
          </p>
        </Card>
      ) : visible.length === 0 ? (
        <Card>
          <p className="muted">No channels match this filter.</p>
        </Card>
      ) : (
        <div className="grid-2">
          {visible.map((c) => {
            const mode = channelMode(c);
            const scheduled = isScheduled(c);
            const days = channelScheduleDays(c);
            return (
              <Card key={c.channel_id}>
                <div className="row" style={{ alignItems: 'flex-start' }}>
                  <input
                    type="checkbox"
                    className="checkbox"
                    aria-label={`Select ${c.title ?? c.channel_id}`}
                    checked={selected.has(c.channel_id)}
                    onChange={() => toggleSelect(c.channel_id)}
                    style={{ marginTop: 4 }}
                  />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <h3 className="truncate" title={c.title ?? c.channel_id}>
                      {c.title || c.channel_id}
                    </h3>
                    <div className="tiny faint mono truncate">{c.url}</div>
                  </div>
                  <Badge tone={c.enabled ? 'success' : 'default'} dot>
                    {c.enabled ? 'Enabled' : 'Paused'}
                  </Badge>
                </div>
                <div className="row row-wrap tiny faint" style={{ marginTop: 8, gap: 10 }}>
                  <span>Last checked: {formatDateTime(c.last_checked_at)}</span>
                  <span>Last upload: {formatDateTime(c.last_uploaded_at)}</span>
                  {c.quality_override?.quality ? (
                    <Badge tone="accent">Override: {c.quality_override.quality}</Badge>
                  ) : (
                    <Badge>Uses global quality</Badge>
                  )}
                  {c.quality_override?.media_type ? <Badge tone="accent">{c.quality_override.media_type}</Badge> : null}
                </div>

                <div className="row row-wrap" style={{ marginTop: 10, gap: 8 }}>
                  <div className="media-toggle" role="group" aria-label={`Downloads for ${c.title ?? c.channel_id}`}>
                    <button
                      type="button"
                      aria-pressed={mode === 'auto'}
                      onClick={() => void setMode(c, 'auto')}
                      title="Discover and download automatically"
                    >
                      Auto
                    </button>
                    <button
                      type="button"
                      aria-pressed={mode === 'manual'}
                      onClick={() => void setMode(c, 'manual')}
                      title="Still discovered, never downloaded automatically"
                    >
                      Manual
                    </button>
                  </div>
                  {scheduled ? (
                    <Badge tone="accent" title={describePolicy(c)}>
                      {scheduleSummary(days, c.schedule_time ?? null)}
                    </Badge>
                  ) : null}
                  {/* due_now / next_due are server-computed; read them, never derive. */}
                  {mode === 'auto' && c.due_now ? (
                    <Badge tone="success" title="Computed by the server">
                      Due now
                    </Badge>
                  ) : null}
                  {mode === 'auto' && !c.due_now && c.next_due ? (
                    <Badge title="Computed by the server">Next: {c.next_due}</Badge>
                  ) : null}
                </div>

                {mode === 'manual' ? (
                  <div className="tiny faint" style={{ marginTop: 6 }}>
                    Uploads are still discovered and show up in the library — fetch one to download it.
                  </div>
                ) : null}

                <div className="row" style={{ marginTop: 12 }}>
                  <Button size="sm" onClick={() => setEditing(c)}>
                    Edit
                  </Button>
                  <Button size="sm" onClick={() => setPolicyFor(c)} title="Auto/manual and download schedule">
                    Schedule
                  </Button>
                  <Button size="sm" disabled={!c.enabled} onClick={() => void scan(c)} title={c.enabled ? '' : 'Channel is disabled'}>
                    Scan now
                  </Button>
                  <Button
                    size="sm"
                    onClick={() =>
                      void api
                        .updateChannel(c.channel_id, { enabled: !c.enabled })
                        .then(() => {
                          toast.success(c.enabled ? 'Channel paused.' : 'Channel enabled.');
                          channels.refresh();
                        })
                        .catch((e: Error) => toast.error(e.message))
                    }
                  >
                    {c.enabled ? 'Pause' : 'Enable'}
                  </Button>
                  <span className="spacer" />
                  <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(c)} aria-label={`Remove ${c.title}`}>
                    🗑
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <BulkAddModal
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        onDone={() => {
          setBulkOpen(false);
          channels.refresh();
        }}
      />
      <ImportSubscriptionsModal
        open={importOpen}
        status={subStatus}
        onClose={() => setImportOpen(false)}
        onDone={refreshAll}
      />
      <AddChannelModal
        open={adding}
        options={options}
        onClose={() => setAdding(false)}
        onDone={() => {
          setAdding(false);
          channels.refresh();
        }}
      />
      <EditChannelModal
        channel={editing}
        options={options}
        onClose={() => setEditing(null)}
        onDone={() => {
          setEditing(null);
          channels.refresh();
        }}
      />
      <PolicyEditorModal
        channel={policyFor}
        onClose={() => setPolicyFor(null)}
        onDone={() => {
          setPolicyFor(null);
          channels.refresh();
        }}
      />
      {bulkPolicyOpen && selectedIds.length > 0 ? (
        <BulkPolicyModal
          channelIds={selectedIds}
          onClose={() => setBulkPolicyOpen(false)}
          onDone={() => {
            setBulkPolicyOpen(false);
            setSelected(new Set());
            channels.refresh();
          }}
        />
      ) : null}
      <Modal
        open={confirmDelete !== null}
        title="Remove channel?"
        onClose={() => setConfirmDelete(null)}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                const c = confirmDelete;
                setConfirmDelete(null);
                if (!c) return;
                void api
                  .deleteChannel(c.channel_id)
                  .then(() => {
                    toast.success('Channel removed. Already-downloaded videos are kept.');
                    channels.refresh();
                  })
                  .catch((e: Error) => toast.error(e.message));
              }}
            >
              Remove channel
            </Button>
          </>
        }
      >
        <Alert tone="warn">
          Monitoring stops for <strong>{confirmDelete?.title ?? confirmDelete?.channel_id}</strong>. Videos already
          in the library are not deleted.
        </Alert>
      </Modal>
    </div>
  );
}

function AddChannelModal({
  open,
  options,
  onClose,
  onDone,
}: {
  open: boolean;
  options: { value: string; label: string }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [url, setUrl] = useState('');
  const [override, setOverride] = useState<Quality | ''>('');
  const [mediaType, setMediaType] = useState<MediaType>('video');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      // Resolve first so a bad URL fails fast with a readable message.
      const resolved = await api.resolveChannel(url.trim());

      // IMPORTANT: the server derives channel_id from the URL you send. If you
      // hand it an @handle it stores "@handle", while discovered videos carry
      // the canonical UC id — so every scan then reports
      // {discovered: 0, filtered: N} and NOTHING is ever found, with no error.
      // Always add using the canonical /channel/UC... URL the resolver returns.
      const canonicalUrl = pickCanonicalUrl(resolved.url) ?? url.trim();
      const canonicalId = pickChannelId(canonicalUrl);

      await api.addChannel({
        url: canonicalUrl,
        // An override is an object: { quality?, media_type? }, never a bare string.
        quality_override: override === '' && mediaType === 'video' ? null : { ...(override ? { quality: override } : {}), media_type: mediaType },
        ...(canonicalId ? { channel_id: canonicalId } : {}),
      });
      toast.success(`Added ${resolved.title ?? canonicalId ?? canonicalUrl}.`);
      setUrl('');
      setOverride('');
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="Add channel"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!url.trim()} onClick={() => void submit()}>
            Add
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field
          label="Channel URL or ID"
          htmlFor="add-channel-url"
          error={error}
          hint="e.g. https://www.youtube.com/@creator or UCxxxxxxxxxxxxxxxxxxxxxx"
        >
          <input
            id="add-channel-url"
            className="input input-mono"
            value={url}
            data-autofocus
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
          />
        </Field>
        <Select
          label="Per-channel quality override"
          value={override}
          onChange={(v) => setOverride(v as Quality | '')}
          hint="Optional. Overrides the global default for this channel only. Stored on the server."
          options={[
            { value: '', label: 'Use global default' },
            ...options.map((o) => ({ value: o.value, label: o.label })),
          ]}
        />
        <div className="field">
          <span className="label">Store as</span>
          <div className="media-toggle">
            <button type="button" aria-pressed={mediaType === 'video'} onClick={() => setMediaType('video')}>
              Video
            </button>
            <button type="button" aria-pressed={mediaType === 'audio'} onClick={() => setMediaType('audio')}>
              Audio (MP3)
            </button>
          </div>
          <span className="hint">
            Part of the channel override object ({'{'}quality, media_type{'}'}). Left as video, this inherits the
            global setting.
          </span>
        </div>
      </div>
    </Modal>
  );
}

function EditChannelModal({
  channel,
  options,
  onClose,
  onDone,
}: {
  channel: ChannelShape | null;
  options: { value: string; label: string }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [title, setTitle] = useState('');
  const [override, setOverride] = useState<Quality | ''>('');
  const [mediaType, setMediaType] = useState<MediaType>('video');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (channel) {
      setTitle(channel.title ?? '');
      setOverride(channel.quality_override?.quality ?? '');
      setMediaType(channel.quality_override?.media_type ?? 'video');
      setError(null);
    }
  }, [channel]);

  const save = async () => {
    if (!channel) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateChannel(channel.channel_id, {
        title: title.trim() || undefined,
        quality_override: override === '' && mediaType === 'video' ? null : { ...(override ? { quality: override } : {}), media_type: mediaType },
      });
      toast.success('Channel updated on the phone.');
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={channel !== null}
      title={`Edit ${channel?.title ?? channel?.channel_id ?? ''}`}
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
        <Field label="Display title" htmlFor="edit-title" error={error}>
          <input id="edit-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Select
          label="Quality override"
          value={override}
          onChange={(v) => setOverride(v as Quality | '')}
          hint="A per-channel override wins over the global default."
          options={[
            { value: '', label: 'Use global default' },
            ...options.map((o) => ({ value: o.value, label: o.label })),
          ]}
        />
        <div className="toggle-row">
          <Switch
            label="Enabled"
            checked={channel?.enabled ?? true}
            onChange={(v) => {
              if (!channel) return;
              void api
                .updateChannel(channel.channel_id, { enabled: v })
                .then(() => {
                  toast.success(v ? 'Channel enabled.' : 'Channel paused.');
                  onDone();
                })
                .catch((e: Error) => toast.error(e.message));
            }}
          />
          <div>
            <strong>Enabled</strong>
            <div className="hint">Disabled channels are skipped by scans (scan returns 409).</div>
          </div>
        </div>
      </div>
    </Modal>
  );
}