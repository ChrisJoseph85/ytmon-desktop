import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, EmptyState, Loading, Select, Switch } from '../components/ui';
import { api, toast, type LibraryLayouts, type LibrarySettings, type TreeOrder } from '../lib/bridge';
import { usePolling } from '../lib/hooks';
import { formatBytes, formatDate, formatDuration } from '@shared/format';

/**
 * The file-browser view of the library: folders -> subfolders -> items, straight
 * from GET /library/tree.
 *
 * `item_count` is always the true total while `items` may be truncated by
 * limit_per_folder, so the UI says "showing N of M" rather than implying the
 * folder is fully listed.
 */
export function LibraryBrowser() {
  const [order, setOrder] = useState<TreeOrder>('newest');
  const [limit, setLimit] = useState(50);
  const tree = usePolling(() => api.libraryTree(order, limit), null, [order, limit]);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const t = tree.data;

  const toggle = (key: string) => setOpen((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row row-wrap">
        <Select
          ariaLabel="Folder order"
          value={order}
          onChange={(v) => setOrder(v as TreeOrder)}
          options={[
            { value: 'newest', label: 'Newest first' },
            { value: 'oldest', label: 'Oldest first' },
            { value: 'title', label: 'By title' },
            { value: 'duration', label: 'By duration' },
          ]}
        />
        <Select
          ariaLabel="Items shown per folder"
          value={String(limit)}
          onChange={(v) => setLimit(Number(v))}
          options={[10, 25, 50, 100, 200, 500].map((n) => ({ value: String(n), label: `Show ${n} per folder` }))}
        />
        <span className="spacer" />
        {t ? (
          <span className="muted tiny">
            {t.total_videos} video{t.total_videos === 1 ? '' : 's'} · {t.total_folders} folder
            {t.total_folders === 1 ? '' : 's'}
          </span>
        ) : null}
        <Button onClick={tree.refresh} loading={tree.loading}>
          Refresh
        </Button>
      </div>

      {tree.error ? <Alert tone="danger">{tree.error}</Alert> : null}

      {tree.loading && !t ? (
        <Loading />
      ) : !t || t.folders.length === 0 ? (
        <EmptyState icon="🗂" title="Nothing in the media library yet">
          <p className="muted">Downloaded files appear here, grouped the same way they are stored on the phone.</p>
        </EmptyState>
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          {t.folders.map((folder) => {
            const key = folder.channel_id ?? folder.name;
            const isOpen = open[key] ?? true;
            return (
              <Card key={key} className="browser-folder">
                <div className="browser-folder-head" style={isOpen ? { borderBottom: '1px solid var(--border)' } : undefined}>
                  <div className="row row-wrap">
                    <Button size="sm" variant="ghost" onClick={() => toggle(key)} aria-expanded={isOpen}>
                      {isOpen ? '▾' : '▸'}
                    </Button>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <strong className="truncate" title={folder.name}>
                        {folder.name}
                      </strong>
                      {folder.channel_title ? null : (
                        <span className="badge" style={{ marginLeft: 8 }} title="This channel was never added, so only the raw id is known">
                          id only
                        </span>
                      )}
                    </div>
                    <Badge>{folder.item_count} items</Badge>
                    <Badge tone="info">{formatBytes(folder.total_bytes)}</Badge>
                  </div>
                </div>

                {isOpen ? (
                  <div style={{ padding: 'var(--sp-3) var(--sp-4)' }}>
                    {(folder.subfolders ?? []).length === 0 ? (
                      <p className="tiny faint">No subfolders.</p>
                    ) : (
                      <div className="stack" style={{ gap: 10 }}>
                        {folder.subfolders.map((sub) => {
                          const shown = (sub.items ?? []).length;
                          const truncated = shown < (sub.item_count ?? 0);
                          return (
                            <div key={`${key}-${sub.name}`}>
                              <div className="row row-wrap" style={{ marginBottom: 4 }}>
                                <strong className="tiny">📁 {sub.name}</strong>
                                <span className="tiny faint">
                                  {truncated ? `showing ${shown} of ${sub.item_count}` : `${shown} item${shown === 1 ? '' : 's'}`}
                                </span>
                              </div>
                              <div className="stack" style={{ gap: 2 }}>
                                {(sub.items ?? []).map((item, i) => (
                                  <div key={item.video_id ?? i} className="result-row">
                                    {item.media_type === 'audio' ? <span aria-hidden>♪</span> : <span aria-hidden>▶</span>}
                                    <span className="truncate" style={{ flex: 1 }} title={item.title}>
                                      {item.title ?? item.video_id}
                                    </span>
                                    {item.pinned ? <Badge tone="warn">📌</Badge> : null}
                                    {item.watched ? <Badge tone="info">watched</Badge> : null}
                                    <span className="tiny faint nowrap">{formatDuration(item.duration ?? null)}</span>
                                    <span className="tiny faint nowrap">{formatBytes(item.file_size ?? null)}</span>
                                    <span className="tiny faint nowrap">{formatDate(item.published_at)}</span>
                                  </div>
                                ))}
                                {truncated ? (
                                  <p className="tiny faint" style={{ padding: '4px 8px' }}>
                                    {sub.item_count - shown} more in this folder — raise “items per folder” above.
                                  </p>
                                ) : null}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}

      {t?.media_dir ? (
        <p className="tiny faint mono">media_dir on the phone: {t.media_dir} — shown for debugging only; files are fetched by id.</p>
      ) : null}
    </div>
  );
}

/**
 * Storage settings. PUT /library/settings is a MERGE, so every control sends
 * only the field it changed and the response is re-read and displayed.
 */
export function StorageSettings({ onChanged }: { onChanged?: () => void }) {
  const [settings, setSettings] = useState<LibrarySettings | null>(null);
  const [layouts, setLayouts] = useState<LibraryLayouts | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    void api.librarySettings().then(setSettings).catch((e: Error) => setError(e.message));
    void api.libraryLayouts().then(setLayouts).catch(() => undefined);
  };
  load();

  const save = async (patch: Partial<LibrarySettings>) => {
    setSaving(true);
    setError(null);
    try {
      const fresh = await api.updateLibrarySettings(patch);
      setSettings(fresh);
      onChanged?.();
      toast.success('Storage settings saved on the phone.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!settings) return <Loading />;

  return (
    <Card>
      <div className="card-title">
        <h2>Storage &amp; layout</h2>
      </div>
      <p className="card-desc">
        Where new downloads are stored on the phone, and the rules that clean up old ones. Changing the layout
        does not move existing files — only new ones follow it.
      </p>

      <div className="stack">
        <Select
          label="Media layout for NEW downloads"
          value={settings.media_layout}
          disabled={saving}
          onChange={(v) => void save({ media_layout: v as LibrarySettings['media_layout'] })}
          options={(layouts?.options ?? ['channel_id', 'channel_title', 'channel_source', 'flat']).map((o) => ({
            value: o,
            label: o.replace(/_/g, ' '),
          }))}
          hint={layouts?.descriptions?.[settings.media_layout] ?? 'Existing files are not moved.'}
        />

        <Select
          label="Browser order"
          value={settings.tree_order}
          disabled={saving}
          onChange={(v) => void save({ tree_order: v as TreeOrder })}
          options={(layouts?.orders ?? ['newest', 'oldest', 'title', 'duration']).map((o) => ({
            value: o,
            label: o,
          }))}
        />

        <div className="grid-3">
          <Field2
            label="Retention (days)"
            hint="null = keep forever"
            value={settings.retention_days}
            onSave={(v) => void save({ retention_days: v })}
          />
          <Field2
            label="Max library items"
            hint="null = unlimited"
            value={settings.max_library_items}
            onSave={(v) => void save({ max_library_items: v })}
          />
        </div>

        <div className="toggle-row">
          <Switch
            label="Delete file after watching"
            checked={settings.delete_file_when_watched}
            disabled={saving}
            onChange={(v) => {
              if (v && !window.confirm('Marking a video watched will permanently erase its file on the phone. Enable this?')) {
                return;
              }
              void save({ delete_file_when_watched: v });
            }}
          />
          <div>
            <strong>Delete the file after watching</strong>
            <div className="hint">
              Off by default. Pinned videos are exempt. The library row is kept either way.
            </div>
          </div>
        </div>

        {error ? <Alert tone="danger">{error}</Alert> : null}

        <p className="tiny faint">
          Saving sends only the field you changed — the server merges it, so nothing else resets.
        </p>
      </div>
    </Card>
  );
}

function Field2({
  label,
  hint,
  value,
  onSave,
}: {
  label: string;
  hint: string;
  value: number | null;
  onSave: (v: number | null) => void;
}) {
  const [draft, setDraft] = useState(value === null ? '' : String(value));
  useEffect(() => setDraft(value === null ? '' : String(value)), [value]);
  return (
    <div className="field">
      <span className="label">{label}</span>
      <input
        className="input numeric"
        type="number"
        min={1}
        placeholder="null"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const raw = draft.trim();
          const next = raw === '' ? null : Number(raw);
          if (next === null && value === null) return;
          if (next !== null && (!Number.isInteger(next) || next < 1)) return;
          if (next !== value) onSave(next);
        }}
      />
      <span className="hint">{hint}</span>
    </div>
  );
}