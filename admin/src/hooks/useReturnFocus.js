import { useCallback, useRef } from 'react';

/**
 * Remembers the element that opened a dialog and focuses it again after
 * the dialog closes. Needed for dialogs opened from state (no DS Trigger),
 * where Radix has no trigger to return focus to.
 *
 * @returns {{ remember: () => void, restore: () => void }} Helpers.
 */
export function useReturnFocus() {
  const last = useRef(null);
  const remember = useCallback(() => {
    last.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, []);
  const restore = useCallback(() => {
    const el = last.current;
    setTimeout(() => {
      if (el?.isConnected) el.focus();
    }, 0);
  }, []);
  return { remember, restore };
}
