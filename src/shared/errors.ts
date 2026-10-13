/** The server's single error shape. Never parse error text — read this. */
export interface ServerErrorShape {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export class YtmonError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly details?: unknown;

  constructor(message: string, code = 'client_error', status?: number, details?: unknown) {
    super(message);
    this.name = 'YtmonError';
    this.code = code;
    if (status !== undefined) this.status = status;
    if (details !== undefined) this.details = details;
  }

  /**
   * 401 -> prompt for a token; 403 for /tokens is localhost-only.
   * The server distinguishes missing_token from invalid_token, so the UI can
   * say "paste one" vs "that one was rejected".
   */
  get isAuthError(): boolean {
    return (
      this.status === 401 ||
      this.code === 'unauthorized' ||
      this.code === 'http_401' ||
      this.code === 'missing_token' ||
      this.code === 'invalid_token'
    );
  }

  /** Actionable guidance for the codes clients are expected to handle. */
  get hint(): string | null {
    switch (this.code) {
      case 'missing_token':
        return 'Create a token on the phone: 127.0.0.1:8765/docs → POST /tokens.';
      case 'invalid_token':
        return 'That token was rejected. It may have been revoked — check DELETE /tokens on the phone.';
      case 'not_retryable':
        return 'This job is not in a retryable state.';
      case 'not_cancellable':
        return 'This job has already started downloading and cannot be cancelled.';
      case 'invalid_sub_langs':
        return 'Use a language filter such as "en.*" — "*" is rejected because it breaks every download.';
      case 'invalid_path':
        return 'The server refused that path. Files outside the media directory are never served.';
      case 'method_not_allowed':
        return 'That endpoint does not support this operation.';
      case 'channel_disabled':
        return 'Enable the channel first, then scan it.';
      case 'payload_too_large':
        return 'The request body was over 5 MB. Import fewer channels at once.';
      case 'origin_not_allowed':
        return (
          'The server refused the request because it carried an Origin header. All API calls must come from ' +
          'the main process, never the renderer — this is an anti-CSRF defence, not an outage.'
        );
      case 'invalid_download_dir':
        return 'That download directory was refused — the server rejects filesystem roots and parent directories.';
      case 'data_required':
        return 'Paste the contents of your Takeout subscriptions.json first — the takeout source reads the file from the paste, not from the phone.';
      case 'invalid_takeout':
        return 'That JSON is not a Takeout subscriptions list. Paste the whole contents of subscriptions.json (an array of objects with a contentDetails.channelId).';
      case 'import_failed':
        return 'The feed import failed — the YouTube cookies on the phone have most likely expired. Use Takeout instead; it needs nothing configured on the server.';
      case 'invalid_schedule_time':
        return 'Use a 24-hour time such as 08:30.';
      case 'invalid_schedule_days':
        return 'Pick weekdays from mon, tue, wed, thu, fri, sat, sun.';
      case 'invalid_mode':
        return 'A channel is either automatic or manual.';
      case 'cookies_not_configured':
        return 'The server has no cookie file configured. Set YTMON_COOKIES_FILE in its .env and restart it.';
      case 'no_youtube_cookies':
        return 'No youtube.com cookies were found in that export. Export again from a browser signed in to YouTube.';
      case 'not_a_cookie_file':
        return 'That does not look like a cookie export. Use the Netscape cookies.txt format.';
      case 'invalid_json':
        return 'That JSON could not be parsed.';
      default:
        return null;
    }
  }

  toJSON() {
    return { message: this.message, code: this.code, status: this.status, details: this.details };
  }
}

export function isYtmonError(e: unknown): e is YtmonError {
  return e instanceof YtmonError || (typeof e === 'object' && e !== null && 'code' in e && 'message' in e);
}

export function toYtmonError(e: unknown): YtmonError {
  if (e instanceof YtmonError) return e;
  if (e instanceof Error) {
    if (e.name === 'AbortError') return new YtmonError('Request cancelled', 'cancelled');
    if (e.name === 'TimeoutError') return new YtmonError('Server did not respond in time', 'timeout');
    return new YtmonError(e.message, 'network_error');
  }
  return new YtmonError(String(e), 'unknown_error');
}

/** Field errors from 422 details.errors[] mapped onto form fields. */
export function fieldErrors(details: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const root = details as { errors?: { loc?: (string | number)[]; msg?: string; field?: string }[] } | undefined;
  const list = Array.isArray(root?.errors) ? root.errors : [];
  for (const item of list) {
    const key = item.field ?? (Array.isArray(item.loc) ? item.loc.filter((p) => typeof p === 'string').join('.') : undefined);
    if (key && item.msg) out[key] = item.msg;
  }
  return out;
}