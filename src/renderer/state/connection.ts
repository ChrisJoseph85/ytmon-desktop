import { create } from 'zustand';
import { api, settingsApi, type HealthStatus, type PublicSettings } from '../lib/bridge';

export type Health = 'unknown' | 'checking' | 'ok' | 'degraded' | 'unreachable' | 'unauthorized';

interface ConnectionState {
  settings: PublicSettings | null;
  health: Health;
  healthMessage: string | null;
  serverInfo: Record<string, unknown> | null;
  /** Full /health payload, used for the worker badges in the banner. */
  healthDetail: HealthStatus | null;
  /** True once we have confirmed at least one successful health probe. */
  ready: boolean;
  /** True once the FIRST probe has finished either way — before this we are
   *  still starting up and must not show the pairing screen, or it flashes on
   *  every launch even when a token is already stored. */
  probed: boolean;
  bootError: string | null;
  checkHealth(signal?: AbortSignal): Promise<void>;
  loadSettings(): Promise<void>;
  setServerUrl(url: string): Promise<void>;
  setToken(token: string | null, persist?: boolean): Promise<void>;
  setPreferences(prefs: Record<string, unknown>): Promise<void>;
  switchToLoopback(): Promise<void>;
}

export const useConnection = create<ConnectionState>((set, get) => ({
  settings: null,
  health: 'unknown',
  healthMessage: null,
  serverInfo: null,
  healthDetail: null,
  ready: false,
  probed: false,
  bootError: null,

  async loadSettings() {
    try {
      const s = await settingsApi.get();
      set({ settings: s });
      await get().checkHealth();
    } catch (e) {
      set({ bootError: (e as Error).message });
    }
  },

  async checkHealth(signal) {
    set({ health: 'checking' });
    try {
      const h = await api.health();
      const status = String(h?.status ?? 'unknown');
      if (status === 'ok' || status === 'degraded') {
        set({ healthDetail: h });
        // /health and /server/info are PUBLIC even in LAN mode, so a healthy
        // probe proves reachability but not authorisation. Probe a protected
        // endpoint too, otherwise the app shows "Connected" with an empty
        // library and 401s on everything else.
        try {
          await api.qualityOptions();
        } catch (e) {
          const err = e as { status?: number; code?: string; message: string };
          if (err.status === 401 || ['unauthorized', 'http_401', 'missing_token', 'invalid_token'].includes(err.code ?? '')) {
            set({
              health: 'unauthorized',
              healthMessage:
                err.code === 'invalid_token'
                  ? 'The stored token was rejected — it may have been revoked on the phone.'
                  : `Reachable, but this server requires a token (LAN mode is on).`,
              ready: false,
              probed: true,
            });
            return;
          }
          // A non-auth failure here is not fatal; fall through to connected.
        }
        set({ health: status, healthMessage: null, ready: true, probed: true, bootError: null });
        void api
          .serverInfo()
          .then((info: Record<string, unknown>) => set({ serverInfo: info }))
          .catch(() => undefined);
      } else {
        set({ health: 'degraded', healthMessage: `Server reports "${status}"`, ready: true });
      }
    } catch (e) {
      const err = e as { status?: number; code?: string; message: string };
      if (signal?.aborted) return;
      // The server now returns missing_token / invalid_token instead of a bare
      // FastAPI {"detail": ...}, so we can say something useful.
      if (err.status === 401 || ['unauthorized', 'http_401', 'missing_token', 'invalid_token'].includes(err.code ?? '')) {
        const message =
          err.code === 'invalid_token'
            ? 'The stored token was rejected — it may have been revoked on the phone.'
            : 'This server requires a token (LAN mode is on).';
        set({ health: 'unauthorized', healthMessage: message, ready: false });
        return;
      }
      set({
        health: 'unreachable',
        healthMessage: err.message,
        ready: false,
        probed: true,
      });
    }
  },

  async setServerUrl(url) {
    const s = await settingsApi.setServerUrl(url);
    set({ settings: s, ready: false, health: 'unknown' });
    await get().checkHealth();
  },

  async setToken(token, persist = true) {
    const s = await settingsApi.setToken(token, persist);
    set({ settings: s, ready: false });
    await get().checkHealth();
  },

  async setPreferences(prefs) {
    const s = await settingsApi.setPreferences(prefs);
    set({ settings: s });
  },

  async switchToLoopback() {
    const s = await settingsApi.useLoopback();
    set({ settings: s, ready: false, health: 'unknown' });
    await get().checkHealth();
  },
}));