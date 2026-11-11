'use strict';

/**
 * Phone number parsing with libphonenumber-js ("max" metadata, so the number
 * type can be determined).
 *
 * @see https://gitlab.com/catamphetamine/libphonenumber-js#readme
 */
const { parsePhoneNumberFromString } = require('libphonenumber-js/max');

/** Number types that can receive WhatsApp and SMS messages. */
const MESSAGING_TYPES = new Set(['MOBILE', 'FIXED_LINE_OR_MOBILE']);

/**
 * Parses and normalises a phone number.
 *
 * @param {string} input - Any notation; `+49 176 …`, `0176 …` (with default country), `0049…`.
 * @param {string} [defaultCountry] - ISO 3166-1 alpha-2, e.g. `DE`.
 * @returns {{valid: boolean, e164: string|null, country: string|null, type: string|null, mobile: boolean}}
 */
function parsePhone(input, defaultCountry = 'DE') {
  if (typeof input !== 'string' || input.length > 40) {
    return { valid: false, e164: null, country: null, type: null, mobile: false };
  }
  const cleaned = input.trim().replace(/^00/, '+');
  let parsed;
  try {
    parsed = parsePhoneNumberFromString(cleaned, defaultCountry);
  } catch {
    parsed = undefined;
  }
  if (!parsed || !parsed.isValid()) {
    return { valid: false, e164: null, country: null, type: null, mobile: false };
  }
  const type = parsed.getType() || null;
  return {
    valid: true,
    e164: parsed.number,
    country: parsed.country || null,
    type,
    mobile: type ? MESSAGING_TYPES.has(type) : false,
  };
}

/**
 * E.164 without the leading plus, as WhatsApp reports `wa_id`.
 *
 * @param {string} e164
 * @returns {string}
 */
const digitsOnly = (e164) => String(e164 || '').replace(/^\+/, '');

module.exports = { parsePhone, digitsOnly, MESSAGING_TYPES };
