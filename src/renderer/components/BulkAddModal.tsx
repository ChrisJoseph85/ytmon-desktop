import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Badge, Button, Field, Modal, Progress, Select, Switch } from './ui';
import { api, toast, type ChannelImportResult } from '../lib/bridge';
import { parseChannelList, toImportCsv, summarise, type ParsedEntry } from '../lib/channel-list';
import { pickCanonicalUrl, pickChannelId } from '../lib/channel-url';
import { qualityLabelsFrom } from '../lib/labels';

/**
 * Bulk channel add: paste a subscriptions list (or import a file), and the
 * client canonicalises every entry before sending it.
 *
 * This matters: the server stores whatever URL it is given, so an @handle would
 * become a channel row that never matches the canonical UC id carried by
 * discovered videos — scans then return {discovered: 0, filtered: N} forever.
 */
export function BulkAddModal({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [text, setText] = useState('');
  const [qualityOverride, setQualityOverride] = useState('');
  const [updateExisting, setUpdateExisting] = useState(true);
  const [options, setOptions] = useState<{ value: string; label: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'resolving' | 'sending'>('idle');
  const [progress, setProgress] = useState({ done: 0, total: 0, current: '' });
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ChannelImportResult | null>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    if (!open) return;
    setText('');
    setResult(null);
    setError(null);
    setPhase('idle');
    void api.qualityOptions().then((q) => setOptions(qualityLabelsFrom(q.options))).catch(() => undefined);
  }, [open]);

  const entries = useMemo(() => parseChannelList(text), [text]);
  const summary = useMemo(() => summarise(entries), [entries]);

  /** Resolve @handles to canonical /channel/UC… URLs, one at a time. */
  const canonicalise = async (list: ParsedEntry[]): Promise<ParsedEntry[]> => {
    const out: ParsedEntry[] = [];
    const pending = list.filter((e) => e.needsResolution);
    setProgress({ done: 0, total: pending.length, current: '' });
    for (const entry of list) {
      if (cancelled.current) break;
      if (!entry.needsResolution) {
        out.push(entry);
        continue;
      }
      setProgress((p) => ({ ...p, current: entry.raw }));
      try {
        const resolved = await api.resolveChannel(entry.canonicalUrl);
        const canonical = pickCanonicalUrl(resolved.url);
        out.push({
          canonicalUrl: canonical ?? entry.canonicalUrl,
          raw: entry.raw,
          channelId: canonical ? pickChannelId(canonical) : null,
          needsResolution: false,
        });
      } catch {
        // Keep the original so the server can report it; it will be skipped.
        out.push(entry);
      }
      setProgress((p) => ({ ...p, done: p.done + 1 }));
    }
    return out;
  };

  const submit = async () => {
    if (entries.length === 0) return;
    setBusy(true);
    setError(null);
    setResult(null);
    cancelled.current = false;
    try {
      setPhase('resolving');
      const prepared = await canonicalise(entries);
      setPhase('sending');
      const res = await api.importChannels(toImportCsv(prepared, qualityOverride || null), 'csv', updateExisting);
      setResult(res);
      toast.success(`Imported ${res.imported}, updated ${res.updated}, skipped ${res.skipped}.`);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setPhase('idle');
    }
  };

  const importFile = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.importChannelsFromFile(updateExisting);
      if (r.cancelled) return;
      setResult(r.result ?? null);
      toast.success(`File imported: ${r.result?.imported ?? 0} new, ${r.result?.updated ?? 0} updated.`);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const exportList = async () => {
    try {
      const r = await api.exportChannels('csv');
      if (r.cancelled) return;
      toast.success(`Exported ${r.bytes ?? 0} bytes to ${r.path}.`);
    } catch (e) {
      toast.fromError(e);
    }
  };

  return (
    <Modal
      open={open}
      wide
      title="Add channels in bulk"
      onClose={() => {
        cancelled.current = true;
        onClose();
      }}
      footer={
        <>
          <Button onClick={exportList} title="Save your current channel list to this computer">
            Export current list
          </Button>
          <Button onClick={() => void importFile()} disabled={busy}>
            Import a file…
          </Button>
          <span className="spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={entries.length === 0} onClick={() => void submit()}>
            Add {entries.length || ''} channel{entries.length === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Alert tone="info">
          Paste any list: channel URLs, <span className="mono">@handles</span>, bare{' '}
          <span className="mono">UC…</span> ids, or rows from a CSV/JSON export (for example a Google Takeout
          subscriptions list). Handles are resolved to their canonical channel URL before anything is sent, so
          every channel actually gets discovered videos.
        </Alert>

        <Field
          label="Channel list"
          htmlFor="bulk-channels"
          hint="One per line. Anything else on the line is ignored."
        >
          <textarea
            id="bulk-channels"
            className="input"
            rows={8}
            spellCheck={false}
            placeholder={
              'https://www.youtube.com/channel/UCXXXXXXXXXXXXXXXXXXXXXX\nhttps://www.youtube.com/@somechannel\n@another'
            }
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </Field>

        {entries.length > 0 ? (
          <div className="row row-wrap" style={{ gap: 8 }}>
            <Badge tone="info">{summary.total} found</Badge>
            {summary.needResolving > 0 ? (
              <Badge tone="warn">{summary.needResolving} need resolving (@handles)</Badge>
            ) : null}
            {summary.duplicates > 0 ? <Badge>{summary.duplicates} duplicate entries ignored</Badge> : null}
          </div>
        ) : null}

        {phase === 'resolving' && progress.total > 0 ? (
          <div className="stack" style={{ gap: 6 }}>
            <div className="row tiny muted">
              <span>Resolving handles…</span>
              <span className="spacer" />
              <span className="numeric">
                {progress.done}/{progress.total}
              </span>
            </div>
            <Progress value={(progress.done / Math.max(1, progress.total)) * 100} tone="info" label="Resolving" />
            <div className="tiny faint truncate">{progress.current}</div>
          </div>
        ) : null}

        <div className="grid-2">
          <Select
            label="Quality override for these channels"
            value={qualityOverride}
            onChange={setQualityOverride}
            hint="Optional. Overrides the global default for every channel added here. Stored on the phone."
            options={[
              { value: '', label: 'Use global default' },
              ...options.map((o) => ({ value: o.value, label: o.label })),
            ]}
          />
          <div className="toggle-row">
            <Switch label="Update channels that already exist" checked={updateExisting} onChange={setUpdateExisting} />
            <div>
              <strong>Update existing channels</strong>
              <div className="hint">Only applies to file imports; pasted lists are added as new.</div>
            </div>
          </div>
        </div>

        {error ? <Alert tone="danger">{error}</Alert> : null}

        {result ? (
          <div className="card" style={{ padding: 14, background: 'var(--surface-2)' }}>
            <div className="tiny faint" style={{ marginBottom: 6 }}>
              Last import
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
              {result.errors.length > 0 ? (
                <span style={{ color: 'var(--danger)' }}>
                  <strong>{result.errors.length}</strong> errors
                </span>
              ) : null}
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