import { useCallback } from 'react';
import { useNotification } from '@strapi/strapi/admin';
import { errorMessage } from '../utils/apiError';
import { useT } from './useT';

/**
 * Runs an admin action with a success and an error notification. The error
 * is re-thrown so ConfirmAction keeps its dialog open.
 *
 * @returns {(fn: () => Promise<any>, success?: string) => Promise<any>} Runner.
 */
export function useAction() {
  const t = useT();
  const { toggleNotification } = useNotification();
  return useCallback(
    async (fn, success) => {
      try {
        const result = await fn();
        if (success) toggleNotification({ type: 'success', message: success });
        return result;
      } catch (error) {
        toggleNotification({ type: 'danger', message: errorMessage(t, error) });
        throw error;
      }
    },
    [t, toggleNotification]
  );
}
