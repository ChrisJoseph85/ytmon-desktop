import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Modal, Progress } from './ui';
import { api, toast, type ChannelDownloadResult, type ChannelShape, type ChannelUploads } from '../lib/bridge';
import { formatDateTime } from '@shared/format';
import { thumbUrl } from '@shared/media';

/**
 * A channel's recent uploads, read from YouTube's public RSS feed.
 *
 * Three properties of this endpoint drive the whole design:
 *
 *  - It is a PREVIEW. Nothing is queued and the library is untouched.
 *    Downloading is always a separate, explicit action.
 *  - `kind` is ALWAYS "unknown" and `shorts_detectable` is ALWAYS false —
 *    the feed cannot tell a Short from a video. So there is deliberately
 *    NO Shorts filter here, and no attempt to guess one.
 *  - `thumbnail` is a plain YouTube URL that hangs on a phone with no
 *    internet. We prefer the server's cached thumbnail for anything
 *    already in the library, and fall back to the plain URL otherwise.
 */
export function ChannelUploadsModal({
  channel,
  onClose,
  onLibraryChanged,
}: {
  channel: ChannelShape | null;
  onClose: () => void;
  onLibraryChanged?: () => void;
}) {
  const [limit, setLimit] = useState(15);
  const [data, setData] = useState<ChannelUploads | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Preview of the "Download all" action. Null until the user asks for it.
  const [preview, setPreview] = useState<ChannelDownloadResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (!channel) {
      setData(null);
      setError(null);
      setPreview(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    setPreview(null);
    api
      .channelUploads(channel.channel_id, limit)
      .then((r) => {
        if (!alive) return;
        setData(r);
      })
      .catch((e: Error) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [channel, limit]);

  const title = data?.channel_title ?? channel?.title ?? channel?.channel_id ?? '';

  /** One upload: open it if we have it, otherwise fetch-and-download it. */
  const openUpload = async (videoId: string) => {
    if (!channel) return;
    setBusyId(videoId);
    try {
      const existing = await api.getVideo(videoId).catch(() => null);
      if (existing) {
        onLibraryChanged?.();
        onClose();
        toast.info(`"${existing.title}" is already in your library.`);
        return;
      }
      const r = await api.fetchLink({
        url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
        download: true,
      });
      toast.success(`Queued ${r.queued.length} item${r.queued.length === 1 ? '' : 's'}.`);
      onLibraryChanged?.();
    } catch (e) {
      toast.fromError(e);
    } finally {
      setBusyId(null);
    }
  };

  /**
   * "Download all" always previews first. There is no undo and this is real
   * network traffic, so the user sees exactly what would queue and confirms.
   */
  const startDownloadAll = async () => {
    if (!channel) return;
    setPreviewing(true);
    setError(null);
    try {
      const r = await api.downloadChannelBacklog(channel.channel_id, { limit: 50, dry_run: true });
      setPreview(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPreviewing(false);
    }
  };

  const confirmDownloadAll = async () => {
    if (!channel || !preview) return;
    setDownloading(true);
    try {
      const r = await api.downloadChannelBacklog(channel.channel_id, { limit: 50, dry_run: false });
      toast.success(`Queued ${r.queued} of ${r.considered} (${r.already_downloaded} already downloaded).`);
      setPreview(null);
      onLibraryChanged?.();
    } catch (e) {
      toast.fromError(e);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Modal
      open={channel !== null}
      wide
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button
            variant="primary"
            loading={previewing || downloading}
            disabled={!channel || !data}
            onClick={() => void startDownloadAll()}
            title="Queue everything this channel has discovered but not downloaded. Previews first."
          >
            Download all discovered
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="row row-wrap" style={{ gap: 8 }}>
          {/* Many imported channels have no title yet; the id is the label. */}
          {data && !data.channel_title ? <Badge tone="warn">No title yet</Badge> : null}
          <Badge>{data?.count ?? 0} shown</Badge>
          <span className="spacer" />
          <Button size="sm" onClick={() => setLimit((n) => (n >= 50 ? 15 : n + 15))}>
            {limit >= 50 ? 'Show 15' : `Show ${limit + 15}`}
          </Button>
        </div>

        <Alert tone="info">
          A preview of what YouTube currently lists — newest first. Nothing is queued by opening this. This feed
          cannot tell a Short from a video, so these are shown as plain videos.
        </Alert>

        {error ? <Alert tone="danger">{error}</Alert> : null}

        {preview ? (
          <Alert tone={preview.queued > 0 ? 'warn' : 'info'}>
            <div>
              <strong>
                {preview.queued} would be queued
              </strong>{' '}
              of {preview.considered} discovered ({preview.already_downloaded} already downloaded). This is real
              network traffic and cannot be undone.
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <Button
                size="sm"
                variant="primary"
                loading={downloading}
                disabled={preview.queued === 0}
                onClick={() => void confirmDownloadAll()}
              >
                Queue {preview.queued}
              </Button>
              <Button size="sm" onClick={() => setPreview(null)}>
                Cancel
              </Button>
            </div>
          </Alert>
        ) : null}

        {loading ? <Progress value={100} label="Loading uploads" /> : null}

        {!loading && data && data.uploads.length === 0 ? (
          <p className="muted">YouTube lists no uploads for this channel right now.</p>
        ) : null}

        {data?.uploads.map((u) => (
          <button
            key={u.video_id}
            type="button"
            className="result-row"
            style={{ width: '100%', textAlign: 'left', cursor: 'pointer', background: 'transparent', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: 8 }}
            onClick={() => void openUpload(u.video_id)}
            disabled={busyId !== null}
          >
            <div className="row" style={{ gap: 12, alignItems: 'center' }}>
              <UploadThumb videoId={u.video_id} fallback={u.thumbnail} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="truncate" style={{ fontWeight: 550 }}>
                  {u.title}
                </div>
                <div className="tiny faint">
                  {u.published_at ? formatDateTime(u.published_at) : 'No date'} ·{' '}
                  {busyId === u.video_id ? 'Working…' : 'Tap to download'}
                </div>
              </div>
            </div>
          </button>
        ))}
      </div>
    </Modal>
  );
}

/**
 * Prefer the server's cached thumbnail. It only exists once the item is in
 * the library, so anything else falls back to the plain YouTube URL — which
 * is what the endpoint gives us and which will simply fail offline.
 */
function UploadThumb({ videoId, fallback }: { videoId: string; fallback: string | null }) {
  const [stage, setStage] = useState<'cached' | 'fallback' | 'none'>('cached');
  const [cachedFailed, setCachedFailed] = useState(false);
  useEffect(() => {
    setStage('cached');
    setCachedFailed(false);
  }, [videoId]);

  const src = !cachedFailed && stage === 'cached' ? thumbUrl(videoId) : fallback;
  if (!src) return <div className="thumb-placeholder" aria-hidden style={{ width: 96, height: 54 }} />;
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      style={{ width: 96, height: 54, objectFit: 'cover', borderRadius: 'var(--r-sm)', flexShrink: 0 }}
      onError={() => {
        if (stage === 'cached') {
          setCachedFailed(true);
        } else {
          setStage('none');
        }
      }}
    />
  );
}
