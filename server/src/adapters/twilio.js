'use strict';

/**
 * Twilio SMS and Lookup adapter.
 *
 * Sources (read 2026-11-10):
 * - Messages: https://www.twilio.com/docs/messaging/api/message-resource
 *   POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json,
 *   basic auth (Account SID or API key SID : auth token / secret), form fields
 *   To, From | MessagingServiceSid, Body, StatusCallback. Status values
 *   queued, sending, sent, failed, delivered, undelivered, accepted, ...
 * - Lookup v2: https://www.twilio.com/docs/lookup/v2-api/line-type-intelligence
 *   GET https://lookups.twilio.com/v2/PhoneNumbers/{n}?Fields=line_type_intelligence
 * - Webhook signature: utils/signatures.js
 */
const { request } = require('./http');

const API_BASE = 'https://api.twilio.com';
const LOOKUP_BASE = 'https://lookups.twilio.com';

/** Twilio error codes that are about the recipient (permanent). */
const RECIPIENT_CODES = new Set([21211, 21214, 21408, 21610, 21612, 21614]);
/** Twilio error codes about the account or sender configuration. */
const ACCOUNT_CODES = new Set([20003, 20404, 21212, 21606, 21659, 30007]);

/** Maps Twilio MessageStatus to MessageGate updates. */
const STATUS = Object.freeze({
  queued: null,
  accepted: null,
  sending: null,
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  undelivered: 'failed',
  failed: 'failed',
  canceled: 'failed',
});

/**
 * @param {object} config
 * @returns {string}
 */
function basicAuth(config) {
  const user = config.apiKeySid || config.accountSid;
  const secret = config.apiKeySid ? config.apiKeySecret : config.authToken;
  return `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}`;
}

module.exports = {
  channel: 'sms',
  provider: 'twilio',
  STATUS,

  /**
   * @param {{config: object, to: string, payload: {text: string}, statusCallbackUrl?: string, settings?: object, fetchImpl?: Function}} input
   * @returns {Promise<{outcome: string, providerMessageId: string|null, code: string|null, retryAfterMs: number|null, accountProblem: boolean}>}
   */
  async send({ config, to, payload, statusCallbackUrl, settings, fetchImpl }) {
    const form = new URLSearchParams({ To: to, Body: payload.text });
    if (config.messagingServiceSid) form.set('MessagingServiceSid', config.messagingServiceSid);
    else form.set('From', config.from);
    if (statusCallbackUrl) form.set('StatusCallback', statusCallbackUrl);
    const res = await request({
      url: `${settings?.baseUrl || API_BASE}/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`,
      headers: {
        authorization: basicAuth(config),
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      timeoutMs: settings?.timeoutMs || 15_000,
      fetchImpl,
    });
    if (res.outcome === 'accepted') {
      return {
        outcome: 'accepted',
        providerMessageId: res.json?.sid || null,
        code: null,
        retryAfterMs: null,
        accountProblem: false,
      };
    }
    const twilioCode = Number(res.json?.code);
    if (Number.isFinite(twilioCode)) {
      const code = `TWILIO_${twilioCode}`;
      if (twilioCode === 20429)
        return {
          outcome: 'transient',
          providerMessageId: null,
          code,
          retryAfterMs: res.retryAfterMs,
          accountProblem: false,
        };
      if (res.outcome === 'rejected' || RECIPIENT_CODES.has(twilioCode) || ACCOUNT_CODES.has(twilioCode)) {
        return {
          outcome: 'rejected',
          providerMessageId: null,
          code,
          retryAfterMs: null,
          accountProblem: ACCOUNT_CODES.has(twilioCode),
        };
      }
    }
    return {
      outcome: res.outcome,
      providerMessageId: null,
      code: res.code,
      retryAfterMs: res.retryAfterMs,
      accountProblem: false,
    };
  },

  /**
   * @param {{config: object, settings?: object, fetchImpl?: Function}} input
   * @returns {Promise<{ok: boolean, code: string|null, info: object}>}
   */
  async testConnection({ config, settings, fetchImpl }) {
    const res = await request({
      url: `${settings?.baseUrl || API_BASE}/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}.json`,
      method: 'GET',
      headers: { authorization: basicAuth(config), accept: 'application/json' },
      timeoutMs: 10_000,
      fetchImpl,
    });
    if (res.outcome !== 'accepted') return { ok: false, code: res.code, info: {} };
    return { ok: true, code: null, info: { status: res.json?.status || null } };
  },

  /**
   * Line type lookup (paid per request).
   *
   * @param {{config: object, e164: string, settings?: object, fetchImpl?: Function}} input
   * @returns {Promise<{ok: boolean, valid: boolean|null, lineType: string|null, code: string|null}>}
   */
  async lookup({ config, e164, settings, fetchImpl }) {
    const res = await request({
      url: `${settings?.lookupBaseUrl || LOOKUP_BASE}/v2/PhoneNumbers/${encodeURIComponent(e164)}?Fields=line_type_intelligence`,
      method: 'GET',
      headers: { authorization: basicAuth(config), accept: 'application/json' },
      timeoutMs: 10_000,
      fetchImpl,
    });
    if (res.outcome !== 'accepted') return { ok: false, valid: null, lineType: null, code: res.code };
    return {
      ok: true,
      valid: res.json?.valid === true,
      lineType: res.json?.line_type_intelligence?.type || null,
      code: res.json?.line_type_intelligence?.error_code
        ? `TWILIO_${res.json.line_type_intelligence.error_code}`
        : null,
    };
  },
};
