import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Pull-based polling that always cleans up on unmount and cancels in-flight
 * requests when the screen goes away. Never leaves a 1s interval running.
 */
export function usePolling<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  intervalMs: number | null,
  deps: unknown[] = [],
): {
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
  setData: (updater: T | ((prev: T | null) => T)) => void;
} {
  const [data, setDataState] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;

    void (async () => {
      try {
        const result = await fnRef.current(controller.signal);
        if (cancelled || !mountedRef.current) return;
        setDataState(result);
        setError(null);
      } catch (e) {
        if (cancelled || !mountedRef.current) return;
        const err = e as { name?: string; message?: string };
        if (err.name === 'AbortError') return;
        setError(err.message ?? 'Request failed');
      } finally {
        if (!cancelled && mountedRef.current) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, intervalMs, ...deps]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // Separate interval effect so it doesn't restart the request effect.
  useEffect(() => {
    if (!intervalMs || intervalMs <= 0) return;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') setTick((t) => t + 1);
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  const setData = useCallback((updater: T | ((prev: T | null) => T)) => {
    setDataState((prev) => (typeof updater === 'function' ? (updater as (p: T | null) => T)(prev) : updater));
  }, []);

  return { data, error, loading, refresh, setData };
}

/** Interval that only runs while `active` is true. */
export function useFastPoll(fn: () => void, active: boolean, intervalMs = 1500): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') ref.current();
    }, intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
}

/** Tracks an async action's in-flight state so buttons can disable themselves. */
export function useAsyncAction<Args extends unknown[], R>(
  fn: (...args: Args) => Promise<R>,
): [(...args: Args) => Promise<R | undefined>, boolean] {
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    async (...args: Args): Promise<R | undefined> => {
      setBusy(true);
      try {
        return await fn(...args);
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  return [run, busy];
}

export function useKeyboard(keys: Record<string, (e: KeyboardEvent) => void>, enabled = true): void {
  const ref = useRef(keys);
  ref.current = keys;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const parts = [];
      if (e.ctrlKey || e.metaKey) parts.push('mod');
      if (e.shiftKey) parts.push('shift');
      parts.push(e.key);
      const handler = ref.current[parts.join('+')] ?? ref.current[e.key];
      handler?.(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}