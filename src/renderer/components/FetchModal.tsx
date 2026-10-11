import { useState } from 'react';
import { Alert, Badge, Button, Field, Modal, Select } from './ui';
import { api, toast, type FetchResult, type MediaType, type Quality } from '../lib/bridge';
import { qualityLabelsFrom } from '../lib/labels';

/**
 * "Paste a link" — add and download a video, playlist or channel on demand
 * without waiting for a scan.
 *
 * The first call is always a PREVIEW (download:false): it resolves the link,
 * reports counts and queues nothing, so nothing is downloaded by surprise.
 */
export function FetchModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [url, setUrl] = useState('');
  const [mediaType, setMediaType] = useState<MediaType>('video');
  const [quality, setQuality] = useState('');
  const [limit, setLimit] = useState('1');
  const [options, setOptions] = useState<{ value: string; label: string }[]>([]);
  const [preview, setPreview] = useState<FetchResult | null>(null);
  const [result, setResult] = useState<FetchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (open && options.length === 0) {
    void api.qualityOptions().then((q) => setOptions(qualityLabelsFrom(q.options))).catch(() => undefined);
  }

  const reset = () => {
    setUrl('');
    setPreview(null);
    setResult(null);
    setError(null);
  };

  /** Resolve only. Never queues, never downloads. */
  const doPreview = async () => {
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const n = Number(limit);
      const r = await api.fetchLink({
        url: url.trim(),
        download: false,
        media_type: mediaType,
        thumbnail: true,
        ...(quality ? { quality: quality as Quality } : {}),
        ...(Number.isInteger(n) && n >= 1 && n <= 50 ? { limit: n } : {}),
      });
      setPreview(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doFetch = async () => {
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const n = Number(limit);
      const r = await api.fetchLink({
        url: url.trim(),
        download: true,
        media_type: mediaType,
        thumbnail: true,
        ...(quality ? { quality: quality as Quality } : {}),
        ...(Number.isInteger(n) && n >= 1 && n <= 50 ? { limit: n } : {}),
      });
      setResult(r);
      toast.success(`${r.kind === 'playlist' ? 'Playlist' : 'Video'} queued: ${r.queued.length} job(s), ${r.duplicates.length} already known.`);
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
      wide
      title="Fetch by link"
      onClose={() => {
        reset();
        onClose();
      }}
      footer={
        <>
          <Button
            onClick={() => {
              reset();
              onClose();
            }}
          >
            Cancel
          </Button>
          {!result ? (
            <Button loading={busy} disabled={!url.trim()} onClick={() => void doPreview()}>
              Preview
            </Button>
          ) : null}
          <Button
            variant="primary"
            loading={busy}
            disabled={!url.trim() || (preview !== null && preview.resolved === 0)}
            onClick={() => void doFetch()}
            title="This is the call that actually queues downloads"
          >
            {result ? 'Fetch again' : 'Download now'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Alert tone="info">
          Paste a video, playlist or channel link — <span className="mono">youtu.be/…</span>,{' '}
          <span className="mono">watch?v=…</span>, a bare 11-character id, or{' '}
          <span className="mono">/playlist?list=…</span>. Preview resolves the link without
          downloading anything.
        </Alert>

        <Field label="Link" htmlFor="fetch-url" error={error}>
          <input
            id="fetch-url"
            className="input input-mono"
            value={url}
            placeholder="https://www.youtube.com/watch?v=..."
            autoFocus
            onChange={(e) => {
              setUrl(e.target.value);
              setPreview(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (preview) void doFetch();
                else void doPreview();
              }
            }}
          />
        </Field>

        <div className="grid-3">
          <div className="field">
            <span className="label">Store as</span>
            <div className="media-toggle">
              <button
                type="button"
                aria-pressed={mediaType === 'video'}
                onClick={() => {
                  setMediaType('video');
                  setPreview(null);
                }}
              >
                Video
              </button>
              <button
                type="button"
                aria-pressed={mediaType === 'audio'}
                onClick={() => {
                  setMediaType('audio');
                  setPreview(null);
                }}
              >
                Audio (MP3)
              </button>
            </div>
            <span className="hint">Audio downloads an MP3 with embedded cover art.</span>
          </div>

          <Select
            label="Quality for this fetch"
            value={quality}
            onChange={setQuality}
            hint="Blank uses the global setting."
            options={[{ value: '', label: 'Use global default' }, ...options.map((o) => ({ value: o.value, label: o.label }))]}
          />

          <Field label="Limit" htmlFor="fetch-limit" hint="Playlists only, 1–50.">
            <input
              id="fetch-limit"
              className="input numeric"
              type="number"
              min={1}
              max={50}
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
            />
          </Field>
        </div>

        {preview && !result ? (
          <div className="card" style={{ padding: 14, background: 'var(--surface-2)' }}>
            <div className="row row-wrap" style={{ gap: '6px 16px', marginBottom: 8 }}>
              <Badge tone="info">{preview.kind}</Badge>
              <span>
                <strong>{preview.resolved}</strong> item{preview.resolved === 1 ? '' : 's'} found
              </span>
              {preview.duplicates.length > 0 ? (
                <span className="muted">
                  <strong>{preview.duplicates.length}</strong> already in the library
                </span>
              ) : null}
              {preview.unavailable.length > 0 ? (
                <span style={{ color: 'var(--warn)' }}>
                  <strong>{preview.unavailable.length}</strong> unavailable
                </span>
              ) : null}
              {preview.truncated ? <Badge tone="warn">Truncated at the limit</Badge> : null}
              <span className="spacer" />
              <span className="tiny faint">Nothing queued yet</span>
            </div>
            {preview.unavailable.length > 0 ? (
              <div className="result-list" style={{ marginBottom: 8 }}>
                {preview.unavailable.slice(0, 20).map((t, i) => (
                  <div key={i} className="result-row" style={{ color: 'var(--warn)' }}>
                    <span aria-hidden>⚠</span>
                    <span className="truncate">{t}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {result ? (
          <div className="card" style={{ padding: 14, background: 'var(--surface-2)' }}>
            <div className="tiny faint" style={{ marginBottom: 6 }}>
              Queued — progress appears on the Downloads screen
            </div>
            <div className="row row-wrap" style={{ gap: '6px 16px' }}>
              <span>
                <strong>{result.added.length}</strong> added
              </span>
              <span>
                <strong>{result.queued.length}</strong> queued
              </span>
              <span className="muted">
                <strong>{result.duplicates.length}</strong> already known (not re-downloaded)
              </span>
              {result.unavailable.length > 0 ? (
                <span style={{ color: 'var(--warn)' }}>
                  <strong>{result.unavailable.length}</strong> unavailable
                </span>
              ) : null}
              {result.quality ? <span className="muted">at {result.quality}</span> : null}
            </div>
            {result.unavailable.length > 0 ? (
              <div className="result-list" style={{ marginTop: 8 }}>
                {result.unavailable.slice(0, 20).map((t, i) => (
                  <div key={i} className="result-row" style={{ color: 'var(--warn)' }}>
                    <span aria-hidden>⚠</span>
                    <span className="truncate" title={t}>
                      {t}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        <p className="tiny faint">
          This calls out to YouTube through yt-dlp on the phone, so it can take 10–60 seconds. It is never
          retried automatically. Duplicates are recognised on existence, not status — to retry something that
          failed, use Retry on the Library or Downloads screen.
        </p>
        <div className="sr-only" aria-live="polite">
          {busy ? 'Working…' : ''}
        </div>
      </div>
    </Modal>
  );
}