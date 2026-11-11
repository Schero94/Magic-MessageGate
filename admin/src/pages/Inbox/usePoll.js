import { useEffect, useRef } from 'react';

/**
 * Calls `callback` every `intervalMs` while the browser tab is visible, and
 * once more when the tab becomes visible again. Polling is for data the
 * screen shows only; it stops on unmount and while the tab is hidden.
 *
 * @param {() => void} callback - Refresh function; the latest one is always called.
 * @param {number} intervalMs - Interval in milliseconds.
 * @param {boolean} [enabled] - Poll only while true.
 * @returns {void}
 */
export function usePoll(callback, intervalMs, enabled = true) {
  const latest = useRef(callback);
  useEffect(() => {
    latest.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!enabled) return undefined;
    const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
    const timer = setInterval(() => {
      if (visible()) latest.current();
    }, intervalMs);
    const onVisibility = () => {
      if (visible()) latest.current();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [intervalMs, enabled]);
}
