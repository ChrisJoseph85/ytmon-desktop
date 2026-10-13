import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Field, Modal } from './ui';
import { api, toast, type CookiesInfo } from '../lib/bridge';
import { formatBytes } from '@shared/format';

/**
 * Cookie paste sheet. The export is normally made on a desktop and copying a
 * file to a phone is painful, so paste the text and PUT it.
 */
export function CookiesCard() {
  const [info, setInfo] = useState<CookiesInfo | null>(null);
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => void api.cookiesInfo().then(setInfo).catch(() => undefined);

  useEffect(() => {
    load();
  }, []);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.putCookies(text);
      setInfo(r);
      setText('');
      setOpen(false);
      toast.success(
        r.dropped_non_youtube
          ? `Saved ${r.cookie_count} YouTube cookies; ${r.dropped_non_youtube} non-YouTube cookies were dropped.`
          : `Saved ${r.cookie_count} cookies.`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="card-title">
        <h2>YouTube cookies</h2>
        <span className="spacer" />
        <Button size="sm" onClick={() => setOpen(true)}>
          Paste cookies
        </Button>
      </div>
      <p className="card-desc">
        Cookies are only used to <strong>read</strong> Watch Later and the subscription feed. They are deliberately
        not sent for ordinary downloads — doing that makes YouTube reject every extraction.
      </p>
      {info?.configured === false ? (
        <Alert tone="warn">
          The server is not set up for cookies. Set <span className="mono">YTMON_COOKIES_FILE</span> in its .env and
          restart it, then paste here.
        </Alert>
      ) : info ? (
        <div className="row row-wrap" style={{ gap: 10 }}>
          <Badge tone={info.exists ? 'success' : 'default'}>
            {info.exists ? `${info.cookie_count} cookies stored` : 'No cookies stored'}
          </Badge>
          {info.size_bytes ? <Badge>{formatBytes(info.size_bytes)}</Badge> : null}
          {info.dropped_non_youtube ? (
            <Badge tone="warn" title="Uploads are filtered to youtube.com / googlevideo.com cookies. Everything else is discarded.">
              {info.dropped_non_youtube} non-YouTube cookies dropped
            </Badge>
          ) : null}
          {info.exists ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void api
                  .deleteCookies()
                  .then((r) => {
                    setInfo(r);
                    toast.success('Cookies deleted on the phone.');
                  })
                  .catch((e: Error) => toast.fromError(e))
              }
            >
              Delete
            </Button>
          ) : null}
        </div>
      ) : null}

      <Modal
        open={open}
        title="Paste YouTube cookies"
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!text.trim()} onClick={() => void submit()}>
              Save
            </Button>
          </>
        }
      >
        <div className="stack">
          <Alert tone="info">
            Export cookies from a browser signed in to YouTube, then paste the text here. Only youtube.com and
            googlevideo.com cookies are kept — a browser-wide export is mostly discarded, and the count of dropped
            cookies is reported back so it is not a surprise.
          </Alert>
          <Field label="Cookie export" htmlFor="cookie-paste" hint="The Netscape cookies.txt format, as text." error={error}>
            <textarea
              id="cookie-paste"
              className="input input-mono"
              rows={10}
              spellCheck={false}
              data-autofocus
              placeholder="# Netscape HTTP Cookie File&#10;.youtube.com	TRUE	/	FALSE	0	ID	VALUE"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </Field>
        </div>
      </Modal>
    </Card>
  );
}
