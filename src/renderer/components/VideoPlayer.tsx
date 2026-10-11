import { useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Modal } from './ui';
import { api, appApi, files, toast, type FileMetaShape, type VideoShape } from '../lib/bridge';
import { STATE_LABELS, effectiveQualityLabel, hasLocalFile } from '@shared/quality';
import { formatBytes, formatDateTime, watchUrl } from '@shared/format';
import { mediaUrl, thumbUrl } from '@shared/media';

/**
 * Player for server-hosted files.
 *
 * Playback streams through the ytmon-media:// custom scheme handled in the main
 * process, which injects the bearer token and forwards Range headers — so the
 * renderer never sees the token and seeking works.
 */
export function VideoPlayer({
  video,
  channelTitle,
  onClose,
}: {
  video: VideoShape;
  channelTitle: string;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [meta, setMeta] = useState<FileMetaShape | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [transferred, setTransferred] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setMeta(null);
    void api
      .fileMeta(video.video_id)
      .then((m) => {
        if (!alive) return;
        setMeta(m);
        // Metadata is in hand; playback state is tracked by the <video> itself.
        setLoading(false);
      })
      .catch((e: Error) => {
        if (!alive) return;
        setLoading(false);
        setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [video.video_id]);

  const shareUrl = async () => {
    try {
      const r = await files.shareUrl(video.video_id);
      toast.success(r.message);
    } catch (e) {
      toast.fromError(e);
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(watchUrl(video.video_id));
      toast.success('YouTube link copied.');
    } catch {
      toast.error('Clipboard unavailable.');
    }
  };

  /** (b) SHARE / TRANSFER THE ACTUAL FILE. Requires a completed download. */
  const saveToComputer = async () => {
    try {
      const r = await files.saveToComputer(video.video_id);
      if (r.cancelled) return;
      toast.info('Transfer started — progress is shown under the toolbar.');
    } catch (e) {
      toast.fromError(e);
    }
  };

  /**
   * Sharing a FILE (not a URL) only makes sense once we have a local path on
   * this computer, so we first transfer, then hand the local file to the OS.
   */
  const shareLocalFile = async (destPath: string) => {
    try {
      const r = await files.shareFile(destPath);
      toast.success(r.message);
    } catch (e) {
      toast.fromError(e);
    }
  };

  // Track this video's local destination once the transfer completes, so we
  // can offer "share the saved file" without the renderer inventing a path.
  useEffect(() => {
    const off = files.onTransferEvent((raw) => {
      const snap = raw as { videoId: string; status: string; destPath: string | null };
      if (snap.videoId === video.video_id && snap.status === 'completed' && snap.destPath) {
        setTransferred(snap.destPath);
      }
    });
    return off;
  }, [video.video_id]);

  const playable = hasLocalFile(video);
  // Same /files/{id}/stream serves both; only the element differs.
  const mediaType = video.media_type ?? 'video';
  const isAudio = mediaType === 'audio';
  // The mime comes from /files/{id}/metadata (audio/mpeg for MP3s), never hardcoded.
  const mime = meta?.mime_type ?? (isAudio ? 'audio/mpeg' : 'video/mp4');
  void mime;

  return (
    <Modal open onClose={onClose} title={video.title} wide footer={
      <>
        <Button onClick={copyLink}>Copy YouTube link</Button>
        <Button onClick={shareUrl}>Open on YouTube</Button>
        <Button variant="primary" disabled={!playable} onClick={() => void saveToComputer()}>
          Save to this computer
        </Button>
      </>
    }>
      <div className="stack" style={{ gap: 16 }}>
        {playable ? (
          <>
            {/* The <video> is ALWAYS mounted when a file exists — the spinner is
                an overlay, never a gate. Gating on load state deadlocks: the
                element that clears the flag never mounts. */}
            <div className={`player-shell${isAudio ? ' audio' : ''}`}>
              {isAudio ? (
                <div className="audio-stage">
                  <img className="audio-cover" src={thumbUrl(video.video_id)} alt="" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                  <span className="audio-badge">♪ MP3</span>
                </div>
              ) : null}
              {isAudio ? (
                <audio
                  ref={videoRef as unknown as React.RefObject<HTMLAudioElement>}
                  src={mediaUrl(video.video_id)}
                  controls
                  autoPlay
                  preload="metadata"
                  onLoadedMetadata={() => { setLoading(false); setError(null); }}
                  onCanPlay={() => setLoading(false)}
                  onPlaying={() => setLoading(false)}
                  onError={() => { setLoading(false); setError('Playback failed. The file may be missing on the phone.'); }}
                />
              ) : (
              <video
                ref={videoRef}
                src={mediaUrl(video.video_id)}
                controls
                autoPlay
                preload="metadata"
                onLoadedMetadata={() => {
                  setLoading(false);
                  setError(null);
                }}
                onCanPlay={() => setLoading(false)}
                onPlaying={() => setLoading(false)}
                onError={() => {
                  setLoading(false);
                  // `video` here is the server model; the media element is the ref.
                  const mediaError = videoRef.current?.error;
                  setError(
                    mediaError?.message
                      ? `Playback failed: ${mediaError.message} (code ${mediaError.code})`
                      : 'Playback failed. The file may be missing on the phone, or the server refused the stream.',
                  );
                }}
              />
              )}
              {loading ? (
                <div className="player-overlay">
                  <span className="spinner spinner-lg" aria-hidden />
                  <span className="tiny muted">Loading stream…</span>
                </div>
              ) : null}
            </div>
          </>
        ) : (
          <Alert tone="warn">
            This video is <strong>{STATE_LABELS[video.status as keyof typeof STATE_LABELS] ?? video.status}</strong>
            {' '}and has no file on the server, so there is nothing to play. You can still open the original on
            YouTube.
          </Alert>
        )}

        {error ? <Alert tone="danger">{error}</Alert> : null}

        <div className="row row-wrap" style={{ gap: 6 }}>
          <Badge tone={video.status === 'completed' ? 'success' : 'default'} dot>
            {STATE_LABELS[video.status as keyof typeof STATE_LABELS] ?? video.status}
          </Badge>
          {effectiveQualityLabel(video.quality, video.quality_height) ? (
            <Badge title="Actual resolution stored on the phone (quality_height)">{effectiveQualityLabel(video.quality, video.quality_height)}</Badge>
          ) : null}
          {video.kind === 'short' ? <Badge>Short</Badge> : null}
          {meta ? <Badge title="Supports HTTP range requests">{meta.supports_ranges ? 'Resumable' : 'No resume'}</Badge> : null}
          {meta?.mime_type ? <Badge>{meta.mime_type}</Badge> : null}
        </div>

        {meta ? (
          <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 16px', margin: 0, fontSize: 13 }}>
            <dt className="muted">Filename</dt>
            <dd className="mono" style={{ margin: 0 }}>{meta.filename}</dd>
            <dt className="muted">Size</dt>
            <dd className="numeric" style={{ margin: 0 }}>{formatBytes(meta.size_bytes)}</dd>
            <dt className="muted">Channel</dt>
            <dd style={{ margin: 0 }}>{channelTitle}</dd>
            <dt className="muted">Published</dt>
            <dd style={{ margin: 0 }}>{formatDateTime(video.published_at)}</dd>
            <dt className="muted">Library row</dt>
            <dd className="mono faint" style={{ margin: 0 }} title="Display only — this is the phone's path, not a path on your computer">
              {video.file_path ?? '—'}
            </dd>
          </dl>
        ) : null}

        {video.description ? (
          <details>
            <summary className="muted" style={{ cursor: 'pointer', fontSize: 13 }}>
              Description
            </summary>
            <p className="muted" style={{ fontSize: 13, marginTop: 8, whiteSpace: 'pre-wrap' }}>
              {video.description}
            </p>
          </details>
        ) : null}

        <div className="divider" style={{ margin: 0 }} />

        <div className="stack" style={{ gap: 8 }}>
          <h4>Two different share actions</h4>
          <div className="row row-wrap">
            <Button size="sm" onClick={shareUrl}>
              Share URL — open the original on YouTube
            </Button>
            <Button size="sm" onClick={copyLink}>
              Copy URL
            </Button>
            <Button size="sm" variant="primary" disabled={!playable} onClick={() => void saveToComputer()}>
              Save file to this computer
            </Button>
            {transferred ? (
              <>
                <Button size="sm" onClick={() => void shareLocalFile(transferred)}>
                  Share the saved file with another app
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void files.playLocal(transferred)}
                >
                  Play in system player
                </Button>
              </>
            ) : null}
          </div>
          <p className="tiny faint">
            Sharing a URL never implies a file exists. Sharing a file requires <code>status = completed</code>{' '}
            and goes through <span className="mono">/files/&#123;video_id&#125;/download</span> with your token.
          </p>
        </div>
      </div>
    </Modal>
  );
}

export interface DeletePreview {
  /** Records that would be removed. */
  deleted: number;
  /** Files that would be erased from the phone. */
  filesDeleted: number;
  /** Rows whose file is already gone. */
  filesMissing: number;
}

export function DeleteConfirm({
  open,
  title,
  count,
  deleteFiles,
  onDeleteFilesChange,
  onConfirm,
  onCancel,
  busy,
  preview,
  previewError,
  previewing,
  watchedCount,
}: {
  open: boolean;
  title: string;
  count: number;
  deleteFiles: boolean;
  onDeleteFilesChange: (v: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  preview?: DeletePreview | null;
  previewError?: string | null;
  previewing?: boolean;
  /** How many selected videos are watched (matters when delete-after-watch is on). */
  watchedCount?: number;
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel} data-autofocus>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={busy}
            disabled={previewing}
            onClick={onConfirm}
            title={previewing ? 'Checking what would be erased…' : 'Permanently delete'}
          >
            {count === 1 ? 'Delete video' : `Delete ${count} videos`}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Alert tone="danger">
          This cannot be undone.
          {count > 1
            ? ` ${count} library rows will be removed from the phone.`
            : ' The library row will be removed from the phone.'}
        </Alert>

        <label className="toggle-row" style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            className="checkbox"
            checked={deleteFiles}
            onChange={(e) => onDeleteFilesChange(e.target.checked)}
            style={{ marginTop: 3 }}
          />
          <span>
            <strong>Also delete the downloaded file(s) on the phone</strong>
            <div className="hint">
              Unchecked keeps the file on disk but removes the library row. Checked erases the media
              permanently. The server refuses to delete anything outside its media directory.
            </div>
          </span>
        </label>

        {/* Dry run: the server tells us exactly what would be erased before we do it. */}
        {previewing ? (
          <div className="row muted tiny" style={{ gap: 8 }} aria-live="polite">
            <span className="spinner" aria-hidden /> Checking what this would delete…
          </div>
        ) : previewError ? (
          <Alert tone="warn">{previewError}</Alert>
        ) : preview ? (
          <div className="card" style={{ padding: 14, background: 'var(--surface-2)' }}>
            <div className="tiny faint" style={{ marginBottom: 6 }}>
              Preview (nothing has been deleted yet)
            </div>
            <div className="row row-wrap" style={{ gap: '6px 18px' }}>
              <span>
                <strong>{preview.deleted}</strong> library record{preview.deleted === 1 ? '' : 's'}
              </span>
              <span style={{ color: deleteFiles && preview.filesDeleted > 0 ? 'var(--danger)' : undefined }}>
                <strong>{deleteFiles ? preview.filesDeleted : 0}</strong> file
                {(deleteFiles ? preview.filesDeleted : 0) === 1 ? '' : 's'} erased from the phone
              </span>
              {preview.filesMissing > 0 ? (
                <span className="muted">
                  <strong>{preview.filesMissing}</strong> already missing on disk
                </span>
              ) : null}
            </div>
            {deleteFiles && preview.filesDeleted > 0 ? (
              <p className="tiny" style={{ color: 'var(--danger)', marginTop: 8 }}>
                This will permanently erase {preview.filesDeleted} file
                {preview.filesDeleted === 1 ? '' : 's'} from the phone.
              </p>
            ) : null}
            {deleteFiles && preview.filesDeleted === 0 ? (
              <p className="tiny faint" style={{ marginTop: 8 }}>
                No files will be erased — only library records are removed.
              </p>
            ) : null}
          </div>
        ) : null}

        {watchedCount && watchedCount > 0 ? (
          <p className="tiny faint">
            {watchedCount} of the selected videos {watchedCount === 1 ? 'is' : 'are'} already watched.
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

export function RetentionConfirm({
  open,
  onConfirm,
  onCancel,
  busy,
}: {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  return (
    <Modal
      open={open}
      title="Enable delete-after-watch?"
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="danger" loading={busy} onClick={onConfirm}>
            I understand — enable it
          </Button>
        </>
      }
    >
      <Alert tone="danger">
        <strong>The downloaded file will be permanently erased when you finish watching it.</strong>
        <p style={{ marginTop: 8 }}>
          The library row is kept so you still see the title and metadata, but the video file on the phone is
          deleted as soon as you mark it watched. There is no undo and no copy on the phone afterwards.
        </p>
      </Alert>
    </Modal>
  );
}

export function openExternal(url: string): void {
  void appApi.openExternal(url).catch(() => toast.error('Could not open the browser.'));
}