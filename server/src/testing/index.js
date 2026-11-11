'use strict';

/**
 * Test helpers for apps that use Magic MessageGate:
 *
 *   const { SANDBOX_NUMBERS, sandboxConfig, drain } = require('strapi-plugin-magic-messagegate/testing');
 *
 * - `sandboxConfig(extra)` returns plugin config for `config/env/test/plugins.js`
 *   with `providers.mode: 'sandbox'` (no network, no cost, deterministic outcomes).
 * - `SANDBOX_NUMBERS` maps scenarios (delivered, read, notOnWhatsApp,
 *   rcsNotCapable, undelivered, rejected, uncertain, inactive) to test numbers.
 * - `drain(strapi)` runs the send and media workers until nothing is due, so
 *   tests do not wait for the worker interval.
 * - `signDelivery(secret, timestamp, body)` produces the outgoing webhook
 *   signature, for testing a receiver.
 */
const { SANDBOX_NUMBERS, scenarioOf } = require('./numbers');
const { signDelivery } = require('../core/hooks-out');

/**
 * @param {object} [extra] - Further plugin config (merged shallowly).
 * @returns {object}
 */
function sandboxConfig(extra = {}) {
  return {
    ...extra,
    worker: { intervalMs: 1000, ...(extra.worker || {}) },
    providers: { ...(extra.providers || {}), mode: 'sandbox' },
  };
}

/**
 * Runs worker rounds until nothing is claimed (sandbox mode only).
 *
 * @param {object} strapi
 * @param {{maxRounds?: number}} [options]
 * @returns {Promise<number>} rounds used
 */
function drain(strapi, options) {
  return strapi.plugin('magic-messagegate').service('sandbox').drain(options);
}

module.exports = { SANDBOX_NUMBERS, scenarioOf, sandboxConfig, drain, signDelivery };
