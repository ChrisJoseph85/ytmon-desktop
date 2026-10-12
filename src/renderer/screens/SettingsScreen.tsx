import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Field, Modal, Select, Switch } from '../components/ui';
import { RetentionConfirm } from '../components/VideoPlayer';
import { api, toast, type MonitorShape, type QualitySettingsShape, type RetentionShape, type RetentionPlan, type StorageShape } from '../lib/bridge';
import { useConnection } from '../state/connection';
import { qualityLabelsFrom, validateDownloadDir, validateSubLangs } from '../lib/labels';
import { formatBytes } from '@shared/format';
import { StorageSettings } from './LibraryBrowser';
import type { Quality } from '@shared/types';

export function SettingsScreen() {
  const { settings, setServerUrl, setToken, setPreferences } = useConnection();

  const [quality, setQuality] = useState<QualitySettingsShape | null>(null);
  const [monitor, setMonitor] = useState<MonitorShape | null>(null);
  const [retention, setRetention] = useState<RetentionShape | null>(null);
  const [plan, setPlan] = useState<RetentionPlan | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [storage, setStorage] = useState<StorageShape | null>(null);
  const [options, setOptions] = useState<{ value: string; label: string }[]>([]);
  const [serverDefault, setServerDefault] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [confirmRetention, setConfirmRetention] = useState(false);
  const [tokenDraft, setTokenDraft] = useState('');
  const [subLangs, setSubLangs] = useState('');
  const [subLangsError, setSubLangsError] = useState<string | null>(null);
  const [downloadDir, setDownloadDir] = useState('');
  const [downloadDirError, setDownloadDirError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .qualityOptions()
      .then((q) => {
        setOptions(qualityLabelsFrom(q.options));
        setServerDefault(q.default);
      })
      .catch(() => undefined);
    void api
      .getQuality()
      .then((q) => {
        setQuality(q);
        setSubLangs(q.sub_langs ?? 'en.*');
        setDownloadDir(q.download_dir ?? '');
      })
      .catch(() => undefined);
    void api.getMonitor().then(setMonitor).catch(() => undefined);
    void api.getRetention().then(setRetention).catch(() => undefined);
    void api.retentionPreview().then(setPlan).catch(() => undefined);
    void api.storage().then(setStorage).catch(() => undefined);
  }, []);

  const saveQuality = async (patch: Partial<QualitySettingsShape>) => {
    setSaving(true);
    try {
      // Write, then re-read: the server is authoritative and the other client
      // may have changed the value concurrently (last-write-wins server side).
      // The server merges only the fields we send, so a partial update is safe;
      // we still re-read so the UI shows the stored value (last-write-wins).
      await api.setQuality(patch);
      const fresh = await api.getQuality();
      setQuality(fresh);
      setSubLangs(fresh.sub_langs ?? 'en.*');
      setDownloadDir(fresh.download_dir ?? '');
      toast.success('Quality settings saved on the phone.');
    } catch (e) {
      toast.fromError(e);
    } finally {
      setSaving(false);
    }
  };

  const saveMonitor = async (patch: Partial<MonitorShape>) => {
    setSaving(true);
    try {
      await api.setMonitor(patch);
      const fresh = await api.getMonitor();
      setMonitor(fresh);
      toast.success('Monitoring settings saved.');
    } catch (e) {
      toast.fromError(e);
    } finally {
      setSaving(false);
    }
  };

  const saveRetention = async (patch: Partial<RetentionShape>) => {
    setSaving(true);
    try {
      await api.setRetention(patch);
      const fresh = await api.getRetention();
      setRetention(fresh);
      // The rules are enforced server-side now, so refresh what they would do.
      setPlan(await api.retentionPreview().catch(() => null));
      toast.success('Retention settings saved.');
    } catch (e) {
      toast.fromError(e);
    } finally {
      setSaving(false);
    }
  };

  const refreshPlan = async () => {
    setPlanBusy(true);
    try {
      setPlan(await api.retentionPreview());
    } catch (e) {
      toast.fromError(e);
    } finally {
      setPlanBusy(false);
    }
  };

  /** Server-side dry run: counts what it WOULD remove and changes nothing. */
  const applyNow = async () => {
    setApplyBusy(true);
    try {
      const dry = await api.applyRetention(true);
      setPlan(await api.retentionPreview().catch(() => null));
      toast.info(`Dry run: would delete ${dry.deleted} items and erase ${dry.files_deleted} file(s). Nothing was changed.`);
    } catch (e) {
      toast.fromError(e);
    } finally {
      setApplyBusy(false);
    }
  };

  const applyForReal = async () => {
    setApplyBusy(true);
    try {
      const r = await api.applyRetention(false);
      setPlan(await api.retentionPreview().catch(() => null));
      toast.success(`Retention applied: ${r.deleted} items removed, ${r.files_deleted} files erased.`);
    } catch (e) {
      toast.fromError(e);
    } finally {
      setApplyBusy(false);
    }
  };

  const toggleDeleteAfterWatch = async (next: boolean) => {
    if (next) {
      setConfirmRetention(true);
      return;
    }
    await saveRetention({ delete_file_when_watched: false });
  };

  const scan = async () => {
    try {
      const r = await api.scanNow();
      // `held` is not an error: those uploads WERE discovered, they just were
      // not downloaded because their channel is manual or not due yet.
      const held = r.held && r.held > 0 ? `, ${r.held} held until due` : '';
      toast.success(
        `Scanned ${r.channels_scanned}: ${r.discovered} new, ${r.queued} queued, ${r.duplicates} duplicate${r.duplicates === 1 ? '' : 's'} skipped${held}.`,
      );
    } catch (e) {
      toast.fromError(e);
    }
  };

  return (
    <div className="stack" style={{ gap: 20, maxWidth: 860 }}>
      <Card>
        <div className="card-title">
          <h2>Connection</h2>
        </div>
        <p className="card-desc">
          The phone's IP changes when it joins a different Wi-Fi network, so the address is a setting — never
          hardcoded. Remote (LAN) access requires a bearer token.
        </p>
        <div className="stack">
          <Field label="Server address" hint={`Currently ${settings?.serverUrl ?? 'not set'}`} htmlFor="settings-url">
            <input
              id="settings-url"
              className="input input-mono"
              defaultValue={settings?.serverUrl}
              key={settings?.serverUrl}
              onBlur={(e) => {
                if (e.target.value !== settings?.serverUrl) void setServerUrl(e.target.value);
              }}
            />
          </Field>
          <div className="row row-wrap">
            <Badge tone={settings?.hasToken ? (settings?.tokenSessionOnly ? 'warn' : 'success') : 'warn'}>
              {!settings?.hasToken
                ? 'No token stored'
                : settings.tokenStorage === 'keychain'
                  ? 'Token in OS keychain'
                  : settings.tokenStorage === 'encrypted-file'
                    ? 'Token encrypted on this computer'
                    : 'Token in memory (this session only)'}
            </Badge>
            <Badge tone={settings?.tokenKeychain ? 'success' : 'info'}>
              {settings?.tokenKeychain ? 'OS keychain in use' : 'Encrypted local storage'}
            </Badge>
            {settings?.hasToken ? (
              <Button size="sm" variant="ghost" onClick={() => void setToken(null)}>
                Remove token
              </Button>
            ) : null}
          </div>
          <Field
            label="Paste a new token"
            hint="Create it on the phone at 127.0.0.1:8765/docs → POST /tokens. Stored encrypted; never sent back to this window."
            htmlFor="settings-token"
          >
            <div className="row">
              <input
                id="settings-token"
                className="input input-mono"
                type="password"
                value={tokenDraft}
                placeholder="Paste token"
                onChange={(e) => setTokenDraft(e.target.value)}
              />
              <Button
                disabled={!tokenDraft.trim()}
                onClick={() => {
                  void setToken(tokenDraft.trim());
                  setTokenDraft('');
                }}
              >
                Save
              </Button>
            </div>
          </Field>
        </div>
      </Card>

      <Card>
        <div className="card-title">
          <h2>Download quality</h2>
          {serverDefault ? <Badge tone="info">Server default: {serverDefault}</Badge> : null}
        </div>
        <p className="card-desc">
          Each resolution is a <strong>maximum permitted height</strong>, not a promise. If a video has no stream
          at or below your ceiling the job fails with a clear error — it never silently jumps higher. Use{' '}
          <span className="mono">quality_height</span> to see what you actually got.
        </p>
        {quality ? (
          <div className="stack">
            <Select
              label="Global default quality"
              value={quality.quality}
              disabled={saving}
              onChange={(v) => void saveQuality({ quality: v as Quality })}
              options={options.length > 0 ? options : qualityLabelsFrom([])}
              hint="Persisted on the phone. Per-channel overrides win over this."
            />
            <div className="field">
              <span className="label">Store as</span>
              <div className="media-toggle">
                <button
                  type="button"
                  aria-pressed={quality.media_type !== 'audio'}
                  onClick={() => void saveQuality({ media_type: 'video' })}
                >
                  Video
                </button>
                <button
                  type="button"
                  aria-pressed={quality.media_type === 'audio'}
                  onClick={() => void saveQuality({ media_type: 'audio' })}
                >
                  Audio (MP3)
                </button>
              </div>
              <span className="hint">
                Global default for what the server stores. Audio downloads an MP3 with embedded cover art.
                Per-source overrides on the Playlists screen win over this.
              </span>
            </div>
            <div className="toggle-row">
              <Switch
                label="Prefer MP4 container"
                checked={quality.prefer_mp4}
                disabled={saving}
                onChange={(v) => void saveQuality({ prefer_mp4: v })}
              />
              <div>
                <strong>Prefer compatible MP4 container</strong>
                <div className="hint">
                  Chooses MP4 when a compatible video/audio pair exists; otherwise yt-dlp merges the best
                  available formats (requires FFmpeg on the phone).
                </div>
              </div>
            </div>
            <div className="toggle-row">
              <Switch
                label="Embed subtitles"
                checked={quality.embed_subs}
                disabled={saving}
                onChange={(v) => void saveQuality({ embed_subs: v })}
              />
              <div>
                <strong>Embed subtitles</strong>
                <div className="hint">Muxes available subtitles into the container.</div>
              </div>
            </div>
            <Field
              label="Subtitle languages"
              htmlFor="quality-sublangs"
              error={subLangsError}
              hint="yt-dlp language filter, e.g. en.* or en,es. The server rejects * (invalid_sub_langs) because it breaks every download."
            >
              <div className="row">
                <input
                  id="quality-sublangs"
                  className={`input input-mono${subLangsError ? ' input-error' : ''}`}
                  defaultValue={subLangs}
                  key={`sub-${subLangs}`}
                  onChange={(e) => setSubLangs(e.target.value)}
                  onBlur={() => {
                    const v = validateSubLangs(subLangs);
                    setSubLangsError(v.ok ? null : (v.reason ?? 'Invalid value'));
                    if (!v.ok || v.normalized === quality.sub_langs) return;
                    void saveQuality({ sub_langs: v.normalized });
                  }}
                />
                <Button
                  disabled={saving}
                  onClick={() => {
                    const v = validateSubLangs(subLangs);
                    setSubLangsError(v.ok ? null : (v.reason ?? 'Invalid value'));
                    if (v.ok) void saveQuality({ sub_langs: v.normalized });
                  }}
                >
                  Save
                </Button>
              </div>
            </Field>
            <div className="toggle-row">
              <Switch
                label="Embed metadata"
                checked={quality.embed_metadata}
                disabled={saving}
                onChange={(v) => void saveQuality({ embed_metadata: v })}
              />
              <div>
                <strong>Embed metadata</strong>
                <div className="hint">Writes title/artist tags into the file.</div>
              </div>
            </div>
            <div className="toggle-row">
              <Switch
                label="Embed thumbnail"
                checked={quality.embed_thumbnail}
                disabled={saving}
                onChange={(v) => void saveQuality({ embed_thumbnail: v })}
              />
              <div>
                <strong>Embed thumbnail</strong>
                <div className="hint">Muxes the thumbnail into the file as cover art.</div>
              </div>
            </div>
            <div className="toggle-row">
              <Switch
                label="Write description"
                checked={quality.write_description}
                disabled={saving}
                onChange={(v) => void saveQuality({ write_description: v })}
              />
              <div>
                <strong>Write description to file</strong>
                <div className="hint">Stores the video description alongside the media.</div>
              </div>
            </div>
            <Field
              label="Phone download concurrency"
              hint={`Server-side: how many jobs download at once on the phone. Current: ${quality.max_concurrent_downloads}`}
              htmlFor="phone-concurrency"
            >
              <input
                id="phone-concurrency"
                className="input numeric"
                type="number"
                min={1}
                max={8}
                defaultValue={quality.max_concurrent_downloads}
                key={`conc-${quality.max_concurrent_downloads}`}
                onBlur={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isInteger(n) && n >= 1 && n <= 8 && n !== quality.max_concurrent_downloads) {
                    void saveQuality({ max_concurrent_downloads: n });
                  }
                }}
              />
            </Field>
            <div className="divider" style={{ margin: '4px 0' }} />
            <Field
              label="Download location on the phone"
              htmlFor="quality-dldir"
              error={downloadDirError}
              hint="Absolute path in Termux. Changing it no longer orphans existing files — they stay reachable — but the server will write new downloads to the new folder."
            >
              <div className="row">
                <input
                  id="quality-dldir"
                  className={`input input-mono${downloadDirError ? ' input-error' : ''}`}
                  defaultValue={downloadDir}
                  key={`dir-${downloadDir}`}
                  placeholder="Leave empty for the server default"
                  onChange={(e) => setDownloadDir(e.target.value)}
                  onBlur={() => {
                    const v = validateDownloadDir(downloadDir);
                    setDownloadDirError(v.ok ? null : (v.reason ?? 'Invalid path'));
                    if (!v.ok || v.normalized === (quality.download_dir ?? null)) return;
                    void saveQuality({ download_dir: v.normalized });
                  }}
                />
                <Button
                  disabled={saving}
                  onClick={() => {
                    const v = validateDownloadDir(downloadDir);
                    setDownloadDirError(v.ok ? null : (v.reason ?? 'Invalid path'));
                    if (v.ok) void saveQuality({ download_dir: v.normalized });
                  }}
                >
                  Save
                </Button>
              </div>
            </Field>
            <Field
              label="This computer — parallel transfers"
              hint="How many files may download from the phone to this computer at once. Independent of the phone's own concurrency."
              htmlFor="local-parallel"
            >
              <div className="row">
                <input
                  id="local-parallel"
                  className="input numeric"
                  type="number"
                  min={1}
                  max={6}
                  defaultValue={settings?.maxParallelTransfers ?? 2}
                  key={`par-${settings?.maxParallelTransfers}`}
                  onBlur={(e) => void setPreferences({ maxParallelTransfers: Number(e.target.value) })}
                />
                <span className="hint nowrap">file pulls</span>
              </div>
            </Field>
            <p className="tiny faint">
              Where files land on <em>this</em> computer is chosen per transfer in the native save dialog. The
              path above is the phone's Termux directory and needs Termux storage permissions.
            </p>
          </div>
        ) : (
          <Loading />
        )}
      </Card>

      <Card>
        <div className="card-title">
          <h2>Monitoring</h2>
        </div>
        <p className="card-desc">
          The phone scans on its own interval. This client never polls a scan on a timer — use “Scan now” for a
          manual run.
        </p>
        {monitor ? (
          <div className="stack">
            <div className="toggle-row">
              <Switch
                label="Enable monitoring"
                checked={monitor.enabled}
                disabled={saving}
                onChange={(v) => void saveMonitor({ enabled: v })}
              />
              <div>
                <strong>Automatic monitoring</strong>
                <div className="hint">The server discovers new uploads from the YouTube feeds on its schedule.</div>
              </div>
            </div>
            <div className="grid-3">
              <Field label="Interval (minutes)" hint="Default 15" htmlFor="mon-interval">
                <input
                  id="mon-interval"
                  className="input numeric"
                  type="number"
                  min={5}
                  max={1440}
                  defaultValue={monitor.interval_minutes}
                  key={`i-${monitor.interval_minutes}`}
                  onBlur={(e) => {
                    const n = Number(e.target.value);
                    if (n >= 5 && n <= 1440 && n !== monitor.interval_minutes) void saveMonitor({ interval_minutes: n });
                  }}
                />
              </Field>
              <Field label="Publication window (hours)" hint="Only consider videos published within this window" htmlFor="mon-window">
                <input
                  id="mon-window"
                  className="input numeric"
                  type="number"
                  min={1}
                  max={720}
                  defaultValue={monitor.window_hours}
                  key={`w-${monitor.window_hours}`}
                  onBlur={(e) => {
                    const n = Number(e.target.value);
                    if (n >= 1 && n <= 720 && n !== monitor.window_hours) void saveMonitor({ window_hours: n });
                  }}
                />
              </Field>
              <Select
                label="Content filter"
                value={monitor.content_filter}
                onChange={(v) => void saveMonitor({ content_filter: v as MonitorShape['content_filter'] })}
                options={[
                  { value: 'all', label: 'All content' },
                  { value: 'video', label: 'Regular videos only' },
                  { value: 'shorts', label: 'Shorts only' },
                ]}
              />
            </div>
            <div className="toggle-row">
              <Switch
                label="Future-dated uploads only"
                checked={monitor.future_only}
                disabled={saving}
                onChange={(v) => void saveMonitor({ future_only: v })}
              />
              <div>
                <strong>Future-dated only</strong>
                <div className="hint">Ignore items with a publication date in the future.</div>
              </div>
            </div>
            <div>
              <Button onClick={() => void scan()}>Scan now</Button>
            </div>
          </div>
        ) : (
          <Loading />
        )}
      </Card>

      <StorageSettings onChanged={() => void api.retentionPreview().then(setPlan).catch(() => undefined)} />

      <Card>
        <div className="card-title">
          <h2>Retention &amp; watched behaviour</h2>
        </div>
        <p className="card-desc">
          Deletion is permanent. When delete-after-watch is on, the server erases the file as soon as you mark a
          video watched but keeps the library row.
        </p>
        {retention ? (
          <div className="stack">
            <div className="toggle-row">
              <Switch
                label="Delete file after watching"
                checked={retention.delete_file_when_watched}
                disabled={saving}
                onChange={(v) => void toggleDeleteAfterWatch(v)}
              />
              <div>
                <strong>Delete the file after watching</strong>
                <div className="hint">
                  {retention.delete_file_when_watched
                    ? 'ON — marking a video watched permanently erases the file on the phone.'
                    : 'Off by default. Enabling requires an explicit confirmation.'}
                </div>
              </div>
            </div>
            <div className="row row-wrap" style={{ marginBottom: 8 }}>
              <Button size="sm" onClick={() => void refreshPlan()} loading={planBusy}>
                Refresh preview
              </Button>
              <Button size="sm" onClick={() => void applyNow()} loading={applyBusy}>
                Dry run
              </Button>
            </div>

            {plan ? (
              <div className="card" style={{ padding: 14, background: 'var(--surface-2)', marginBottom: 12 }}>
                <div className="tiny faint" style={{ marginBottom: 6 }}>
                  What the current rules would remove — nothing has been deleted.
                </div>
                <div className="row row-wrap" style={{ gap: '6px 18px' }}>
                  <span>
                    <strong>{plan.completed_total}</strong> completed videos
                  </span>
                  <span style={{ color: plan.would_delete > 0 ? 'var(--warn)' : undefined }}>
                    <strong>{plan.would_delete}</strong> would be deleted
                  </span>
                  <span>
                    <strong>{formatBytes(plan.bytes)}</strong> would be freed
                  </span>
                </div>
                {plan.would_delete > 0 ? (
                  <>
                    <p className="tiny" style={{ color: 'var(--danger)', marginTop: 8 }}>
                      Applying this permanently removes {plan.would_delete} completed video
                      {plan.would_delete === 1 ? '' : 's'} and erases {formatBytes(plan.bytes)} from the phone.
                      Queued, downloading and failed items are never touched.
                    </p>
                    <RetentionApplyConfirm
                      wouldDelete={plan.would_delete}
                      bytes={plan.bytes}
                      busy={applyBusy}
                      onConfirm={() => void applyForReal()}
                    />
                  </>
                ) : (
                  <p className="tiny faint" style={{ marginTop: 8 }}>
                    Nothing matches the current rules. Set a retention window or a maximum library size to enable
                    cleanup.
                  </p>
                )}
              </div>
            ) : null}

            <div className="grid-3">
              <Field label="Retention (days)" hint="null = keep forever" htmlFor="ret-days">
                <input
                  id="ret-days"
                  className="input numeric"
                  type="number"
                  min={0}
                  defaultValue={retention.retention_days ?? ''}
                  key={`rd-${retention.retention_days}`}
                  placeholder="null"
                  onBlur={(e) => {
                    const raw = e.target.value.trim();
                    const n = raw === '' ? null : Number(raw);
                    if (n === null) void saveRetention({ retention_days: null });
                    else if (Number.isInteger(n) && n >= 0 && n !== retention.retention_days)
                      void saveRetention({ retention_days: n });
                  }}
                />
              </Field>
              <Field label="Max library items" hint="null = unlimited" htmlFor="ret-max">
                <input
                  id="ret-max"
                  className="input numeric"
                  type="number"
                  min={0}
                  defaultValue={retention.max_library_items ?? ''}
                  key={`rm-${retention.max_library_items}`}
                  placeholder="null"
                  onBlur={(e) => {
                    const raw = e.target.value.trim();
                    const n = raw === '' ? null : Number(raw);
                    if (n === null) void saveRetention({ max_library_items: null });
                    else if (Number.isInteger(n) && n >= 0 && n !== retention.max_library_items)
                      void saveRetention({ max_library_items: n });
                  }}
                />
              </Field>
            </div>
          </div>
        ) : (
          <Loading />
        )}
      </Card>

      <Card>
        <div className="card-title">
          <h2>Phone storage</h2>
        </div>
        <p className="card-desc">Reported by the server. This is the phone's media directory, not this computer.</p>
        {storage ? (
          <>
            <div className="grid-3">
              <Stat label="Used by media" value={formatBytes(storage.bytes)} />
              <Stat label="Files" value={String(storage.files)} />
              <Stat label="Free on phone" value={formatBytes(storage.free)} />
            </div>

            {hasBreakdown(storage) ? (
              <div style={{ marginTop: 16 }}>
                <div className="tiny faint" style={{ marginBottom: 6 }}>
                  Breakdown — watched + unwatched + orphaned always equals total.
                </div>
                <div className="stack" style={{ gap: 6 }}>
                  <StorageBar label="Watched" value={storage.watched_bytes!} total={storage.bytes} tone="info" />
                  <StorageBar label="Unwatched" value={storage.unwatched_bytes!} total={storage.bytes} tone="accent" />
                  <StorageBar label="Orphaned (no library row)" value={storage.orphaned_bytes!} total={storage.bytes} tone="warn" />
                </div>
                <p className="tiny faint" style={{ marginTop: 8 }}>
                  Orphaned bytes are files on disk with no matching library row — for example after a bulk
                  delete that kept files. They are not shown in the library and are not counted in
                  watched/unwatched.
                </p>
              </div>
            ) : (
              <p className="tiny faint" style={{ marginTop: 12 }}>
                This server does not report a watched/unwatched/orphaned breakdown, so the figures above are
                totals only.
              </p>
            )}
          </>
        ) : (
          <Loading />
        )}
      </Card>

      <Alert tone="info">
        Settings are stored on the phone and shared with the Android client. If both write at once the server is
        last-write-wins — this screen re-reads after every write and always shows the stored value.
      </Alert>

      <RetentionConfirm
        open={confirmRetention}
        onConfirm={() => {
          setConfirmRetention(false);
          void saveRetention({ delete_file_when_watched: true });
        }}
        onCancel={() => setConfirmRetention(false)}
        busy={saving}
      />
    </div>
  );
}

