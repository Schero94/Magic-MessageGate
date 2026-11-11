import { useCallback, useEffect, useState } from 'react';
import { useApi } from '../../hooks/useApi';
import { PLUGIN_ID } from '../../pluginId';
import { usePoll } from './usePoll';

const UNREAD_POLL_MS = 30_000;

/** Window event fired after a conversation loaded (the server marked its messages as read). */
export const INBOX_SEEN_EVENT = `${PLUGIN_ID}:inbox-seen`;

/**
 * Tells the unread badge to count again (after a conversation was opened).
 *
 * @returns {void}
 */
export function notifyInboxSeen() {
  window.dispatchEvent(new CustomEvent(INBOX_SEEN_EVENT));
}

/**
 * Number of inbound messages no admin has opened yet, for the Inbox tab
 * badge. Refreshes every 30 seconds while the browser tab is visible and
 * right after a conversation was opened (`notifyInboxSeen`).
 *
 * @param {boolean} enabled - Load only with the inbound read permission.
 * @returns {number | null} Unread count, null while unknown or on error.
 */
export function useInboxUnread(enabled) {
  const api = useApi();
  const [count, setCount] = useState(null);

  // State is only set in the promise callback, never synchronously in an effect.
  const load = useCallback(() => {
    if (!enabled) return;
    api.get('/inbound/unread').then(
      (data) => {
        const value = Number(data?.unread);
        setCount(Number.isFinite(value) && value >= 0 ? value : null);
      },
      // The badge is a hint only; the Inbox page reports load errors.
      () => setCount(null)
    );
  }, [api, enabled]);

  useEffect(() => {
    if (!enabled) return undefined;
    load();
    window.addEventListener(INBOX_SEEN_EVENT, load);
    return () => window.removeEventListener(INBOX_SEEN_EVENT, load);
  }, [load, enabled]);

  usePoll(load, UNREAD_POLL_MS, enabled);
  return enabled ? count : null;
}
