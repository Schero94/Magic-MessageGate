'use strict';

/**
 * Error contract of MessageGate.
 *
 * Services throw `MessageGateError` with a stable `code`; controllers turn it
 * into a Strapi HTTP error with the same code in `details.code`, so API
 * clients and AI agents can switch on the code instead of parsing text.
 */

/** @type {Record<string, {status: number, message: string}>} */
const CODES = Object.freeze({
  INVALID_PHONE: { status: 400, message: 'The phone number is not a valid mobile number' },
  INVALID_REQUEST: { status: 400, message: 'The request is invalid' },
  UNKNOWN_TEMPLATE: { status: 404, message: 'No active template with this key exists for the channel' },
  TEMPLATE_NOT_APPROVED: { status: 409, message: 'The template is not approved by the provider yet' },
  MISSING_VARIABLE: { status: 400, message: 'A template variable is missing' },
  INVALID_VARIABLE: { status: 400, message: 'A template variable is invalid' },
  NO_CONSENT: { status: 409, message: 'The contact has not given consent for this channel' },
  SUPPRESSED: { status: 409, message: 'The contact is suppressed for this channel' },
  WINDOW_CLOSED: { status: 409, message: 'Free text is only allowed within 24 hours of the last inbound message' },
  NO_ACCOUNT: { status: 409, message: 'No active account can send on this channel' },
  NO_ROUTE: { status: 409, message: 'No channel in the routing chain can reach this contact' },
  NOT_LINKED: { status: 409, message: 'The contact has not linked Telegram yet' },
  DEADLINE_PASSED: { status: 409, message: 'The deadline for this message has passed' },
  RATE_LIMITED: { status: 429, message: 'Too many requests, try again later' },
  NOT_FOUND: { status: 404, message: 'Not found' },
  STATE_CHANGED: { status: 409, message: 'The message was changed meanwhile' },
  CONFIRMATION_REQUIRED: { status: 409, message: 'Confirm the duplicate risk to retry an uncertain message' },
  PAYLOAD_PURGED: { status: 409, message: 'The message content was already removed' },
  LOOKUP_DISABLED: { status: 409, message: 'Number lookup is not configured' },
  LOOKUP_BUDGET_EXCEEDED: { status: 429, message: 'The monthly lookup budget is used up' },
  PROVIDER_ERROR: { status: 502, message: 'The provider rejected the request' },
  INVALID_SIGNATURE: { status: 401, message: 'Unauthorized' },
  CONFIG_INVALID: { status: 400, message: 'The configuration is invalid' },
});

class MessageGateError extends Error {
  /**
   * @param {keyof CODES|string} code
   * @param {string} [message]
   * @param {object} [details] - Safe, PII-free details (field names, limits).
   */
  constructor(code, message, details) {
    const known = CODES[code];
    super(message || (known ? known.message : code));
    this.name = 'MessageGateError';
    this.code = code;
    this.status = known ? known.status : 400;
    this.details = details || undefined;
  }
}

/**
 * @param {*} error
 * @returns {boolean}
 */
const isMessageGateError = (error) => Boolean(error && error.name === 'MessageGateError' && error.code);

module.exports = { CODES, MessageGateError, isMessageGateError };
