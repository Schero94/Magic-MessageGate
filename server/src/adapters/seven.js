'use strict';

/**
 * seven.io SMS adapter.
 *
 * Sources (read 2026-11-10):
 * - https://docs.seven.io/en/rest-api/endpoints/sms : POST https://gateway.seven.io/api/sms,
 *   header X-Api-Key, form fields to, text, from, foreign_id; JSON response
 *   `success` code ("100" accepted, "101" partial, "202" invalid recipient,
 *   "500" no credit, "600" sending error, "900"/"902"/"903" auth) and
 *   `messages[].id`.
 * - https://docs.seven.io/en/rest-api/endpoints/status-reports : DLR values
 *   DELIVERED, NOTDELIVERED, BUFFERED, TRANSMITTED, ACCEPTED, EXPIRED,
 *   REJECTED, FAILED.
 * - Webhooks are signed like requests (see utils/signatures.js).
 * - https://docs.seven.io/en/rest-api/endpoints/lookup (read 2026-11-11):
 *   GET /api/lookup/hlr?number=…, fields `valid_number` (valid | not_valid |
 *   unknown), `reachable` (reachable | absent | bad_number | unknown),
 *   `ported`, `roaming`, `current_carrier {network_code, name, country,
 *   network_type}`. Refused with code 501 when the spending limit is reached.
 *   Paid per request (0.01 EUR per seven.io price list).
 */
const { request } = require('./http');

const DEFAULT_BASE = 'https://gateway.seven.io';

/** Return codes that prove nothing was sent and a later try can work. */
const TRANSIENT = new Set(['500', '403']);
/** Return codes that point at the account configuration. */
const ACCOUNT = new Set(['201', '900', '901', '902', '903']);
/** Return codes where the SMS may already have been sent. */
const AMBIGUOUS = new Set(['402', '600']);

/** Maps seven.io DLR values to MessageGate status updates. */
const DLR_STATUS = Object.freeze({
  DELIVERED: 'delivered',
  NOTDELIVERED: 'failed',
  EXPIRED: 'failed',
  REJECTED: 'failed',
  FAILED: 'failed',
  TRANSMITTED: 'sent',
  ACCEPTED: 'sent',
  BUFFERED: 'sent',
});

module.exports = {
  channel: 'sms',
  provider: 'seven',
  DLR_STATUS,

  /**
   * @param {{config: object, to: string, payload: {text: string}, messageId?: string, settings?: object, fetchImpl?: Function}} input
   * @returns {Promise<{outcome: string, providerMessageId: string|null, code: string|null, retryAfterMs: number|null, accountProblem: boolean}>}
   */
  async send({ config, to, payload, messageId, settings, fetchImpl }) {
    const form = new URLSearchParams({ to, text: payload.text });
    if (config.senderId) form.set('from', config.senderId);
    if (messageId) form.set('foreign_id', String(messageId).slice(0, 64));
    const res = await request({
      url: `${settings?.baseUrl || DEFAULT_BASE}/api/sms`,
      headers: {
        'x-api-key': config.apiKey,
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      timeoutMs: settings?.timeoutMs || 15_000,
      fetchImpl,
    });
    if (res.outcome !== 'accepted') {
      return {
        outcome: res.outcome,
        providerMessageId: null,
        code: res.code,
        retryAfterMs: res.retryAfterMs,
        accountProblem: false,
      };
    }
    const success = String(res.json?.success ?? '');
    const first = Array.isArray(res.json?.messages) ? res.json.messages[0] : null;
    if (success === '100' && first?.success !== false) {
      return {
        outcome: 'accepted',
        providerMessageId: first?.id ? String(first.id) : null,
        code: null,
        retryAfterMs: null,
        accountProblem: false,
      };
    }
    const code = `SEVEN_${success || 'UNKNOWN'}`;
    if (TRANSIENT.has(success))
      return { outcome: 'transient', providerMessageId: null, code, retryAfterMs: null, accountProblem: false };
    if (AMBIGUOUS.has(success) || success === '101' || !success) {
      return {
        outcome: 'ambiguous',
        providerMessageId: first?.id ? String(first.id) : null,
        code,
        retryAfterMs: null,
        accountProblem: false,
      };
    }
    return {
      outcome: 'rejected',
      providerMessageId: null,
      code,
      retryAfterMs: null,
      accountProblem: ACCOUNT.has(success),
    };
  },

  /**
   * HLR lookup: is the number assigned and registered in a mobile network.
   *
   * @param {{config: object, e164: string, settings?: object, fetchImpl?: Function}} input
   * @returns {Promise<{ok: boolean, code: string|null, valid: string|null, reachable: string|null, ported: string|null, roaming: string|null, network: string|null, networkType: string|null}>}
   */
  async hlr({ config, e164, settings, fetchImpl }) {
    const number = String(e164).replace(/^\+/, '');
    const res = await request({
      url: `${settings?.baseUrl || DEFAULT_BASE}/api/lookup/hlr?number=${encodeURIComponent(number)}`,
      method: 'GET',
      headers: { 'x-api-key': config.apiKey, accept: 'application/json' },
      timeoutMs: 10_000,
      fetchImpl,
    });
    const empty = { valid: null, reachable: null, ported: null, roaming: null, network: null, networkType: null };
    const j = res.json;
    if (res.outcome !== 'accepted' || !j || typeof j !== 'object' || Array.isArray(j) || j.status === false) {
      const raw = j && typeof j === 'object' && !Array.isArray(j) ? (j.code ?? j.success) : j;
      return {
        ok: false,
        code: raw !== undefined && raw !== null ? `SEVEN_${String(raw).slice(0, 20)}` : res.code,
        ...empty,
      };
    }
    const word = (v) => (typeof v === 'string' && /^[a-z_]{1,40}$/.test(v) ? v : null);
    const carrier = j.current_carrier || {};
    return {
      ok: true,
      code: null,
      valid: word(j.valid_number),
      reachable: word(j.reachable),
      ported: word(j.ported),
      roaming: typeof j.roaming === 'string' ? word(j.roaming) : null,
      network: typeof carrier.name === 'string' ? carrier.name.slice(0, 60) : null,
      networkType: word(carrier.network_type),
    };
  },

  /**
   * Reads the balance to check the API key.
   *
   * @param {{config: object, settings?: object, fetchImpl?: Function}} input
   * @returns {Promise<{ok: boolean, code: string|null, info: object}>}
   */
  async testConnection({ config, settings, fetchImpl }) {
    const res = await request({
      url: `${settings?.baseUrl || DEFAULT_BASE}/api/balance`,
      method: 'GET',
      headers: { 'x-api-key': config.apiKey, accept: 'application/json' },
      timeoutMs: 10_000,
      fetchImpl,
    });
    if (res.outcome !== 'accepted') return { ok: false, code: res.code, info: {} };
    const amount = Number(res.json?.amount ?? res.json);
    return {
      ok: Number.isFinite(amount),
      code: Number.isFinite(amount) ? null : 'SEVEN_AUTH',
      info: { balance: Number.isFinite(amount) ? amount : null },
    };
  },
};
