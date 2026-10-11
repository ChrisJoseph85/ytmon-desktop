import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, EmptyState, PillGroup, Select, Skeleton } from '../components/ui';
import { VideoCard } from '../components/VideoCard';
import { DeleteConfirm, VideoPlayer, type DeletePreview } from '../components/VideoPlayer';
import { api, files, toast, type ChannelShape, type DeleteResultShape, type JobShape, type VideoShape } from '../lib/bridge';
import { usePolling } from '../lib/hooks';
import { useConnection } from '../state/connection';
import { downloadUrlForSearch, filterByMediaType } from '../lib/filters';
import { qualityLabelsFrom } from '../lib/labels';
import { formatBytes } from '@shared/format';

type View = 'all' | 'new' | 'unwatched' | 'watched' | 'downloading' | 'completed' | 'failed';
type Kind = 'all' | 'video' | 'short';

const VIEWS: { id: View; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'new', label: 'New' },
  { id: 'unwatched', label: 'Unwatched' },
  { id: 'watched', label: 'Watched' },
  { id: 'downloading', label: 'Downloading' },
  { id: 'completed', label: 'Completed' },
  { id: 'failed', label: 'Failed' },
];

export function LibraryScreen() {
  const settings = useConnection((s) => s.settings);

  const [view, setView] = useState<View>('all');
  const [kind, setKind] = useState<Kind>('all');
  const [mediaType, setMediaType] = useState<'all' | 'video' | 'audio'>('all');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [channelId, setChannelId] = useState('');
  const [sort, setSort] = useState('published_at');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [playing, setPlaying] = useState<VideoShape | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<VideoShape[] | null>(null);
  const [deleteFiles, setDeleteFiles] = useState(true);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [preview, setPreview] = useState<DeletePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [lastDelete, setLastDelete] = useState<DeleteResultShape | null>(null);
  // Surfaced so it is obvious WHY an item survived automatic cleanup.
  const [pinnedCount, setPinnedCount] = useState(0);

  const [channels, setChannels] = useState<ChannelShape[]>([]);
  const [qualityOptions, setQualityOptions] = useState<{ value: string; label: string }[]>([]);

  const pageSize = 24;

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search.trim());
      setPage(1);
    }, 280);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    void api.listChannels().then(setChannels).catch(() => undefined);
    void api.listPinned().then((p) => setPinnedCount(p.length)).catch(() => undefined);
    void api
      .qualityOptions()
      .then((q) => setQualityOptions(qualityLabelsFrom(q.options)))
      .catch(() => undefined);
  }, []);

  const query = useMemo(
    () =>
      downloadUrlForSearch({
        view,
        kind,
        mediaType,
        search: debounced,
        channelId,
        sort,
        order,
        page,
        page_size: pageSize,
      }),
    [view, kind, mediaType, debounced, channelId, sort, order, page],
  );

  const videos = usePolling(() => api.listVideos(query), 20_000, [query]);
  const channelTitle = useCallback(
    (cid: string) => channels.find((c) => c.channel_id === cid)?.title || cid,
    [channels],
  );

  // Poll individual jobs only while something is actually downloading. The
  // 1.5s interval exists only when there is active work.
  const activeIds = useMemo(
    () =>
      (videos.data?.items ?? [])
        .filter((v) => v.status === 'downloading' || v.status === 'queued')
        .map((v) => v.video_id)
        .sort(),
    [videos.data],
  );
  const activeKey = activeIds.join(',');
  const [jobs, setJobs] = useState<Record<string, JobShape>>({});

  useEffect(() => {
    const ids = activeKey === '' ? [] : activeKey.split(',');
    if (ids.length === 0) return;
    let alive = true;
    const poll = () => {
      for (const id of ids) {
        void api
          .job(id)
          .then((j) => alive && setJobs((prev) => ({ ...prev, [id]: j })))
          .catch(() => undefined);
      }
    };
    poll();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') poll();
    }, 1500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [activeKey]);

  const refreshAll = useCallback(() => {
    videos.refresh();
    setChannels((prev) => {
      void api.listChannels().then(setChannels).catch(() => undefined);
    void api.listPinned().then((p) => setPinnedCount(p.length)).catch(() => undefined);
      return prev;
    });
  }, [videos]);

  const toggleWatched = async (video: VideoShape) => {
    setBusyId(video.video_id);
    try {
      const updated = await api.setWatched(video.video_id, !video.watched);
      videos.setData((prev) =>
        prev
          ? {
              ...prev,
              items: prev.items.map((v) => (v.video_id === updated.video_id ? { ...v, ...updated } : v)),
            }
          : prev!,
      );
      // Mirror the server: if delete-after-watch is on, the file is gone.
      const r = await api.getRetention();
      if (r.delete_file_when_watched && !video.watched) {
        toast.info('Marked watched — the server erased the file (delete-after-watch is on).');
      }
    } catch (e) {
      toast.fromError(e);
    } finally {
      setBusyId(null);
    }
  };

  const saveToComputer = async (video: VideoShape) => {
    setBusyId(video.video_id);
    try {
      const r = await files.saveToComputer(video.video_id);
      if (r.cancelled) return;
      toast.info(`Transferring ${video.title} — progress appears under the toolbar.`);
    } catch (e) {
      toast.fromError(e);
    } finally {
      setBusyId(null);
    }
  };

  const shareUrl = async (video: VideoShape) => {
    try {
      const r = await files.shareUrl(video.video_id);
      toast.success(r.message);
    } catch (e) {
      toast.fromError(e);
    }
  };

  const togglePin = async (video: VideoShape) => {
    const next = !video.pinned;
    setBusyId(video.video_id);
    try {
      const updated = await api.setPinned(video.video_id, next);
      videos.setData((prev) =>
        prev
          ? { ...prev, items: prev.items.map((v) => (v.video_id === updated.video_id ? { ...v, ...updated } : v)) }
          : prev!,
      );
      setPinnedCount((c) => Math.max(0, c + (next ? 1 : -1)));
      toast.success(next ? 'Pinned — this item survives automatic deletion.' : 'Unpinned.');
    } catch (e) {
      toast.fromError(e);
    } finally {
      setBusyId(null);
    }
  };

  const pinSelection = async (pinned: boolean) => {
    const ids = items.filter((v) => selected.has(v.video_id)).map((v) => v.video_id);
    if (ids.length === 0) return;
    try {
      await api.pinVideos(ids, pinned);
      videos.setData((prev) =>
        prev
          ? { ...prev, items: prev.items.map((v) => (selected.has(v.video_id) ? { ...v, pinned } : v)) }
          : prev!,
      );
      setPinnedCount((c) => Math.max(0, c + (pinned ? ids.length : -ids.length)));
      toast.success(`${pinned ? 'Pinned' : 'Unpinned'} ${ids.length} video${ids.length === 1 ? '' : 's'}.`);
      setSelected(new Set());
    } catch (e) {
      toast.fromError(e);
    }
  };

  const retry = async (video: VideoShape) => {
    try {
      await api.retry(video.video_id);
      toast.success('Retry queued on the phone.');
      refreshAll();
    } catch (e) {
      toast.fromError(e);
    }
  };

  const cancelJob = async (video: VideoShape) => {
    try {
      await api.cancelJob(video.video_id);
      toast.info('Cancelled.');
      refreshAll();
    } catch (e) {
      toast.fromError(e);
    }
  };

  /**
   * Opens the confirmation and asks the server for a dry run first, so the user
   * sees exactly how many files will be erased before anything is destroyed.
   */
  const openDelete = async (targets: VideoShape[]) => {
    setDeleteTarget(targets);
    setPreview(null);
    setPreviewError(null);
    setPreviewing(true);
    try {
      const ids = targets.map((v) => v.video_id);
      const r =
        ids.length === 1
          ? await api.deleteVideo(ids[0]!, deleteFiles, true)
          : await api.previewBulkDelete(ids, deleteFiles);
      setPreview({ deleted: r.deleted, filesDeleted: r.files_deleted, filesMissing: r.files_missing });
    } catch (e) {
      setPreviewError(
        `Could not preview this deletion: ${(e as Error).message}. You can still delete, but the file count is unknown.`,
      );
    } finally {
      setPreviewing(false);
    }
  };

  /** Re-runs the preview when the file checkbox changes. */
  useEffect(() => {
    if (deleteTarget === null || previewing) return;
    const ids = deleteTarget.map((v) => v.video_id);
    let alive = true;
    void (ids.length === 1
      ? api.deleteVideo(ids[0]!, deleteFiles, true)
      : api.previewBulkDelete(ids, deleteFiles)
    )
      .then((r) => alive && setPreview({ deleted: r.deleted, filesDeleted: r.files_deleted, filesMissing: r.files_missing }))
      .catch((e: Error) => alive && setPreviewError(`Could not preview this deletion: ${e.message}`));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deleteFiles, deleteTarget]);

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try {
      const ids = deleteTarget.map((v) => v.video_id);
      const result =
        ids.length === 1
          ? await api.deleteVideo(ids[0]!, deleteFiles, false)
          : await api.bulkDelete(ids, deleteFiles, false);
      setLastDelete(result);
      setDeleteTarget(null);
      setPreview(null);
      setSelected(new Set());
      toast.success(
        `Deleted ${result.deleted} record${result.deleted === 1 ? '' : 's'}` +
          (deleteFiles ? `, ${result.files_deleted} file${result.files_deleted === 1 ? '' : 's'} erased` : '') +
          (result.files_missing > 0 ? `, ${result.files_missing} already missing` : ''),
      );
      if (result.errors.length > 0) {
        toast.error(`Some items failed: ${result.errors.slice(0, 3).join('; ')}`);
      }
      refreshAll();
    } catch (e) {
      toast.fromError(e);
    } finally {
      setDeleteBusy(false);
    }
  };

  // The server has no media_type query param, so this filter is applied here.
  const rawItems = useMemo(() => videos.data?.items ?? [], [videos.data]);
  const items = useMemo(() => filterByMediaType(rawItems, mediaType), [rawItems, mediaType]);
  const total = videos.data?.total ?? 0;
  const mediaFiltered = mediaType !== 'all' && rawItems.length !== items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const selectAll = () => {
    if (selected.size >= items.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(items.map((v) => v.video_id)));
    }
  };

  return (
    <>
      <div className="library-toolbar">
        <div className="row row-wrap">
          <PillGroup
            ariaLabel="Library views"
            value={view}
            onChange={(v) => {
              setView(v);
              setPage(1);
            }}
            options={VIEWS.map((v) => ({ value: v.id, label: v.label }))}
          />
          <span className="spacer" />
          <input
            className="input"
            style={{ maxWidth: 240 }}
            type="search"
            placeholder="Search titles…"
            value={search}
            aria-label="Search videos"
            onChange={(e) => setSearch(e.target.value)}
          />
          <Button onClick={refreshAll} loading={videos.loading}>
            Refresh
          </Button>
        </div>

        <div className="row row-wrap filters">
          <Select
            value={kind}
            ariaLabel="Content kind filter"
            onChange={(v) => {
              setKind(v as Kind);
              setPage(1);
            }}
            options={[
              { value: 'all', label: 'All content' },
              { value: 'video', label: 'Videos only' },
              { value: 'short', label: 'Shorts only' },
            ]}
          />
          <div className="media-toggle" role="group" aria-label="Filter by media type">
            <button type="button" aria-pressed={mediaType === 'all'} onClick={() => { setMediaType('all'); setPage(1); }}>
              All
            </button>
            <button type="button" aria-pressed={mediaType === 'video'} onClick={() => { setMediaType('video'); setPage(1); }}>
              Video
            </button>
            <button type="button" aria-pressed={mediaType === 'audio'} onClick={() => { setMediaType('audio'); setPage(1); }}>
              Audio
            </button>
          </div>
          <Select
            ariaLabel="Filter by channel"
            value={channelId}
            onChange={(v) => {
              setChannelId(v);
              setPage(1);
            }}
            options={[
              { value: '', label: 'All channels' },
              ...channels.map((c) => ({ value: c.channel_id, label: c.title || c.channel_id })),
            ]}
          />
          <Select
            ariaLabel="Sort order"
            value={`${sort}:${order}`}
            onChange={(v) => {
              const [s, o] = v.split(':');
              setSort(s!);
              setOrder(o === 'asc' ? 'asc' : 'desc');
              setPage(1);
            }}
            options={[
              { value: 'published_at:desc', label: 'Newest published' },
              { value: 'published_at:asc', label: 'Oldest published' },
              { value: 'created_at:desc', label: 'Recently added' },
              { value: 'title:asc', label: 'Title A→Z' },
              { value: 'duration:desc', label: 'Longest' },
              { value: 'file_size:desc', label: 'Largest file' },
              { value: 'file_size:asc', label: 'Smallest file' },
            ]}
          />
          {selected.size > 0 ? (
            <span className="badge badge-accent">{selected.size} selected</span>
          ) : null}
          <span className="spacer" />
          <Button size="sm" onClick={selectAll} disabled={items.length === 0}>
            {selected.size >= items.length && items.length > 0 ? 'Clear selection' : 'Select page'}
          </Button>
          <Button
            size="sm"
            disabled={selected.size === 0}
            onClick={() => void pinSelection(true)}
            title="Keep the selected videos permanently — they survive delete-after-watch and retention"
          >
            📌 Pin selected
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={selected.size === 0}
            onClick={() => void openDelete(items.filter((v) => selected.has(v.video_id)))}
          >
            Delete selected
          </Button>
        </div>

        {pinnedCount > 0 ? (
          <p className="tiny faint">
            <Badge tone="warn">📌 {pinnedCount} pinned</Badge>{' '}
            Pinned items are kept permanently — they are why some videos are never cleaned up automatically.
          </p>
        ) : null}

        {mediaFiltered ? (
          <p className="tiny faint">
            Showing {items.length} of {rawItems.length} on this page — the server has no media_type filter, so
            this is applied locally. Use sort/date or scroll for the rest.
          </p>
        ) : null}

        {qualityOptions.length > 0 ? (
          <p className="tiny faint" title={qualityOptions.map((q) => q.label).join(' · ')}>
            Quality is a maximum height, set on the phone: {qualityOptions.map((q) => q.value).join(' · ')}
          </p>
        ) : null}
      </div>

      {lastDelete && lastDelete.errors.length > 0 ? (
        <Alert tone="warn" action={<Button size="sm" onClick={() => setLastDelete(null)}>Dismiss</Button>}>
          Some deletions reported problems: {lastDelete.errors.join('; ')}
        </Alert>
      ) : null}

      {videos.error ? (
        <Alert tone="danger" action={<Button size="sm" onClick={videos.refresh}>Retry</Button>}>
          <div className="mono">{videos.error}</div>
          <p className="hint" style={{ marginTop: 6 }}>
            The server did not answer. If you changed networks, the phone's IP may have changed — update it in
            Connection settings.
          </p>
        </Alert>
      ) : null}

      {videos.loading && items.length === 0 ? (
        <div className="video-grid">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="video-card">
              <Skeleton height={162} />
              <div className="video-body">
                <Skeleton height={16} />
                <Skeleton height={12} width="70%" />
                <Skeleton height={20} width="45%" />
              </div>
            </div>
          ))}
        </div>
      ) : items.length === 0 && !videos.error ? (
        <EmptyState icon="▦" title={emptyTitle(view, debounced, channelId)}>
          <p className="muted">
            {view === 'all'
              ? 'Nothing here yet. Add a channel on the Channels screen, then press “Scan now”.'
              : 'Try a different view or clear the filters above.'}
          </p>
        </EmptyState>
      ) : (
        <div className="video-grid">
          {items.map((video) => (
            <VideoCard
              key={video.video_id}
              video={video}
              job={jobs[video.video_id] ?? null}
              channelTitle={channelTitle(video.channel_id)}
              selected={selected.has(video.video_id)}
              onSelect={(id, next) =>
                setSelected((prev) => {
                  const s = new Set(prev);
                  if (next) s.add(id);
                  else s.delete(id);
                  return s;
                })
              }
              onOpen={setPlaying}
              onToggleWatched={(v) => void toggleWatched(v)}
              onSave={(v) => void saveToComputer(v)}
              onShareUrl={(v) => void shareUrl(v)}
              onRetry={(v) => void retry(v)}
              onCancelJob={(v) => void cancelJob(v)}
              onDelete={(v) => void openDelete([v])}
              onTogglePin={(v) => void togglePin(v)}
              busy={busyId === video.video_id}
            />
          ))}
        </div>
      )}

      {total > pageSize ? (
        <div className="row" style={{ marginTop: 24, justifyContent: 'center' }}>
          <Button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            ← Previous
          </Button>
          <span className="muted numeric">
            Page {page} of {totalPages} · {total.toLocaleString()} videos
          </span>
          <Button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
            Next →
          </Button>
        </div>
      ) : items.length > 0 ? (
        <div className="row tiny faint" style={{ marginTop: 16, justifyContent: 'center' }}>
          <span>
            {total.toLocaleString()} video{total === 1 ? '' : 's'} · server page size {settings ? '' : ''}
            {pageSize}
          </span>
        </div>
      ) : null}

      {playing ? (
        <VideoPlayer video={playing} channelTitle={channelTitle(playing.channel_id)} onClose={() => setPlaying(null)} />
      ) : null}

      <DeleteConfirm
        open={deleteTarget !== null}
        title={deleteTarget && deleteTarget.length > 1 ? `Delete ${deleteTarget.length} videos?` : 'Delete video?'}
        count={deleteTarget?.length ?? 0}
        deleteFiles={deleteFiles}
        onDeleteFilesChange={setDeleteFiles}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
        busy={deleteBusy}
        preview={preview}
        previewError={previewError}
        previewing={previewing}
        watchedCount={deleteTarget?.filter((v) => v.watched).length ?? 0}
      />
    </>
  );
}

function emptyTitle(view: View, search: string, channelId: string): string {
  if (search) return `No videos match “${search}”`;
  if (channelId) return 'This channel has no matching videos';
  const map: Record<View, string> = {
    all: 'Your library is empty',
    new: 'No new videos',
    unwatched: 'Nothing unwatched',
    watched: 'Nothing watched yet',
    downloading: 'No active downloads',
    completed: 'No completed downloads',
    failed: 'No failed downloads',
  };
  return map[view];
}

export { formatBytes };