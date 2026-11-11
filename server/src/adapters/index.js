'use strict';

/** Registry of channel adapters by provider id. */
const meta = require('./meta');
const telegram = require('./telegram');
const seven = require('./seven');
const twilio = require('./twilio');
const sandbox = require('./sandbox');

const ADAPTERS = Object.freeze({ meta, telegram, seven, twilio });

/** Which providers serve which channel. */
const PROVIDERS_BY_CHANNEL = Object.freeze({
  whatsapp: ['meta'],
  telegram: ['telegram'],
  sms: ['seven', 'twilio'],
  rcs: ['twilio'],
});

/**
 * @param {string} provider
 * @returns {object|null}
 */
const getAdapter = (provider) => ADAPTERS[provider] || null;

/**
 * Adapter for a provider in the configured mode: in `sandbox` mode every
 * provider is served by the deterministic in-process fake.
 *
 * @param {string} provider
 * @param {'live'|'sandbox'} [mode]
 * @returns {object|null}
 */
const adapterFor = (provider, mode = 'live') => {
  if (!ADAPTERS[provider]) return null;
  return mode === 'sandbox' ? sandbox.forProvider(provider) : ADAPTERS[provider];
};

module.exports = { ADAPTERS, PROVIDERS_BY_CHANNEL, getAdapter, adapterFor };
