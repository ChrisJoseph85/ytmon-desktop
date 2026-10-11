import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, EmptyState, Loading, Progress } from '../components/ui';
import { api, files, toast, type JobShape, type QueueStatsShape, type TransferShape } from '../lib/bridge';
import { STATE_LABELS } from '@shared/quality';
import { formatBytes, formatEta } from '@shared/format';

/**
 * The PHONE's downloads (server-side queue) — deliberately distinct from the
 * transfers strip, which shows files moving to THIS computer.
 */
export function DownloadsScreen() {
  const [stats, setStats] = useState<QueueStatsShape | null>(null);
  const [jobs, setJobs] = useState<JobShape[]>([]);
  const [transfers, setTransfers] = useState<TransferShape[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const active = useMemo(() => stats && (stats.downloading > 0 || stats.queued > 0), [stats]);

  const load = async () => {
    try {
      const [s] = await Promise.all([api.queueStats()]);
      setStats(s);
      setError(null);
      // The queue endpoint pages jobs; we only need the in-flight ones.
      const page = await api.listVideos({ status: 'downloading', page_size: 50 });
      const queuedPage = await api.listVideos({ status: 'queued', page_size: 50 });
      const ids = [...page.items, ...queuedPage.items].map((v) => v.video_id);
      const jobList = await Promise.all(
        ids.slice(0, 25).map((id) => api.job(id).catch(() => null)),
      );
      setJobs(jobList.filter((j): j is JobShape => j !== null));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // Poll 1-2s only while something is active; 15s otherwise.
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, active ? 1500 : 15_000);
    return () => clearInterval(id);
  }, [active]);

  useEffect(() => {
    let alive = true;
    void files.list().then((l) => alive && setTransfers(l)).catch(() => undefined);
    const off = files.onTransferEvent((raw) => {
      const snap = raw as TransferShape;
      setTransfers((prev) => {
        const i = prev.findIndex((t) => t.id === snap.id);
        if (i === -1) return [...prev, snap];
        const next = [...prev];
        next[i] = snap;
        return next;
      });
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const retry = async (id: string) => {
    try {
      await api.retry(id);
      toast.success('Retry queued.');
      void load();
    } catch (e) {
      toast.fromError(e);
    }
  };

  const cancel = async (id: string) => {
    try {
      await api.cancelJob(id);
      toast.info('Cancelled.');
      void load();
    } catch (e) {
      toast.fromError(e);
    }
  };

  const localActive = transfers.filter((t) => t.status === 'downloading' || t.status === 'paused' || t.status === 'preparing');
  const localDone = transfers.filter((t) => t.status === 'completed');
  const localFailed = transfers.filter((t) => t.status === 'failed');

  return (
    <div className="stack" style={{ gap: 20 }}>
      {error ? (
        <Alert tone="danger" action={<Button size="sm" onClick={() => void load()}>Retry</Button>}>
          {error}
        </Alert>
      ) : null}

      <Card>
        <div className="card-title">
          <h2>Phone queue</h2>
          <span className="spacer" />
          <Button size="sm" onClick={() => void load()}>
            Refresh
          </Button>
        </div>
        <p className="card-desc">Server-side jobs. Downloading and queued work updates every 1–2 s.</p>
        {stats ? (
          <div className="grid-3">
            <Stat label="Queued" value={stats.queued} tone={stats.queued > 0 ? 'info' : 'default'} />
            <Stat label="Downloading" value={stats.downloading} tone={stats.downloading > 0 ? 'accent' : 'default'} />
            <Stat label="Completed" value={stats.completed} tone="success" />
            <Stat label="Failed" value={stats.failed} tone={stats.failed > 0 ? 'danger' : 'default'} />
            <Stat label="Skipped" value={stats.skipped} />
            <Stat label="Unavailable" value={stats.unavailable} tone={stats.unavailable > 0 ? 'warn' : 'default'} />
          </div>
        ) : loading ? (
          <Loading />
        ) : null}
      </Card>

      <Card>
        <div className="card-title">
          <h2>Active jobs</h2>
        </div>
        {jobs.length === 0 ? (
          <EmptyState icon="⇩" title="Nothing in flight">
            <p className="muted">Jobs the phone is downloading or waiting to download appear here.</p>
          </EmptyState>
        ) : (
          <div className="stack">
            {jobs.map((j) => (
              <div key={j.video_id} className="transfer-row">
                <div className="transfer-head">
                  <span className="truncate" style={{ flex: 1, fontSize: 13 }}>
                    {j.video_id}
                  </span>
                  <Badge tone={j.status === 'downloading' ? 'accent' : 'info'} dot>
                    {STATE_LABELS[j.status as keyof typeof STATE_LABELS] ?? j.status}
                  </Badge>
                  {j.status === 'downloading' ? (
                    <Button size="sm" onClick={() => void cancel(j.video_id)}>
                      Cancel
                    </Button>
                  ) : null}
                  {j.status === 'queued' ? (
                    <Button size="sm" onClick={() => void retry(j.video_id)} title="Queue this download ahead of the others">
                      Prioritise
                    </Button>
                  ) : null}
                </div>
                <Progress
                  value={j.progress}
                  large
                  label={`${Math.round(j.progress)}% downloaded`}
                  tone={j.status === 'downloading' ? 'default' : 'info'}
                />
                <div className="tiny faint numeric row">
                  <span>
                    {formatBytes(j.downloaded_bytes)} / {formatBytes(j.total_bytes)}
                  </span>
                  <span className="spacer" />
                  <span>{j.speed ? `${formatBytes(j.speed)}/s` : '—'}</span>
                  <span>· eta {formatEta(j.eta)}</span>
                  <span>· attempt {j.attempts}</span>
                </div>
                {j.error_message ? <div className="tiny" style={{ color: 'var(--danger)' }}>{j.error_message}</div> : null}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <div className="card-title">
          <h2>Files moving to this computer</h2>
        </div>
        <p className="card-desc">
          Pulled from the phone with HTTP range support: cancel keeps the partial file and resume continues from
          the exact byte.
        </p>
        {transfers.length === 0 ? (
          <EmptyState icon="⭳" title="No transfers yet">
            <p className="muted">Use “Save” on a completed video to pull the actual file onto this computer.</p>
          </EmptyState>
        ) : (
          <div className="stack">
            {[...localActive, ...localFailed, ...localDone].map((t) => (
              <div key={t.id} className="transfer-row">
                <div className="transfer-head">
                  <span className="truncate" style={{ flex: 1, fontSize: 13 }}>
                    {t.filename}
                  </span>
                  <Badge
                    tone={
                      t.status === 'completed' ? 'success' : t.status === 'failed' ? 'danger' : t.status === 'paused' ? 'warn' : 'accent'
                    }
                    dot
                  >
                    {t.status}
                  </Badge>
                  <span className="tiny faint numeric nowrap">
                    {formatBytes(t.received)} / {formatBytes(t.total)}
                  </span>
                </div>
                <Progress value={t.percent} large tone={t.status === 'completed' ? 'success' : 'default'} label={`${t.percent}%`} />
                {t.error ? <div className="tiny" style={{ color: 'var(--danger)' }}>{t.error}</div> : null}
                {!t.supportsResume ? (
                  <div className="tiny faint">The server does not advertise range support for this file.</div>
                ) : null}
                <div className="row">
                  {t.status === 'downloading' || t.status === 'preparing' ? (
                    <Button size="sm" onClick={() => void files.cancel(t.id)}>
                      Cancel
                    </Button>
                  ) : null}
                  {t.status === 'paused' || t.status === 'failed' || t.status === 'cancelled' ? (
                    <Button size="sm" variant="primary" onClick={() => void files.resume(t.id)}>
                      Resume
                    </Button>
                  ) : null}
                  {t.status === 'completed' && t.destPath ? (
                    <>
                      <Button size="sm" onClick={() => void files.playLocal(t.destPath!)}>
                        Play
                      </Button>
                      <Button size="sm" onClick={() => void files.shareFile(t.destPath!)}>
                        Share file
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void files.revealInFolder(t.destPath!)}>
                        Show in folder
                      </Button>
                    </>
                  ) : null}
                  <span className="spacer" />
                  <Button size="sm" variant="ghost" onClick={() => void files.remove(t.id)}>
                    Dismiss
                  </Button>
                </div>
                {t.destPath ? (
                  <div className="tiny faint mono truncate" title={t.destPath}>
                    {t.destPath}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function Stat({ label, value, tone = 'default' }: { label: string; value: number; tone?: 'default' | 'success' | 'info' | 'warn' | 'danger' | 'accent' }) {
  return (
    <div className="card" style={{ padding: 14, background: 'var(--surface-2)' }}>
      <div className="tiny faint">{label}</div>
      <div
        className="numeric"
        style={{
          fontSize: 22,
          fontWeight: 650,
          color: value > 0 ? `var(--${tone === 'default' ? 'text' : tone === 'accent' ? 'accent' : tone})` : undefined,
        }}
      >
        {value}
      </div>
    </div>
  );
}