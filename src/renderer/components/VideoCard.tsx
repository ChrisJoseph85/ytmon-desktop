import { memo } from 'react';
import { Badge, Button, Progress, Thumb } from './ui';
import { STATE_LABELS, effectiveQualityLabel, hasLocalFile, isActive } from '@shared/quality';
import type { VideoShape } from '../lib/bridge';
import type { JobShape } from '../lib/bridge';

export function stateTone(status: string): 'default' | 'success' | 'info' | 'warn' | 'danger' | 'accent' {
  switch (status) {
    case 'completed':
      return 'success';
    case 'downloading':
      return 'accent';
    case 'queued':
      return 'info';
    case 'failed':
      return 'danger';
    case 'unavailable':
      return 'warn';
    default:
      return 'default';
  }
}

export interface VideoCardProps {
  video: VideoShape;
  job?: JobShape | null;
  channelTitle: string;
  selected: boolean;
  onSelect: (videoId: string, next: boolean) => void;
  onOpen: (video: VideoShape) => void;
  onToggleWatched: (video: VideoShape) => void;
  onSave: (video: VideoShape) => void;
  onShareUrl: (video: VideoShape) => void;
  onRetry: (video: VideoShape) => void;
  onCancelJob: (video: VideoShape) => void;
  onDelete: (video: VideoShape) => void;
  onTogglePin: (video: VideoShape) => void;
  onDownload?: (video: VideoShape) => void;
  busy?: boolean;
}

