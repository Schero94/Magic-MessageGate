/**
 * Plain-language explanation of a delivery reason code (provider or
 * MessageGate). Unknown codes return null; the raw code is always shown too.
 *
 * @param {(id: string, def: string) => string} t - Translator.
 * @param {string | null} code - Reason code such as META_131026.
 * @returns {string | null} Explanation.
 */
export function reasonText(t, code) {
  if (!code) return null;
  switch (code) {
    case 'META_131026':
      return t('reason.META_131026', 'The number cannot receive WhatsApp messages (not on WhatsApp or an old app).');
    case 'META_131047':
      return t(
        'reason.META_131047',
        'More than 24 hours since the last message from the contact. Only templates can be sent.'
      );
    case 'META_131049':
      return t('reason.META_131049', 'Meta held back this marketing message to protect the user experience.');
    case 'META_131050':
      return t('reason.META_131050', 'The contact stopped marketing messages from this business.');
    case 'META_131056':
      return t('reason.META_131056', 'Too many messages to this contact in a short time.');
    case 'META_130429':
      return t('reason.META_130429', 'The WhatsApp throughput limit was reached. MessageGate retries later.');
    case 'META_132001':
      return t('reason.META_132001', 'The template does not exist in this language or is not approved.');
    case 'META_190':
      return t('reason.META_190', 'The Meta access token expired or was revoked. Reconnect the account.');
    case 'TG_403':
      return t('reason.TG_403', 'The contact blocked the bot or never started it.');
    case 'TG_429':
      return t('reason.TG_429', 'Telegram rate limit reached. MessageGate retries later.');
    case 'SEVEN_AUTH':
      return t('reason.SEVEN_AUTH', 'seven.io rejected the API key.');
    case 'TWILIO_21610':
      return t('reason.TWILIO_21610', 'The recipient replied STOP and unsubscribed.');
    case 'TWILIO_21211':
      return t('reason.TWILIO_21211', 'Twilio considers the number invalid.');
    case 'TWILIO_30003':
      return t('reason.TWILIO_30003', 'The phone is switched off or unreachable.');
    case 'TWILIO_30005':
      return t('reason.TWILIO_30005', 'The number is unknown or no longer exists.');
    case 'TWILIO_30007':
      return t('reason.TWILIO_30007', 'The carrier filtered the message as spam.');
    case 'TIMEOUT':
    case 'FETCH_ERROR':
    case 'AMBIGUOUS':
    case 'LEASE_EXPIRED_DURING_SEND':
      return t('reason.AMBIGUOUS', 'The provider did not answer in time. The message may or may not have been sent.');
    case 'RETRIES_EXHAUSTED':
      return t('reason.RETRIES_EXHAUSTED', 'Every retry failed.');
    case 'PAYLOAD_UNREADABLE':
      return t('reason.PAYLOAD_UNREADABLE', 'The stored content could not be decrypted (encryption key changed).');
    case 'NO_ACCOUNT':
      return t('error.NO_ACCOUNT', 'No active account can send on this channel.');
    case 'NO_CONSENT':
      return t('error.NO_CONSENT', 'The contact has not given consent for this channel.');
    case 'SUPPRESSED':
      return t('error.SUPPRESSED', 'The contact is blocked for this channel.');
    case 'NOT_LINKED':
      return t('error.NOT_LINKED', 'The contact has not linked Telegram yet.');
    case 'WINDOW_CLOSED':
      return t(
        'error.WINDOW_CLOSED',
        'Free text is only allowed within 24 hours of the last message from the contact. Use a template.'
      );
    case 'TEMPLATE_NOT_APPROVED':
      return t('error.TEMPLATE_NOT_APPROVED', 'Meta has not approved this template yet.');
    case 'EMAIL_FAILED':
      return t('reason.EMAIL_FAILED', 'The email fallback through Magic Mail failed.');
    default:
      return null;
  }
}
