import { useEffect, useState } from 'react';
import { files, toast, type TransferShape } from '../lib/bridge';
import { Button, Progress } from './ui';
import { formatBytes } from '@shared/format';

/**
 * Live transfer strip. Appears only when this computer has active or finished
 * transfers — the phone's own downloads are shown in the Downloads screen.
 */
export function TransfersPanel({ route, onNavigate }: { route: string; onNavigate: (r: string) => void }) {
  const [list, setList] = useState<TransferShape[]>([]);

  useEffect(() => {
    let alive = true;
    const load = () => {
      void files
        .list()
        .then((l) => alive && setList(l))
        .catch(() => undefined);
    };
    load();
    const off = files.onTransferEvent((s) => {
      const snap = s as TransferShape;
      setList((prev) => {
        const idx = prev.findIndex((t) => t.id === snap.id);
        if (idx === -1) return [...prev, snap];
        const next = [...prev];
        next[idx] = snap;
        return next;
      });
      if (snap.status === 'completed') {
        toast.success(`Saved ${snap.filename} (${formatBytes(snap.total)})`);
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const visible = list.filter((t) => t.status === 'downloading' || t.status === 'preparing' || t.status === 'paused');
  if (visible.length === 0 || route === 'settings') return null;

  return (
    <div style={{ padding: '8px 24px 0' }}>
      {visible.map((t) => (
        <div key={t.id} className="transfer-row" style={{ marginBottom: 8 }}>
          <div className="transfer-head">
            <span className="truncate" style={{ flex: 1, fontSize: 13 }}>
              {t.filename}
            </span>
            <span className="tiny faint numeric nowrap">
              {formatBytes(t.received)} / {formatBytes(t.total)}
              {t.speedBytesPerSec > 0 ? ` · ${formatBytes(t.speedBytesPerSec)}/s` : ''}
            </span>
            <span className="tiny numeric nowrap" style={{ width: 34, textAlign: 'right' }}>
              {t.percent}%
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (t.status === 'paused') void files.resume(t.id);
                else void files.cancel(t.id);
              }}
              aria-label={t.status === 'paused' ? `Resume ${t.filename}` : `Cancel transfer of ${t.filename}`}
            >
              {t.status === 'paused' ? 'Resume' : 'Cancel'}
            </Button>
          </div>
          <Progress value={t.percent} label={`Transfer ${t.percent}%`} />
          {route === 'library' && t.status === 'paused' ? (
            <span className="tiny faint">Partial file kept — resume continues from the exact byte.</span>
          ) : null}
        </div>
      ))}
      <button className="sr-only" onClick={() => onNavigate('downloads')}>
        Go to downloads
      </button>
    </div>
  );
}