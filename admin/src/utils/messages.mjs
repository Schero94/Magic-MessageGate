/**
 * Pure rules for message actions; they mirror server/src/core/outbox.js so
 * the interface only offers actions the server accepts.
 */

/**
 * @param {{status: string, phase?: string, hasPayload?: boolean, notAfter?: number}} message - Message DTO.
 * @returns {{retry: boolean, discard: boolean, markSent: boolean, retryNeedsConfirm: boolean, retryBlockedBy: null | 'payload'}} Allowed actions.
 */
export function messageActions(message) {
  const retryable = ['failed', 'uncertain', 'expired'].includes(message.status);
  return {
    retry: retryable && message.hasPayload === true,
    retryBlockedBy: retryable && message.hasPayload !== true ? 'payload' : null,
    retryNeedsConfirm: message.status === 'uncertain',
    discard:
      ['failed', 'uncertain', 'expired'].includes(message.status) ||
      (message.status === 'queued' && message.phase === 'queued'),
    markSent: message.status === 'uncertain',
  };
}

/**
 * Progress steps of a message for the timeline header: sent, delivered, read.
 *
 * @param {{sentAt?: number | null, deliveredAt?: number | null, readAt?: number | null, status: string}} message - DTO.
 * @returns {Array<{key: 'sent' | 'delivered' | 'read', at: number | null, done: boolean}>} Steps.
 */
export function progressSteps(message) {
  return [
    { key: 'sent', at: message.sentAt ?? null },
    { key: 'delivered', at: message.deliveredAt ?? null },
    { key: 'read', at: message.readAt ?? null },
  ].map((step) => ({ ...step, done: Boolean(step.at) }));
}