/** Explicit confirmation before an irreversible, bulk, server-side deletion. */
function RetentionApplyConfirm({
  wouldDelete,
  bytes,
  busy,
  onConfirm,
}: {
  wouldDelete: number;
  bytes: number;
  busy?: boolean;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="danger" size="sm" onClick={() => setOpen(true)} disabled={busy}>
        Apply retention now
      </Button>
      <Modal
        open={open}
        title="Apply retention rules?"
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              Delete {wouldDelete} item{wouldDelete === 1 ? '' : 's'}
            </Button>
          </>
        }
      >
        <Alert tone="danger">
          <strong>This is irreversible and runs on the phone.</strong>
          <p style={{ marginTop: 8 }}>
            {wouldDelete} completed video{wouldDelete === 1 ? '' : 's'} will be removed from the library and{' '}
            {formatBytes(bytes)} of media will be erased. There is no undo and no backup.
          </p>
          <p style={{ marginTop: 8 }}>Queued, downloading and failed items are never touched.</p>
        </Alert>
      </Modal>
    </>
  );
}

function hasBreakdown(s: StorageShape): s is StorageShape & { watched_bytes: number; unwatched_bytes: number; orphaned_bytes: number } {
  return (
    typeof s.watched_bytes === 'number' &&
    typeof s.unwatched_bytes === 'number' &&
    typeof s.orphaned_bytes === 'number'
  );
}

function StorageBar({ label, value, total, tone }: { label: string; value: number; total: number; tone: 'info' | 'accent' | 'warn' }) {
  const pct = total > 0 ? Math.min(100, (value / total) * 100) : 0;
  return (
    <div>
      <div className="row tiny" style={{ marginBottom: 3 }}>
        <span>{label}</span>
        <span className="spacer" />
        <span className="numeric muted">{formatBytes(value)}</span>
        <span className="numeric faint" style={{ width: 52, textAlign: 'right' }}>
          {pct.toFixed(1)}%
        </span>
      </div>
      <div className="progress">
        <div className={`progress-fill ${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card" style={{ padding: 14, background: 'var(--surface-2)' }}>
      <div className="tiny faint">{label}</div>
      <div className="numeric" style={{ fontSize: 20, fontWeight: 600 }}>
        {value}
      </div>
    </div>
  );
}

function Loading() {
  return (
    <div className="row muted" style={{ gap: 8 }}>
      <span className="spinner" aria-hidden /> Loading from server…
    </div>
  );
}