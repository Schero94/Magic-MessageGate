'use strict';

/** Registry of channel adapters by provider id. */
const meta = require('./meta');
const telegram = require('./telegram');
const seven = require('./seven');
const twilio = require('./twilio');

const ADAPTERS = Object.freeze({ meta, telegram, seven, twilio });

/** Which providers serve which channel. */
const PROVIDERS_BY_CHANNEL = Object.freeze({
  whatsapp: ['meta'],
  telegram: ['telegram'],
  sms: ['seven', 'twilio'],
});

/**
 * @param {string} provider
 * @returns {object|null}
 */
const getAdapter = (provider) => ADAPTERS[provider] || null;

module.exports = { ADAPTERS, PROVIDERS_BY_CHANNEL, getAdapter };
