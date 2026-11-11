'use strict';

/**
 * Magic test numbers of the sandbox provider mode (`providers.mode:
 * 'sandbox'`). They are valid German mobile numbers in the 01555 range and
 * only ever reach the in-process fake; every other number behaves like
 * `delivered`.
 */
const SANDBOX_NUMBERS = Object.freeze({
  /** Accepted, then delivered on every channel. */
  delivered: '+4915550000001',
  /** Accepted, delivered, then read (WhatsApp and RCS report reads). */
  read: '+4915550000002',
  /** WhatsApp fails with META_131026 (not on WhatsApp); other channels deliver. */
  notOnWhatsApp: '+4915550000003',
  /** RCS fails with TWILIO_63036 (not RCS capable); other channels deliver. */
  rcsNotCapable: '+4915550000004',
  /** Accepted, then undelivered on every channel (TWILIO_30006 / SEVEN_NOTDELIVERED / META_131049). */
  undelivered: '+4915550000005',
  /** Refused at send time on every channel (SANDBOX_REJECTED). */
  rejected: '+4915550000006',
  /** The provider times out after the request was written (TIMEOUT, status `uncertain`). */
  uncertain: '+4915550000007',
  /** HLR says the number is not assigned (`active: false`). Sends behave like `undelivered`. */
  inactive: '+4915550000008',
});

/**
 * @param {string} e164
 * @returns {string} Scenario name, `delivered` for unknown numbers.
 */
function scenarioOf(e164) {
  const entry = Object.entries(SANDBOX_NUMBERS).find(([, number]) => number === e164);
  return entry ? entry[0] : 'delivered';
}

module.exports = { SANDBOX_NUMBERS, scenarioOf };
