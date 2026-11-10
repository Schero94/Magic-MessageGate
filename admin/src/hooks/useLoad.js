import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Loads data with a stable loader and exposes loading, error and reload.
 * Earlier responses never overwrite later ones; data stays visible while a
 * reload runs so lists do not flash.
 *
 * @template T
 * @param {() => Promise<T>} loader - Loader; recreate it (useCallback) when its inputs change.
 * @param {{ enabled?: boolean }} [options] - Skip loading while false.
 * @returns {{ data: T | undefined, error: any, isLoading: boolean, reload: () => Promise<void>, setData: (value: T) => void }} State.
 */
export function useLoad(loader, { enabled = true } = {}) {
  const [data, setData] = useState(undefined);
  const [error, setError] = useState(null);
  const [isLoading, setLoading] = useState(enabled);
  const seq = useRef(0);

  // State is only set after the loader resolved, never synchronously in the effect.
  const run = useCallback(
    async (mine) => {
      try {
        const value = await loader();
        if (mine !== seq.current) return;
        setData(value);
        setError(null);
      } catch (err) {
        if (mine !== seq.current || err?.name === 'AbortError') return;
        setError(err);
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [loader]
  );

  const reload = useCallback(() => {
    const mine = ++seq.current;
    setLoading(true);
    return run(mine);
  }, [run]);

  useEffect(() => {
    if (!enabled) return undefined;
    run(++seq.current);
    return () => {
      seq.current += 1;
    };
  }, [run, enabled]);

  return { data, error, isLoading, reload, setData };
}
