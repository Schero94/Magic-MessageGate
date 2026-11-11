import { useCallback, useSyncExternalStore } from 'react';

/**
 * True while a media query matches. Pass a Design System breakpoint
 * (`theme.breakpoints.large`, a full `@media(min-width: …)` string) so the
 * layout switches exactly where the DS does; no custom widths.
 *
 * @param {string} query - Media query, with or without the leading `@media`.
 * @returns {boolean} Match state, `true` on the server.
 */
export function useMediaQuery(query) {
  const clean = query.replace('@media', '').trim();
  const subscribe = useCallback(
    (onChange) => {
      const list = window.matchMedia(clean);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [clean]
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(clean).matches,
    () => true
  );
}
