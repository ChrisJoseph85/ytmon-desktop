import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Field, Modal, Select } from './ui';
import { api, toast, type SubscriptionImportResult, type SubscriptionSource, type SubscriptionsStatus } from '../lib/bridge';
import { formatDateTime } from '@shared/format';

/**
 * Import your YouTube subscriptions.
 *
 * Takeout is the DEFAULT because it needs nothing configured on the phone: the
 * server just parses the pasted subscriptions.json. The feed source reads
 * YouTube with the cookies held on the phone, which expire — so we check
 * GET /subscriptions/status first and explain that, rather than letting the
 * user hit a raw 400 import_failed.
 *
 * Imported channels arrive as mode="manual". That is deliberate — pasting 300
 * subscriptions must not start 300 downloads — and this client never flips
 * them to auto on import.
 */
export function ImportSubscriptionsModal({
  open,
  status,
  onClose,
  onDone,
}: {
  open: boolean;
  status: SubscriptionsStatus | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [source, setSource] = useState<SubscriptionSource>('takeout');
  const [data, setData] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SubscriptionImportResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setSource('takeout');
    setData('');
    setError(null);
    setResult(null);
  }, [open]);

  const cookies = status?.cookies_configured === true;

  const submit = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.importSubscriptions(source === 'takeout' ? { source: 'takeout', data } : { source: 'feed' });
      setResult(res);
      toast.success(`Imported ${res.imported} channel${res.imported === 1 ? '' : 's'} from ${res.source}.`);
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
      title="Import your subscriptions"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={source === 'takeout' && data.trim().length === 0}
            onClick={() => void submit()}
          >
            Import
          </Button>
        </>
      }
    >
      <div className="stack">
        <Select
          label="Source"
          value={source}
          onChange={(v) => setSource(v as SubscriptionSource)}
          options={[
            { value: 'takeout', label: 'Google Takeout (paste subscriptions.json) — recommended' },
            { value: 'feed', label: 'Your YouTube account (server cookies)', disabled: !cookies },
          ]}
          hint="Takeout works on any server. The feed needs YouTube cookies configured on the phone."
        />

        {source === 'takeout' ? (
          <Field
            label="subscriptions.json"
            htmlFor="import-takeout"
            hint="Open takeout.google.com → YouTube and history → subscriptions.json, then paste the whole file here."
          >
            <textarea
              id="import-takeout"
              className="input input-mono"
              rows={10}
              spellCheck={false}
              data-autofocus
              placeholder='[{"contentDetails":{"channelId":"UC…","channelName":"…"}}, …]'
              value={data}
              onChange={(e) => setData(e.target.value)}
            />
          </Field>
        ) : cookies ? (
          <Alert tone="info">
            The server will read your subscriptions using the YouTube cookies already configured on the phone. Those
            cookies expire — when that happens the import fails and Takeout is the way in.
          </Alert>
        ) : (
          <Alert tone="warn">
            The server has no YouTube cookies, so it cannot read your subscription feed. Takeout above still works.
          </Alert>
        )}

        {/* Said up front, whatever the source, rather than as a raw 400 after
            the user commits to the feed import. */}
        {!cookies ? (
          <Alert tone="warn">
            This server has no YouTube cookies, so the feed option cannot work: it would fail with{' '}
            <span className="mono">import_failed</span>. Set <span className="mono">YTMON_COOKIES_FILE</span> on the
            phone and restart the server to enable it. Takeout needs nothing configured and always works.
          </Alert>
        ) : null}

        {source === 'takeout' && cookies ? (
          <Alert tone="info">
            Takeout is the default because it needs nothing configured on the phone. The server also keeps a snapshot
            of every import, so your channel list survives the cookies expiring.
          </Alert>
        ) : null}

        {error ? <Alert tone="danger">{error}</Alert> : null}

        {result ? (
          <div className="card" style={{ padding: 14, background: 'var(--surface-2)' }}>
            <div className="tiny faint" style={{ marginBottom: 6 }}>
              Import from {result.source}
            </div>
            <div className="row row-wrap" style={{ gap: '6px 18px' }}>
              <span>
                <strong>{result.imported}</strong> added
              </span>
              <span>
                <strong>{result.updated}</strong> updated
              </span>
              <span>
                <strong>{result.skipped}</strong> skipped
              </span>
              <span>
                <strong>{result.total}</strong> total
              </span>
            </div>
            <div className="tiny faint" style={{ marginTop: 8 }}>
              Imported channels are <strong>manual</strong>: their uploads are still discovered and show up in the
              library, but nothing downloads until you ask for it.
            </div>
            {result.errors.length > 0 ? (
              <ul className="tiny" style={{ color: 'var(--danger)', margin: '8px 0 0', paddingLeft: 18 }}>
                {result.errors.slice(0, 8).map((e: string, i: number) => (
                  <li key={i} className="truncate" title={e}>
                    {e}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

/**
 * "Last imported <time> from takeout" — only rendered from what the server
 * actually reports, so a server without the field simply shows nothing.
 */
export function LastImportLine({ status }: { status: SubscriptionsStatus | null }) {
  if (!status?.last_import_at) return null;
  const from = status.last_import_source ? String(status.last_import_source) : 'takeout';
  return (
    <span className="tiny faint">
      Last imported {formatDateTime(status.last_import_at)} from {from}
    </span>
  );
}

export function CookiesBadge({ status }: { status: SubscriptionsStatus | null }) {
  if (!status) return null;
  return status.cookies_configured ? (
    <Badge tone="success">Feed import ready</Badge>
  ) : (
    <Badge tone="default" title="The server has no YouTube cookies — feed import is unavailable, Takeout always works.">
      Takeout only
    </Badge>
  );
}