/**
 * Reads the stable error code and safe details from a useFetchClient error.
 * The server answers `{ error: { status, message, details: { code, ... } } }`.
 *
 * @param {any} error - Error thrown by useFetchClient.
 * @returns {{status: number | null, code: string | null, details: object}} Parsed error.
 */
export function apiError(error) {
  const body = error?.response?.data?.error;
  const details = body?.details && typeof body.details === 'object' ? body.details : {};
  return {
    status: Number(body?.status || error?.status || error?.response?.status) || null,
    code: typeof details.code === 'string' ? details.code : null,
    details,
  };
}

/**
 * Message for an error code, in the admin language. Unknown codes fall back
 * to a generic text; server messages are never shown as they are English only.
 *
 * @param {(id: string, def: string, values?: object) => string} t - Translator.
 * @param {any} error - useFetchClient error.
 * @returns {string} Message.
 */
export function errorMessage(t, error) {
  const { code, details, status } = apiError(error);
  switch (code) {
    case 'INVALID_PHONE':
      return t('error.INVALID_PHONE', 'The phone number is not a valid mobile number.');
    case 'INVALID_REQUEST':
      return t('error.INVALID_REQUEST', 'Some input is invalid ({field}).', { field: details.field || '-' });
    case 'CONFIG_INVALID':
      return t('error.CONFIG_INVALID', 'The configuration is invalid ({field}).', { field: details.field || '-' });
    case 'UNKNOWN_TEMPLATE':
      return t('error.UNKNOWN_TEMPLATE', 'No active template with this key exists for the channel.');
    case 'TEMPLATE_NOT_APPROVED':
      return t('error.TEMPLATE_NOT_APPROVED', 'Meta has not approved this template yet.');
    case 'MISSING_VARIABLE':
      return t('error.MISSING_VARIABLE', 'A template variable is missing ({field}).', {
        field: details.variable || details.field || '-',
      });
    case 'INVALID_VARIABLE':
      return t('error.INVALID_VARIABLE', 'A template variable is invalid ({field}).', {
        field: details.variable || details.field || '-',
      });
    case 'NO_CONSENT':
      return t('error.NO_CONSENT', 'The contact has not given consent for this channel.');
    case 'SUPPRESSED':
      return t('error.SUPPRESSED', 'The contact is blocked for this channel.');
    case 'WINDOW_CLOSED':
      return t(
        'error.WINDOW_CLOSED',
        'Free text is only allowed within 24 hours of the last message from the contact. Use a template.'
      );
    case 'NO_ACCOUNT':
      return t('error.NO_ACCOUNT', 'No active account can send on this channel.');
    case 'NO_ROUTE':
      return t('error.NO_ROUTE', 'No channel in the routing chain can reach this contact.');
    case 'NOT_LINKED':
      return t('error.NOT_LINKED', 'The contact has not linked Telegram yet.');
    case 'DEADLINE_PASSED':
      return t('error.DEADLINE_PASSED', 'The deadline for this message has passed. It can only be discarded.');
    case 'RATE_LIMITED':
      return t('error.RATE_LIMITED', 'Too many requests. Try again in a minute.');
    case 'NOT_FOUND':
      return t('error.NOT_FOUND', 'This item no longer exists. The list was refreshed.');
    case 'STATE_CHANGED':
      return t('error.STATE_CHANGED', 'This item was changed meanwhile. The view was refreshed.');
    case 'CONFIRMATION_REQUIRED':
      return t('error.CONFIRMATION_REQUIRED', 'Confirm the risk of a duplicate message first.');
    case 'PAYLOAD_PURGED':
      return t('error.PAYLOAD_PURGED', 'The message content was already removed. It can only be discarded.');
    case 'LOOKUP_DISABLED':
      return t('error.LOOKUP_DISABLED', 'Number lookup is not set up. Choose a Twilio account in the settings.');
    case 'LOOKUP_BUDGET_EXCEEDED':
      return t('error.LOOKUP_BUDGET_EXCEEDED', 'The monthly lookup budget is used up.');
    case 'PROVIDER_ERROR':
      return t('error.PROVIDER_ERROR', 'The provider rejected the request ({reason}).', {
        reason: details.reason || '-',
      });
    case 'EMBEDDED_SIGNUP_DISABLED':
      return t('error.EMBEDDED_SIGNUP_DISABLED', 'Connecting with Meta is not set up on the server yet.');
    default:
      if (status === 403) return t('error.FORBIDDEN', 'You do not have permission for this action.');
      return t('error.GENERIC', 'Something went wrong. Try again.');
  }
}
