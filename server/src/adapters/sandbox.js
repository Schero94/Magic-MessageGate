'use strict';

/**
 * Sandbox provider: a deterministic, in-process stand-in for Meta, Telegram,
 * seven.io and Twilio. Enabled with plugin config `providers.mode:
 * 'sandbox'`. Nothing leaves the process and nothing is charged.
 *
 * Outcomes depend on the recipient (see testing/numbers.js). A send returns
 * `simulated` statuses, which the outbox applies right after the send
 * through the same code path as real webhooks (monotonic timeline, fallback
 * chain, learned reachability). Telegram chats always end as `sent`
 * (the Bot API has no delivery receipts).
 */
const crypto = require('node:crypto');
const meta = require('./meta');
const twilio = require('./twilio');
const seven = require('./seven');
const { scenarioOf } = require('../testing/numbers');
const { syntheticFile } = require('../utils/filetype');

const CHANNEL = { meta: 'whatsapp', telegram: 'telegram', seven: 'sms', twilio: 'sms' };
const UNDELIVERED = { whatsapp: 'META_131049', rcs: 'TWILIO_30006', sms: 'SEVEN_NOTDELIVERED' };

/**
 * @param {string} provider
 * @param {string} channel
 * @returns {string}
 */
const messageId = (provider, channel) => {
  const hex = crypto.randomBytes(16).toString('hex');
  return provider === 'twilio' ? `SM${hex}` : `sbx_${channel}_${hex}`;
};

/**
 * @param {string} provider
 * @param {string} channel
 * @param {string} to
 * @returns {object} Adapter send result.
 */
function outcome(provider, channel, to) {
  const accepted = (simulated) => ({
    outcome: 'accepted',
    providerMessageId: messageId(provider, channel),
    code: null,
    retryAfterMs: null,
    accountProblem: false,
    simulated,
  });
  if (channel === 'telegram') return accepted([]);
  const scenario = scenarioOf(to);
  if (scenario === 'rejected') {
    return {
      outcome: 'rejected',
      providerMessageId: null,
      code: 'SANDBOX_REJECTED',
      retryAfterMs: null,
      accountProblem: false,
    };
  }
  if (scenario === 'uncertain') {
    return {
      outcome: 'ambiguous',
      providerMessageId: null,
      code: 'TIMEOUT',
      retryAfterMs: null,
      accountProblem: false,
    };
  }
  if (scenario === 'notOnWhatsApp' && channel === 'whatsapp')
    return accepted([{ status: 'failed', code: 'META_131026' }]);
  if (scenario === 'rcsNotCapable' && channel === 'rcs') return accepted([{ status: 'failed', code: 'TWILIO_63036' }]);
  if (scenario === 'undelivered' || scenario === 'inactive') {
    return accepted([{ status: 'failed', code: UNDELIVERED[channel] || 'SANDBOX_UNDELIVERED' }]);
  }
  const statuses = [{ status: 'delivered' }];
  if (scenario === 'read' && (channel === 'whatsapp' || channel === 'rcs')) statuses.push({ status: 'read' });
  return accepted(statuses);
}

/**
 * @param {string} provider - meta | telegram | seven | twilio
 * @returns {object} Adapter with the same methods as the live one.
 */
function forProvider(provider) {
  return {
    channel: CHANNEL[provider],
    provider,
    sandbox: true,
    TEMPLATE_STATUSES: meta.TEMPLATE_STATUSES,
    STATUS: twilio.STATUS,
    DLR_STATUS: seven.DLR_STATUS,
    async send({ to, channel }) {
      return outcome(provider, channel || CHANNEL[provider], String(to));
    },
    async testConnection() {
      const info = provider === 'telegram' ? { username: 'sandbox_bot' } : provider === 'seven' ? { balance: 0 } : {};
      return { ok: true, code: null, info: { ...info, sandbox: true } };
    },
    async setWebhook() {
      return { ok: true, code: null };
    },
    async listTemplates() {
      return [];
    },
    async submitTemplate() {
      return { ok: true, id: String(crypto.randomInt(100000, 999999999)), status: 'APPROVED', code: null };
    },
    async uploadSample() {
      return { ok: true, handle: `4::sandbox-${crypto.randomBytes(6).toString('hex')}`, code: null };
    },
    async createContent() {
      return { ok: true, sid: `HX${crypto.randomBytes(16).toString('hex')}`, code: null };
    },
    async lookup({ e164 }) {
      return { ok: true, valid: scenarioOf(e164) !== 'inactive', lineType: 'mobile', code: null };
    },
    async hlr({ e164 }) {
      const inactive = scenarioOf(e164) === 'inactive';
      return {
        ok: true,
        code: null,
        valid: inactive ? 'not_valid' : 'valid',
        reachable: inactive ? 'bad_number' : 'reachable',
        ported: 'assumed_not_ported',
        roaming: 'not_roaming',
        network: 'Sandbox Mobile',
        networkType: 'mobile',
      };
    },
    async downloadMedia({ ref, maxBytes }) {
      if (ref?.expired) return { ok: false, code: 'MEDIA_EXPIRED' };
      if (Number(ref?.size) > maxBytes) return { ok: false, code: 'MEDIA_TOO_LARGE' };
      const bytes = ref?.mismatch
        ? Buffer.from('not the declared type')
        : syntheticFile(ref?.mime, Number(ref?.size) || 1024);
      return { ok: true, bytes, mime: ref?.mime || null, code: null };
    },
    async answerCallback() {
      return { ok: true };
    },
    async exchangeCode() {
      return { ok: true, accessToken: `EAAsandbox${crypto.randomBytes(8).toString('hex')}`, code: null };
    },
    async subscribeApp() {
      return { ok: true, code: null };
    },
    async registerNumber() {
      return { ok: true, code: null };
    },
    async startBusinessAppSync() {
      return { ok: true, code: null };
    },
  };
}

module.exports = { forProvider, outcome };
