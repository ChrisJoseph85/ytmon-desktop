import React from 'react';

interface State {
  error: Error | null;
}

/** Catches render crashes so a bad payload never shows a blank window. */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Best-effort report to the server's log endpoint; never throws.
    try {
      void window.ytmon?.api.reportError?.('ERROR', `renderer: ${error.message} @ ${info.componentStack?.slice(0, 400)}`);
    } catch {
      /* ignore */
    }
    console.error(error, info);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="onboard">
        <div className="onboard-card stack">
          <h1>Something went wrong</h1>
          <div className="alert alert-danger" role="alert">
            <span className="alert-icon" aria-hidden>
              ⚠
            </span>
            <div>
              <div className="mono">{this.state.error.message}</div>
              <p className="hint" style={{ marginTop: 8 }}>
                Your library and settings on the server are untouched. Reload to continue.
              </p>
            </div>
          </div>
          <div className="row">
            <button className="btn btn-primary" onClick={() => window.location.reload()}>
              Reload window
            </button>
            <button className="btn" onClick={() => (window.location.href = 'https://www.youtube.com')}>
              Open YouTube
            </button>
          </div>
        </div>
      </div>
    );
  }
}