/**
 * Pure helpers for the contact views.
 */

/**
 * Latest activity of a contact (inbound message, delivery or read receipt).
 *
 * @param {{lastActivity?: {inboundAt?: number|null, deliveredAt?: number|null, readAt?: number|null}}} contact - DTO.
 * @returns {number | null} Epoch milliseconds.
 */
export function lastActivityAt(contact) {
  const a = contact?.lastActivity || {};
  const times = [a.inboundAt, a.deliveredAt, a.readAt].map(Number).filter((n) => Number.isFinite(n) && n > 0);
  return times.length ? Math.max(...times) : null;
}

/**
 * Whether a channel is usable for the contact: consent, suppression and
 * reachability combined into one state for the UI.
 *
 * @param {object} contact - Contact DTO.
 * @param {'whatsapp' | 'telegram' | 'sms'} channel - Channel.
 * @param {boolean} requireConsent - Settings flag.
 * @returns {'ok' | 'noConsent' | 'blocked' | 'unreachable' | 'notLinked'} State.
 */
export function channelState(contact, channel, requireConsent = true) {
  const now = Date.now();
  if ((contact.suppressions || []).some((s) => s.channel === channel && (!s.until || s.until > now))) return 'blocked';
  if (channel === 'whatsapp' && contact.whatsapp?.reachability === 'unreachable') return 'unreachable';
  if (channel === 'telegram' && !contact.telegramLinked) return 'notLinked';
  if (requireConsent && contact.consent?.[channel]?.status !== 'granted') return 'noConsent';
  return 'ok';
}

/**
 * File name for a GDPR export.
 *
 * @param {{id: string}} contact - DTO.
 * @param {number} [now] - Epoch milliseconds.
 * @returns {string} File name.
 */
export function exportFileName(contact, now = Date.now()) {
  return `messagegate-contact-${contact.id}-${new Date(now).toISOString().slice(0, 10)}.json`;
}
