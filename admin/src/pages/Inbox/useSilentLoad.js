import { useCallback, useEffect, useRef } from 'react';
import { useLoad } from '../../hooks/useLoad';
import { usePoll } from './usePoll';

/**
 * `useLoad` plus a silent background refresh: polling replaces the data
 * without the loading flag (no spinner, the table and focus stay put) and
 * ignores failures, so the last good data stays visible. A response that
 * arrives after the inputs changed is dropped.
 *
 * @template T
 * @param {() => Promise<T>} loader - Stable loader (useCallback).
 * @param {number} intervalMs - Poll interval in milliseconds.
 * @returns {{ data: T | undefined, error: any, isLoading: boolean, reload: () => Promise<void>, refresh: () => Promise<void> }} State.
 */
export function useSilentLoad(loader, intervalMs) {
  const { data, error, isLoading, reload, setData } = useLoad(loader);
  const current = useRef(loader);
  useEffect(() => {
    current.current = loader;
  }, [loader]);

  const refresh = useCallback(async () => {
    const mine = loader;
    try {
      const value = await mine();
      if (current.current === mine) setData(value);
    } catch {
      // Background refresh: keep the last data; the next manual reload shows errors.
    }
  }, [loader, setData]);

  usePoll(refresh, intervalMs, !isLoading);
  return { data, error, isLoading, reload, refresh };
}
