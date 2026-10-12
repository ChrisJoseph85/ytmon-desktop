import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button } from './components/ui';
import { useConnection } from './state/connection';
import { ConnectionScreen } from './screens/ConnectionScreen';
import { LibraryScreen } from './screens/LibraryScreen';
import { DownloadsScreen } from './screens/DownloadsScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { ChannelsScreen } from './screens/ChannelsScreen';
import { SourcesScreen } from './screens/SourcesScreen';
import { LibraryBrowser } from './screens/LibraryBrowser';
import { FetchModal } from './components/FetchModal';
import { TransfersPanel } from './components/TransfersPanel';
import { Toasts } from './components/Toasts';

type Route = 'library' | 'browser' | 'downloads' | 'channels' | 'sources' | 'settings';

const NAV: { id: Route; label: string; icon: string }[] = [
  { id: 'library', label: 'Library', icon: '▦' },
  { id: 'browser', label: 'Files', icon: '🗂' },
  { id: 'downloads', label: 'Downloads', icon: '⇩' },
  { id: 'channels', label: 'Channels', icon: '☰' },
  { id: 'sources', label: 'Playlists', icon: '♫' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
];

export function App() {
  const { settings, health, healthMessage, ready, probed, bootError, loadSettings, checkHealth } = useConnection();
  const [route, setRoute] = useState<Route>('library');
  const [version, setVersion] = useState('');
  const [fetchOpen, setFetchOpen] = useState(false);

  useEffect(() => {
    void loadSettings();
    void window.ytmon?.app.version().then((r) => r.ok && setVersion(r.data));
  }, [loadSettings]);

  // Health banner polls every 5s while visible. Capped, never runaway.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === 'visible' && useConnection.getState().settings) {
        void useConnection.getState().checkHealth();
      }
    }, 5000);
    return () => clearInterval(id);
  }, []);

  // Theme
  useEffect(() => {
    const theme = settings?.theme ?? 'system';
    const dark =
      theme === 'dark' ||
      (theme === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches === false);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [settings?.theme]);

  const retry = useCallback(() => void checkHealth(), [checkHealth]);

  if (!window.ytmon) {
    return (
      <div className="onboard">
        <div className="onboard-card">
          <h1>Bridge unavailable</h1>
          <p className="muted" style={{ marginTop: 8 }}>
            The preload bridge did not load. Restart the app.
          </p>
        </div>
      </div>
    );
  }

  const healthBanner = () => {
    if (health === 'unreachable') {
      return (
        <div className="health-strip health-down" role="alert">
          <span className="badge-dot" aria-hidden />
          <strong>Server unreachable</strong>
          <span className="truncate">{healthMessage}</span>
          <span className="spacer" />
          <Button size="sm" onClick={retry}>
            Retry
          </Button>
        </div>
      );
    }
    if (health === 'unauthorized') {
      return (
        <div className="health-strip health-degraded" role="alert">
          <span className="badge-dot" aria-hidden />
          <strong>Token required</strong>
          <span className="truncate">{healthMessage}</span>
          <span className="spacer" />
          <Button size="sm" onClick={() => setRoute('settings')}>
            Open connection settings
          </Button>
        </div>
      );
    }
    if (health === 'degraded') {
      return (
        <div className="health-strip health-degraded" role="status">
          <span className="badge-dot" aria-hidden />
          <strong>Server degraded</strong>
          <span className="truncate">{healthMessage ?? 'The phone reports a problem with a worker.'}</span>
        </div>
      );
    }
    if (health === 'ok') {
      const info = useConnection.getState().serverInfo;
      const bind = info?.bind_mode;
      return (
        <div className="health-strip health-ok" role="status">
          <span className="badge-dot" aria-hidden />
          <strong>Connected</strong>
          <span className="mono truncate">{settings?.serverUrl}</span>
          {bind ? <span className="badge">{String(bind)}</span> : null}
          {info?.server_version ? <span className="faint">server {String(info.server_version)}</span> : null}
          {(() => {
            const h = useConnection.getState().healthDetail;
            if (!h?.workers) return null;
            const w = h.workers;
            return (
              <span className="row" style={{ gap: 6 }}>
                <Badge title="download worker" tone={w.download?.active ? 'accent' : 'default'}>
                  ⇩ {w.download?.active ?? 0}/{w.download?.concurrency ?? 0}
                </Badge>
                <Badge title="monitor worker" tone={w.monitor?.running ? 'success' : 'default'}>
                  ☰ {w.monitor?.running ? 'monitoring' : 'idle'}
                </Badge>
                <Badge title="sources worker" tone={w.sources?.running ? 'success' : 'default'}>
                  ♫ {w.sources?.running ? 'sources' : 'idle'}
                </Badge>
              </span>
            );
          })()}
        </div>
      );
    }
    return (
      <div className="health-strip" role="status">
        <span className="spinner" aria-hidden />
        <span className="muted">Checking server…</span>
      </div>
    );
  };

  if (bootError) {
    return (
      <div className="onboard">
        <div className="onboard-card stack">
          <h1>YTMon Desktop</h1>
          <Alert tone="danger">
            <div className="mono">{bootError}</div>
          </Alert>
          <Button variant="primary" onClick={() => void loadSettings()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  // Still starting up: a stored token is being decrypted and probed, so show a
  // splash rather than flashing the pairing screen on every launch.
  if (!probed) {
    return (
      <div className="onboard">
        <div className="onboard-card stack" style={{ alignItems: 'center', textAlign: 'center' }}>
          <div className="brand-mark" aria-hidden>YT</div>
          <div className="row muted" style={{ gap: 8 }} role="status" aria-live="polite">
            <span className="spinner" aria-hidden /> Connecting to {settings?.serverUrl ?? 'the server'}…
          </div>
        </div>
      </div>
    );
  }

  // First launch, unreachable, or unauthorized: show the connection flow.
  if (!ready || health === 'unauthorized') {
    return (
      <>
        <ConnectionScreen />
        <Toasts />
      </>
    );
  }

  const title = NAV.find((n) => n.id === route)?.label ?? 'Library';

  return (
    <div className="app-shell">
      <nav className="sidebar" aria-label="Primary">
        <div className="brand">
          <div className="brand-mark" aria-hidden>
            YT
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="brand-name">YTMon</div>
            <div className="brand-sub truncate" title={settings?.serverUrl}>
              {settings?.serverUrl?.replace(/^https?:\/\//, '') ?? 'not configured'}
            </div>
          </div>
        </div>

        <div className="nav" role="tablist">
          <div className="nav-label">Manage</div>
          {NAV.map((n) => (
            <button
              key={n.id}
              role="tab"
              className="nav-item"
              data-route={n.id}
              aria-current={route === n.id ? 'page' : undefined}
              aria-selected={route === n.id}
              onClick={() => setRoute(n.id)}
            >
              <span aria-hidden style={{ width: 16, textAlign: 'center' }}>
                {n.icon}
              </span>
              {n.label}
            </button>
          ))}
        </div>

        <div className="spacer" />
        <div className="stack" style={{ gap: 6 }}>
          <div className="tiny faint">Desktop client v{version || '—'}</div>
          <Button size="sm" variant="ghost" onClick={() => setRoute('settings')}>
            {!settings?.hasToken
              ? 'No token'
              : settings.tokenStorage === 'keychain'
                ? 'Token ✓ keychain'
                : settings.tokenStorage === 'encrypted-file'
                  ? 'Token ✓ encrypted'
                  : 'Token: this session'}
          </Button>
        </div>
      </nav>

      <div className="main">
        <header className="topbar">
          <h1>{title}</h1>
          <span className="spacer" />
          <Button size="sm" variant="primary" onClick={() => setFetchOpen(true)} title="Add a video or playlist by link">
            Fetch a link
          </Button>
        </header>
        {healthBanner()}
        <TransfersPanel route={route} onNavigate={(r) => setRoute(r as Route)} />
        <main className="content" id="main-content">
          {route === 'library' ? <LibraryScreen /> : null}
          {route === 'browser' ? <LibraryBrowser /> : null}
          {route === 'downloads' ? <DownloadsScreen /> : null}
          {route === 'channels' ? <ChannelsScreen /> : null}
          {route === 'sources' ? <SourcesScreen /> : null}
          {route === 'settings' ? <SettingsScreen /> : null}
        </main>
      </div>
      <FetchModal open={fetchOpen} onClose={() => setFetchOpen(false)} onDone={() => void useConnection.getState().checkHealth()} />
      <Toasts />
    </div>
  );
}