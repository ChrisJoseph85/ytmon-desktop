import { useEffect, useState } from 'react';
import { Alert, Badge, Button, EmptyState, Field, Loading, Modal, Select } from '../components/ui';
import { api, toast, type MediaType, type Quality, type Source, type SourcePreview, type SourcesStatus } from '../lib/bridge';
import { usePolling } from '../lib/hooks';
import { qualityLabelsFrom } from '../lib/labels';
import { formatDateTime } from '@shared/format';

/**
 * Playlists and Watch Later.
 *
 * The empty state matters here: Watch Later is a virtual playlist only the
 * account owner can read, so it is legitimately empty until YouTube cookies are
 * configured on the phone. An unexplained empty list is the single most likely
 * bug report, so it is called out explicitly.
 */
export function SourcesScreen() {
  const sources = usePolling(() => api.listSources(), 30_000);
  const [status, setStatus] = useState<SourcesStatus | null>(null);
  const [options, setOptions] = useState<{ value: string; label: string }[]>([]);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Source | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Source | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadStatus = () => {
    void api.sourcesStatus().then(setStatus).catch(() => undefined);
  };

  useEffect(() => {
    loadStatus();
    void api.qualityOptions().then((q) => setOptions(qualityLabelsFrom(q.options))).catch(() => undefined);
  }, []);

  const list = sources.data ?? [];

  const scan = async (s: Source) => {
    setBusyId(s.source_id);
    try {
      await api.scanSource(s.source_id);
      toast.success(`Scanned ${s.title ?? s.source_id}. New items appear as downloads.`);
      sources.refresh();
      loadStatus();
    } catch (e) {
      toast.fromError(e);
    } finally {
      setBusyId(null);
    }
  };

  const scanAll = async () => {
    setBusyId('__all__');
    try {
      const r = await api.scanAllSources();
      const totals = r.results.reduce(
        (acc, s) => ({ new: acc.new + s.new, queued: acc.queued + s.queued, dupes: acc.dupes + s.duplicates }),
        { new: 0, queued: 0, dupes: 0 },
      );
      const failed = r.results.filter((s) => s.error).length;
      toast.success(`${r.results.length} sources: ${totals.new} new, ${totals.queued} queued, ${totals.dupes} duplicates${failed ? `, ${failed} errored` : ''}.`);
      sources.refresh();
      loadStatus();
    } catch (e) {
      toast.fromError(e);
    } finally {
      setBusyId(null);
    }
  };

  const toggle = async (s: Source) => {
    try {
      await api.updateSource(s.source_id, { enabled: !s.enabled });
      toast.success(s.enabled ? 'Source paused.' : 'Source enabled.');
      sources.refresh();
      loadStatus();
    } catch (e) {
      toast.fromError(e);
    }
  };

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row row-wrap">
        <span className="muted">
          {list.length} source{list.length === 1 ? '' : 's'}
          {status ? ` · ${status.enabled} enabled` : ''}
        </span>
        {status && !status.cookies_configured ? (
          <Badge tone="warn" title="Set YTMON_COOKIES_FILE on the phone">
            YouTube cookies not configured
          </Badge>
        ) : (
          <Badge tone="success">Cookies configured</Badge>
        )}
        {status?.running ? <Badge tone="info">sources worker running</Badge> : null}
        <span className="spacer" />
        <Button onClick={() => { sources.refresh(); loadStatus(); }} loading={sources.loading}>
          Refresh
        </Button>
        <Button onClick={() => void scanAll()} loading={busyId === '__all__'} disabled={list.length === 0}>
          Scan all
        </Button>
        <Button variant="primary" onClick={() => setAdding(true)}>
          Subscribe
        </Button>
      </div>

      {status?.last_error ? <Alert tone="warn">Last sources error: {status.last_error}</Alert> : null}
      {sources.error ? <Alert tone="danger">{sources.error}</Alert> : null}

      {status && !status.cookies_configured && list.length === 0 ? (
        <Alert tone="info">
          <strong>Watch Later needs your YouTube cookies on the phone.</strong>
          <p style={{ marginTop: 6 }}>
            Watch Later is a private, virtual playlist — only your own signed-in account can read it, so the
            server needs <span className="mono">YTMON_COOKIES_FILE</span> pointing at your exported cookies.
            Without them an empty list is the correct result, not a bug.
          </p>
          <p className="tiny faint" style={{ marginTop: 6 }}>
            Regular public playlists work without cookies.
          </p>
        </Alert>
      ) : null}

      {sources.loading && list.length === 0 ? (
        <Loading />
      ) : list.length === 0 ? (
        <EmptyState icon="☰" title="No playlists yet">
          <p className="muted">
            Subscribe to a playlist and the server downloads anything newly added to it, at that playlist's own
            quality setting.
          </p>
        </EmptyState>
      ) : (
        <div className="grid-2">
          {list.map((s) => {
            const c = s.counts ?? { total: 0, downloaded: 0, failed: 0 };
            const okPct = c.total > 0 ? (c.downloaded / c.total) * 100 : 0;
            const badPct = c.total > 0 ? (c.failed / c.total) * 100 : 0;
            const override = s.quality_override;
            return (
              <div key={s.source_id} className={`source-card${s.enabled ? '' : ' disabled'}`}>
                <div className="row" style={{ alignItems: 'flex-start' }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <h3 className="truncate" title={s.title ?? s.source_id}>
                      {s.title || s.source_id}
                    </h3>
                    <div className="tiny faint mono truncate">{s.source_id}</div>
                  </div>
                  <Badge tone={s.kind === 'watch_later' ? 'accent' : 'info'}>{s.kind.replace('_', ' ')}</Badge>
                  <Badge tone={s.enabled ? 'success' : 'default'} dot>
                    {s.enabled ? 'Enabled' : 'Paused'}
                  </Badge>
                </div>

                <div>
                  <div className="row tiny" style={{ marginBottom: 4 }}>
                    <span className="muted">
                      {c.downloaded} of {c.total} downloaded
                      {c.failed > 0 ? `, ${c.failed} failed` : ''}
                    </span>
                    <span className="spacer" />
                    <span className="tiny faint">Last check {formatDateTime(s.last_checked_at)}</span>
                  </div>
                  <div className="count-bar">
                    <span className="ok" style={{ width: `${okPct}%` }} />
                    <span className="bad" style={{ width: `${badPct}%` }} />
                    <span className="rest" style={{ width: `${Math.max(0, 100 - okPct - badPct)}%` }} />
                  </div>
                </div>

                <div className="row row-wrap" style={{ gap: 6 }}>
                  {override?.quality ? (
                    <Badge tone="accent">Override: {override.quality}</Badge>
                  ) : (
                    <Badge>Uses global quality</Badge>
                  )}
                  {override?.media_type ? <Badge tone="accent">{override.media_type}</Badge> : null}
                </div>

                <div className="row row-wrap">
                  <Button size="sm" onClick={() => setEditing(s)}>
                    Edit
                  </Button>
                  <Button size="sm" disabled={!s.enabled} loading={busyId === s.source_id} onClick={() => void scan(s)}>
                    Scan now
                  </Button>
                  <Button size="sm" onClick={() => void toggle(s)}>
                    {s.enabled ? 'Pause' : 'Enable'}
                  </Button>
                  <span className="spacer" />
                  <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(s)} aria-label={`Remove ${s.title}`}>
                    🗑
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <AddSourceModal
        open={adding}
        options={options}
        cookiesConfigured={status?.cookies_configured ?? false}
        onClose={() => setAdding(false)}
        onDone={() => {
          setAdding(false);
          sources.refresh();
          loadStatus();
        }}
      />

      <EditSourceModal
        source={editing}
        options={options}
        onClose={() => setEditing(null)}
        onDone={() => {
          setEditing(null);
          sources.refresh();
        }}
      />

      <Modal
        open={confirmDelete !== null}
        title="Unsubscribe?"
        onClose={() => setConfirmDelete(null)}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                const s = confirmDelete;
                setConfirmDelete(null);
                if (!s) return;
                void api
                  .deleteSource(s.source_id)
                  .then(() => {
                    toast.success('Unsubscribed. Already-downloaded items are kept.');
                    sources.refresh();
                    loadStatus();
                  })
                  .catch((e: Error) => toast.fromError(e));
              }}
            >
              Unsubscribe
            </Button>
          </>
        }
      >
        <Alert tone="warn">
          The server stops watching <strong>{confirmDelete?.title ?? confirmDelete?.source_id}</strong>. Videos
          already in the library are not deleted.
        </Alert>
      </Modal>
    </div>
  );
}

function AddSourceModal({
  open,
  options,
  cookiesConfigured,
  onClose,
  onDone,
}: {
  open: boolean;
  options: { value: string; label: string }[];
  cookiesConfigured: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [url, setUrl] = useState('');
  const [quality, setQuality] = useState('');
  const [mediaType, setMediaType] = useState<MediaType>('video');
  const [useOverride, setUseOverride] = useState(false);
  const [preview, setPreview] = useState<SourcePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setUrl('');
      setPreview(null);
      setError(null);
    }
  }, [open]);

  const wantsWatchLater = /watch.?later|^WL$/i.test(url.trim());

  const doPreview = async () => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await api.previewSource(url.trim()));
    } catch (e) {
      setPreview(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.createSource({
        url: url.trim(),
        quality_override: useOverride
          ? { ...(quality ? { quality: quality as Quality } : {}), media_type: mediaType }
          : null,
      });
      toast.success('Subscribed.');
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
      title="Subscribe to a playlist"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button loading={busy} disabled={!url.trim()} onClick={() => void doPreview()}>
            Preview
          </Button>
          <Button variant="primary" loading={busy} disabled={!url.trim()} onClick={() => void submit()}>
            Subscribe
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field
          label="Playlist URL or id"
          htmlFor="source-url"
          error={error}
          hint={
            <>
              A full playlist URL, a bare <span className="mono">PL…</span> id, or{' '}
              <span className="mono">watch_later</span>. A channel or single-video URL is rejected.
            </>
          }
        >
          <input
            id="source-url"
            className="input input-mono"
            value={url}
            placeholder="https://www.youtube.com/playlist?list=PL..."
            autoFocus
            onChange={(e) => {
              setUrl(e.target.value);
              setPreview(null);
            }}
          />
        </Field>

        {wantsWatchLater && !cookiesConfigured ? (
          <Alert tone="warn">
            <strong>Watch Later needs YouTube cookies on the server.</strong>
            <p style={{ marginTop: 4 }}>
              Set <span className="mono">YTMON_COOKIES_FILE</span> in Termux, otherwise this subscribes fine
              but always returns an empty list.
            </p>
          </Alert>
        ) : null}

        {preview ? (
          <div className="card" style={{ padding: 14, background: 'var(--surface-2)' }}>
            <div className="row row-wrap" style={{ gap: '6px 14px', marginBottom: 6 }}>
              <Badge tone={preview.kind === 'watch_later' ? 'accent' : 'info'}>{preview.kind.replace('_', ' ')}</Badge>
              <strong className="truncate">{preview.title ?? preview.source_id}</strong>
              <span className="muted">{preview.count} item(s)</span>
              {preview.truncated ? <Badge tone="warn">Truncated</Badge> : null}
              {preview.cookies_required ? <Badge tone="warn">Needs cookies</Badge> : null}
            </div>
            {preview.entries.length > 0 ? (
              <div className="result-list">
                {preview.entries.slice(0, 12).map((e, i) => (
                  <div key={i} className="result-row">
                    <span className="truncate">{e.title ?? e.video_id ?? e.url ?? `item ${i + 1}`}</span>
                  </div>
                ))}
              </div>
            ) : preview.count === 0 ? (
              <p className="tiny faint">This playlist is empty right now. Subscribing still works — the server
                will pick up anything added later.</p>
            ) : null}
          </div>
        ) : null}

        <div className="toggle-row">
          <Button size="sm" variant={useOverride ? 'primary' : 'default'} onClick={() => setUseOverride((v) => !v)}>
            {useOverride ? 'Using a per-source override' : 'Use the global quality'}
          </Button>
          <div>
            <strong>Per-source quality</strong>
            <div className="hint">
              A source override wins over the global setting for anything found in this playlist. Omitted fields
              inherit the global value.
            </div>
          </div>
        </div>

        {useOverride ? (
          <div className="grid-2">
            <Select
              label="Quality"
              value={quality}
              onChange={setQuality}
              options={[{ value: '', label: 'Inherit global quality' }, ...options.map((o) => ({ value: o.value, label: o.label }))]}
            />
            <div className="field">
              <span className="label">Store as</span>
              <div className="media-toggle">
                <button type="button" aria-pressed={mediaType === 'video'} onClick={() => setMediaType('video')}>
                  Video
                </button>
                <button type="button" aria-pressed={mediaType === 'audio'} onClick={() => setMediaType('audio')}>
                  Audio
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

function EditSourceModal({
  source,
  options,
  onClose,
  onDone,
}: {
  source: Source | null;
  options: { value: string; label: string }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [title, setTitle] = useState('');
  const [quality, setQuality] = useState('');
  const [mediaType, setMediaType] = useState<MediaType>('video');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (source) {
      setTitle(source.title ?? '');
      setQuality(source.quality_override?.quality ?? '');
      setMediaType(source.quality_override?.media_type ?? 'video');
      setError(null);
    }
  }, [source]);

  const save = async () => {
    if (!source) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateSource(source.source_id, {
        ...(title !== (source.title ?? '') ? { title: title || null } : {}),
        // Sending {} clears the override and inherits the global values.
        quality_override: quality || mediaType !== 'video' ? { ...(quality ? { quality: quality as Quality } : {}), media_type: mediaType } : null,
      });
      toast.success('Source updated on the phone.');
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={source !== null}
      title={`Edit ${source?.title ?? source?.source_id ?? ''}`}
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
        <Field label="Display title" htmlFor="edit-source-title" error={error}>
          <input id="edit-source-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <p className="tiny faint">
          This override wins over the global setting for items in this source. Changing it does not change the
          global quality, and vice versa.
        </p>
        <div className="grid-2">
          <Select
            label="Quality override"
            value={quality}
            onChange={setQuality}
            options={[{ value: '', label: 'Inherit global' }, ...options.map((o) => ({ value: o.value, label: o.label }))]}
          />
          <div className="field">
            <span className="label">Store as</span>
            <div className="media-toggle">
              <button type="button" aria-pressed={mediaType === 'video'} onClick={() => setMediaType('video')}>
                Video
              </button>
              <button type="button" aria-pressed={mediaType === 'audio'} onClick={() => setMediaType('audio')}>
                Audio
              </button>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}