import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Field } from '../components/ui';
import { useConnection } from '../state/connection';
import { api, toast } from '../lib/bridge';
import { validateServerUrl } from '@shared/format';

type Step = 'url' | 'token' | 'done';

/**
 * The phone's LAN IP changes, so the address is always an editable setting.
 * Token minting is localhost-only on the server, so this screen NEVER tries to
 * mint one remotely — it only accepts a token the user made on the phone.
 */
export function ConnectionScreen() {
  const { settings, health, healthMessage, serverInfo, setServerUrl, setToken, switchToLoopback } = useConnection();
  const [url, setUrl] = useState(settings?.serverUrl ?? '');
  const [token, setTokenInput] = useState('');
  const [step, setStep] = useState<Step>(settings?.hasToken ? 'done' : 'url');
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState<string | null>(null);

  const configuredUrl = settings?.serverUrl;
  useEffect(() => {
    if (configuredUrl) setUrl(configuredUrl);
  }, [configuredUrl]);

  useEffect(() => {
    if (health === 'ok' || health === 'degraded') setStep('done');
  }, [health]);

  const validation = useMemo(() => validateServerUrl(url), [url]);

  const testAndContinue = async () => {
    if (!validation.ok || !validation.normalized) return;
    setBusy(true);
    setProbe(null);
    try {
      await setServerUrl(validation.normalized);
      // /health is public even in LAN mode; it tells us reachability before we
      // ask for a token.
      const h = await api.health();
      setProbe(`Reachable — server status "${h.status}".`);
      if (health === 'unauthorized' || (h as unknown as { status: string }).status === 'unauthorized') {
        setStep('token');
      } else {
        setStep(settings?.hasToken ? 'done' : 'token');
      }
    } catch (e) {
      const err = e as { message: string; status?: number };
      setProbe(
        err.status === 401
          ? 'Reachable, but the server wants a token (LAN mode is enabled).'
          : `Could not reach the server: ${err.message}`,
      );
    } finally {
      setBusy(false);
    }
  };

  const saveToken = async (persist: boolean) => {
    if (!token.trim()) {
      setStep('url');
      return;
    }
    setBusy(true);
    try {
      await setToken(token.trim(), persist);
      setTokenInput('');
      setStep('done');
      toast.success(
        persist ? 'Token stored in the OS keychain.' : 'Token kept for this session only — it is forgotten when the app quits.',
      );
    } catch (e) {
      setProbe((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await setToken(null);
      setStep('token');
      toast.info('Token removed from this computer.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="onboard">
      <div className="onboard-card stack" style={{ gap: 20 }}>
        <div className="brand">
          <div className="brand-mark" aria-hidden>
            YT
          </div>
          <div>
            <h1>Connect to your monitor</h1>
            <p className="muted" style={{ fontSize: 13 }}>
              The server runs on your Android phone under Termux. It is the source of truth for
              channels, videos, settings and downloads.
            </p>
          </div>
        </div>

        <div className="steps" aria-hidden>
          <div className={`step${step === 'url' ? ' active' : health === 'ok' ? ' done' : ''}`} />
          <div className={`step${step === 'token' ? ' active' : step === 'done' ? ' done' : ''}`} />
          <div className={`step${step === 'done' ? ' done' : ''}`} />
        </div>

        {health === 'unreachable' && probe === null ? (
          <Alert tone="danger">
            <strong>Server unreachable.</strong>
            <div style={{ marginTop: 4 }}>{healthMessage}</div>
            <ul className="tiny muted" style={{ margin: '8px 0 0', paddingLeft: 18, lineHeight: 1.7 }}>
              <li>Both devices must be on the same subnet — not a guest/isolated Wi-Fi network.</li>
              <li>The phone's IP changes when it joins a different network. Print it with ./scripts/lan-address.sh in Termux.</li>
              <li>The server binds 127.0.0.1 by default; LAN mode must be enabled on the phone or you get connection refused.</li>
              <li>The phone may be asleep — wake it, then retry.</li>
            </ul>
          </Alert>
        ) : null}

        <Field
          label="Server address"
          htmlFor="server-url"
          hint={
            validation.ok
              ? `Host ${validation.host} · port ${validation.port}${validation.isLoopback ? ' · loopback (trusted, no token needed)' : ' · LAN (token required)'}`
              : validation.reason
          }
          error={url && !validation.ok ? validation.reason : null}
        >
          <input
            id="server-url"
            className={`input input-mono${url && !validation.ok ? ' input-error' : ''}`}
            value={url}
            placeholder="http://192.168.1.100:8765"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setUrl(e.target.value);
              setProbe(null);
            }}
            onKeyDown={(e) => e.key === 'Enter' && validation.ok && void testAndContinue()}
          />
        </Field>

        <div className="row row-wrap">
          <Button variant="primary" loading={busy} disabled={!validation.ok} onClick={() => void testAndContinue()}>
            Test connection
          </Button>
          <Button
            onClick={() => {
              setUrl('http://127.0.0.1:8765');
              setProbe(null);
            }}
          >
            Use localhost:8765
          </Button>
          {settings?.serverUrl && settings.serverUrl !== 'http://127.0.0.1:8765' ? (
            <Button onClick={() => void switchToLoopback()}>Switch to this computer</Button>
          ) : null}
          <span className="spacer" />
          <span className="tiny faint nowrap">
            Docs: <span className="mono">{settings?.serverUrl ?? ''}/docs</span>
          </span>
        </div>

        {probe ? (
          <Alert tone={probe.startsWith('Reachable') ? 'success' : 'warn'}>{probe}</Alert>
        ) : null}

        {(step !== 'url' || health === 'unauthorized' || (validation.ok && validation.isLoopback === false)) ? (
          <>
            <div className="divider" style={{ margin: 0 }} />
            <Field
              label="Access token"
              htmlFor="token-input"
              hint={
                <span>
                  Paste a token you created <strong>on the phone</strong> at{' '}
                  <span className="mono">127.0.0.1:8765/docs → POST /tokens</span>. Token minting and
                  revocation are localhost-only by design, so this client cannot create one remotely.
                </span>
              }
            >
              <input
                id="token-input"
                className="input input-mono"
                type="password"
                value={token}
                placeholder="Paste token"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setTokenInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void saveToken(settings?.tokenKeychain !== false)}
              />
            </Field>
            {!settings?.tokenKeychain ? (
              <Alert tone="warn">
                <strong>No OS keychain on this system</strong> — gnome-keyring/kwallet is unavailable, so the
                token is never written to disk in plain text. You can still connect for this session; the token
                lives in memory and is forgotten when the app quits. Enable a desktop keyring to store it
                permanently.
              </Alert>
            ) : null}
            <div className="row row-wrap">
              {settings?.tokenKeychain ? (
                <Button variant="primary" loading={busy} disabled={!token.trim()} onClick={() => void saveToken(true)}>
                  Save token & connect
                </Button>
              ) : (
                <Button variant="primary" loading={busy} disabled={!token.trim()} onClick={() => void saveToken(false)}>
                  Use for this session
                </Button>
              )}
              {settings?.tokenSessionOnly ? (
                <Badge tone="warn">Session only — not stored on disk</Badge>
              ) : null}
              {settings?.hasToken ? (
                <Button variant="ghost" onClick={() => void disconnect()}>
                  Remove stored token
                </Button>
              ) : null}
            </div>
          </>
        ) : null}

        {serverInfo ? (
          <div className="divider" style={{ margin: 0 }} />
        ) : null}
        {serverInfo ? (
          <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 16px', margin: 0, fontSize: 12.5 }}>
            {Object.entries(serverInfo)
              .filter(([k]) => ['api_version', 'server_version', 'bind_mode', 'ffmpeg_path', 'platform'].includes(k))
              .map(([k, v]) => (
                <React.Fragment key={k}>
                  <dt className="muted">{k.replace(/_/g, ' ')}</dt>
                  <dd className="mono truncate" style={{ margin: 0 }}>
                    {String(v ?? '—')}
                  </dd>
                </React.Fragment>
              ))}
          </dl>
        ) : null}

        <div className="tiny faint" style={{ lineHeight: 1.7 }}>
          <strong>Network notes.</strong> Keep the server on the trusted local network only — never port-forward
          it to the public internet. Termux needs a battery-optimization exemption so the worker keeps running,
          and Termux:API/storage access for downloads. If the desktop cannot see the phone, check for AP/client
          isolation on the router.
        </div>
      </div>
    </div>
  );
}