export const VideoCard = memo(function VideoCard({
  video,
  job,
  channelTitle,
  selected,
  onSelect,
  onOpen,
  onToggleWatched,
  onSave,
  onShareUrl,
  onRetry,
  onCancelJob,
  onDelete,
  onTogglePin,
  onDownload,
  busy,
}: VideoCardProps) {
  const file = hasLocalFile(video);
  const active = isActive(video.status);
  // Branch on media_type, never on the file extension.
  const mediaType = video.media_type ?? 'video';
  const progress = job && active ? job.progress : null;
  const qualityLabel = effectiveQualityLabel(video.quality, video.quality_height);

  return (
    <article
      className={`video-card${video.watched ? ' watched' : ''}${selected ? ' selected' : ''}`}
      style={video.pinned ? { borderColor: 'var(--warn)' } : undefined}
    >
      <div
        className="thumb"
        role="button"
        tabIndex={0}
        aria-label={`Play ${video.title}`}
        onClick={() => onOpen(video)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen(video);
          }
        }}
      >
        <Thumb
          videoId={video.video_id}
          alt={video.title}
          duration={video.duration}
          kind={video.kind}
          mediaType={mediaType}
        />
        <button
          className="thumb-check"
          aria-label={video.watched ? `Mark ${video.title} as unwatched` : `Mark ${video.title} as watched`}
          aria-pressed={video.watched}
          onClick={(e) => {
            e.stopPropagation();
            onSelect(video.video_id, e.shiftKey || e.metaKey || e.ctrlKey);
          }}
          title="Shift-click to multi-select"
        >
          {video.watched ? '✓' : ''}
        </button>
        {progress !== null ? (
          <div className="video-progress">
            <div className="video-progress-fill" style={{ width: `${Math.min(100, progress)}%` }} />
          </div>
        ) : null}
      </div>

      <div className="video-body">
        <button className="video-title clamp-2" onClick={() => onOpen(video)} title={video.title}>
          {mediaType === 'audio' ? '♪ ' : ''}
          {video.title}
        </button>

        <div className="video-meta">
          <span className="truncate" style={{ maxWidth: 160 }} title={channelTitle}>
            {channelTitle}
          </span>
          <span aria-hidden>·</span>
          <span>{video.published_at ? new Date(video.published_at).toLocaleDateString() : 'No date'}</span>
        </div>

        <div className="row row-wrap" style={{ gap: 6 }}>
          <Badge tone={stateTone(video.status)} dot>
            {STATE_LABELS[video.status as keyof typeof STATE_LABELS] ?? video.status}
          </Badge>
          {qualityLabel ? <Badge title="Actual stored resolution (quality_height), not the requested ceiling">{qualityLabel}</Badge> : null}
          {video.watched ? <Badge tone="info">Watched</Badge> : null}
          {video.kind === 'short' ? <Badge>Short</Badge> : null}
          {mediaType === 'audio' ? <Badge tone="accent">Audio · MP3</Badge> : null}
          {video.pinned ? (
            <Badge tone="warn" dot title="Kept permanently — survives delete-after-watch and retention">
              📌 Pinned
            </Badge>
          ) : null}
        </div>

        {video.status === 'failed' && video.error_message ? (
          <div className="tiny" style={{ color: 'var(--danger)' }} title={video.error_message}>
            <span className="clamp-2">{video.error_message}</span>
          </div>
        ) : null}
        {/* A manual (or not-yet-due) channel leaves its uploads `discovered`:
            they are in the library, just not downloaded. This is the one-click
            path to fetch one. */}
        {video.status === 'discovered' ? (
          <div className="tiny faint">Found by discovery — not downloaded yet.</div>
        ) : null}
        {video.status === 'unavailable' ? (
          <div className="tiny faint">
            Not available (private, removed, or restricted). Not retryable.
          </div>
        ) : null}
        {active && job ? (
          <div className="tiny faint numeric">
            {Math.round(job.progress)}% · {job.speed ? `${(job.speed / 1_048_576).toFixed(1)} MB/s` : '—'}
            {job.eta ? ` · eta ${Math.round(job.eta)}s` : ''}
          </div>
        ) : null}

        <div className="video-actions">
          <Button size="sm" onClick={() => onToggleWatched(video)} title="Toggle watched">
            {video.watched ? '↺ Unwatch' : '✓ Watched'}
          </Button>
          <Button size="sm" disabled={!file || busy} onClick={() => onSave(video)} title={file ? 'Download the actual file to this computer' : 'No file on the server'}>
            ⭳ Save
          </Button>
          <Button size="sm" onClick={() => onShareUrl(video)} title="Open the original on YouTube (not a file share)">
            Link
          </Button>
          {video.status === 'failed' ? (
            <Button size="sm" onClick={() => onRetry(video)}>
              Retry
            </Button>
          ) : null}
          {video.status === 'discovered' && onDownload ? (
            <Button size="sm" variant="primary" disabled={busy} onClick={() => onDownload(video)} title="Download this discovered video now">
              ⭳ Get
            </Button>
          ) : null}
          {video.status === 'queued' ? (
            <Button size="sm" onClick={() => onCancelJob(video)}>
              Unqueue
            </Button>
          ) : null}
          
          <Button
            size="sm"
            variant={video.pinned ? 'primary' : 'ghost'}
            onClick={() => onTogglePin(video)}
            aria-pressed={video.pinned}
            title={
              video.pinned
                ? 'Unpin — this item is no longer protected from automatic deletion'
                : 'Keep permanently — survives delete-after-watch and retention rules'
            }
          >
            📌
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onDelete(video)} aria-label={`Delete ${video.title}`}>
            🗑
          </Button>
        </div>
      </div>
    </article>
  );
});

export function JobProgress({ job }: { job: JobShape }) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row">
        <span>{STATE_LABELS[job.status as keyof typeof STATE_LABELS] ?? job.status}</span>
        <span className="spacer" />
        <span className="numeric tiny muted">{Math.round(job.progress)}%</span>
      </div>
      <Progress value={job.progress} large />
      <div className="tiny faint numeric row">
        <span>
          {(job.downloaded_bytes ?? 0).toLocaleString()} / {(job.total_bytes ?? 0).toLocaleString()} bytes
        </span>
        <span className="spacer" />
        <span>{job.speed ? `${(job.speed / 1_048_576).toFixed(2)} MB/s` : '—'}</span>
      </div>
    </div>
  );
}