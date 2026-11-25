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
 *
 * Re-read 2026-11-20 (provider audit, docs/audits/2026-11-20-provider-apis.md):
 * - `text` "may not exceed 1520 characters" (official OpenAPI,
 *   github.com/seven-io/api-schemes json/openapi.json); longer texts are
 *   refused with code 401, so the adapter cuts at 1520 like the SMS path
 *   cuts at 1600 for Twilio.
 * - Return codes (docs.seven.io/en/rest-api/endpoints/sms): 101 "sending to
 *   at least one recipient failed" (one recipient here, so it failed), 402
 *   duplicate within 180 seconds (the first one was sent), 403 daily limit
 *   for this recipient, 407001-407005 declined / country blocked / number
 *   blocked / recipient unsubscribed / price limit, 500 no credit, 501
 *   spending limit, 900-903 authentication.
 * - There is no sandbox or debug switch for POST /api/sms; every accepted
 *   SMS is billed.
 * - https://docs.seven.io/en/rest-api/endpoints/lookup (read 2026-11-11):
 *   GET /api/lookup/hlr?number=…, fields `valid_number` (valid | not_valid |
 *   unknown), `reachable` (reachable | absent | bad_number | unknown),
 *   `ported`, `roaming`, `current_carrier {network_code, name, country,
 *   network_type}`. Refused with code 501 when the spending limit is reached.
 *   Paid per request (0.01 EUR per seven.io price list).
 *
 * Webhook management (read 2026-11-24, issue #17):
 * - https://docs.seven.io/en/rest-api/endpoints/webhooks
 *   GET /api/hooks answers `{ success, code, hooks: [{ id, target_url,
 *   headers, event_type, event_filter, request_method, enabled, created }] }`
 *   (`id` is a string there). POST /api/hooks takes the form fields
 *   `target_url`, `event_type`, optional `event_filter`, `headers` and
 *   `request_method` (POST = form-encoded, the default; GET = query; JSON =
 *   HTTP POST with a JSON body) and answers `{ success, code, id,
 *   error_message }` (`id` an integer). DELETE /api/hooks with the form
 *   field `id` answers the same shape.
 * - Official OpenAPI (github.com/seven-io/api-schemes json/openapi.json,
 *   pinned in tests/contract/specs/seven.json): the same operations; its
 *   GET schema wraps the list as `data[].hooks` (one hook per item), which
 *   contradicts the reference page. Both shapes are read.
 * - https://docs.seven.io/en/rest-api/signing : webhooks are signed with the
 *   account's signing key (Developer area → API settings). A hook has no
 *   secret of its own, so registration sends none; the owner still enters
 *   the signing key in MessageGate.
 */
const { request } = require('./http');
const { safeSlice } = require('../utils/template-engine');

const DEFAULT_BASE = 'https://gateway.seven.io';

/** Longest `text` seven.io accepts (official OpenAPI: "may not exceed 1520 characters"). */
const MAX_TEXT = 1520;

/** Return codes that prove nothing was sent and a later try can work. */
const TRANSIENT = new Set(['500', '403']);
/** Return codes that point at the account configuration (no credit, spending limit, auth, sender). */
const ACCOUNT = new Set(['201', '500', '501', '900', '901', '902', '903']);
/** Recipient opted out at seven.io: consent for SMS is revoked. */
const OPTED_OUT = new Set(['407004']);
/** Return codes where the SMS may already have been sent. */
const AMBIGUOUS = new Set(['402', '600']);

/** Event types MessageGate registers: status reports and inbound SMS. */
const HOOK_EVENTS = Object.freeze(['dlr', 'sms_mo']);

/**
 * Error code of a hooks API answer that did not succeed.
 *
 * @param {{outcome: string, json: any, code: string|null}} res
 * @returns {string}
 */
function hookError(res) {
  const j = res.json;
  if (res.outcome !== 'accepted') return res.code || 'SEVEN_HOOKS';
  // Auth failures answer a bare return code (900-903) instead of an object.
  if (typeof j === 'number' || (typeof j === 'string' && /^\d{3,6}$/.test(j))) return `SEVEN_${j}`;
  const raw = j && typeof j === 'object' ? j.code : null;
  return raw !== null && raw !== undefined && /^[A-Za-z0-9_]{1,20}$/.test(String(raw)) ? `SEVEN_${raw}` : 'SEVEN_HOOKS';
}

/**
 * Normalises one hook entry from GET /api/hooks.
 *
 * @param {any} h
 * @returns {{id: string, targetUrl: string, eventType: string, requestMethod: string, enabled: boolean}|null}
 */
function toHook(h) {
  if (!h || typeof h !== 'object') return null;
  const id = typeof h.id === 'number' || typeof h.id === 'string' ? String(h.id) : '';
  if (!/^\d{1,20}$/.test(id) || typeof h.target_url !== 'string') return null;
  return {
    id,
    targetUrl: h.target_url.slice(0, 2048),
    eventType: typeof h.event_type === 'string' ? h.event_type.slice(0, 20) : '',
    requestMethod: typeof h.request_method === 'string' ? h.request_method.toUpperCase().slice(0, 8) : 'POST',
    // `enabled` is documented as a boolean; a missing value counts as enabled.
    enabled: h.enabled !== false && h.enabled !== 0 && h.enabled !== '0',
  };
}

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
  MAX_TEXT,
  HOOK_EVENTS,

  /**
   * @param {{config: object, to: string, payload: {text: string}, messageId?: string, settings?: object, fetchImpl?: Function}} input
   * @returns {Promise<{outcome: string, providerMessageId: string|null, code: string|null, retryAfterMs: number|null, accountProblem: boolean}>}
   */
  async send({ config, to, payload, messageId, settings, fetchImpl }) {
    const form = new URLSearchParams({ to, text: safeSlice(payload.text, MAX_TEXT) });
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
    // One recipient per request: 101 ("at least one recipient failed") means
    // this one failed, and the message entry carries the reason.
    const messageError = first && first.success === false && first.error ? String(first.error).slice(0, 20) : '';
    const reason = success === '101' && /^\d{3,6}$/.test(messageError) ? messageError : success;
    const code = `SEVEN_${reason || 'UNKNOWN'}`;
    if (TRANSIENT.has(reason))
      return {
        outcome: 'transient',
        providerMessageId: null,
        code,
        retryAfterMs: null,
        accountProblem: ACCOUNT.has(reason),
      };
    if (success === '101' && first?.success === false) {
      return {
        outcome: 'rejected',
        providerMessageId: null,
        code,
        retryAfterMs: null,
        accountProblem: ACCOUNT.has(reason),
        optedOut: OPTED_OUT.has(reason),
      };
    }
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
      optedOut: OPTED_OUT.has(success),
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
      // The official schema documents `roaming` as an object with `status`
      // (unknown | roaming | not_roaming); older answers sent a string.
      roaming: typeof j.roaming === 'string' ? word(j.roaming) : word(j.roaming?.status),
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

  /**
   * Lists the account's webhooks (GET /api/hooks).
   *
   * @param {{config: object, settings?: object, fetchImpl?: Function}} input
   * @returns {Promise<{ok: boolean, code: string|null, hooks: Array<{id: string, targetUrl: string, eventType: string, requestMethod: string, enabled: boolean}>}>}
   */
  async listHooks({ config, settings, fetchImpl }) {
    const res = await request({
      url: `${settings?.baseUrl || DEFAULT_BASE}/api/hooks`,
      method: 'GET',
      headers: { 'x-api-key': config.apiKey, accept: 'application/json' },
      timeoutMs: 10_000,
      fetchImpl,
    });
    const j = res.json;
    if (res.outcome !== 'accepted' || !j || typeof j !== 'object' || Array.isArray(j) || j.success === false) {
      return { ok: false, code: hookError(res), hooks: [] };
    }
    // Reference page: `hooks: [...]`; official OpenAPI: `data: [{ hooks: {...} }]`.
    let raw = null;
    if (Array.isArray(j.hooks)) raw = j.hooks;
    else if (Array.isArray(j.data)) raw = j.data.map((d) => d?.hooks);
    if (!raw) return { ok: false, code: 'SEVEN_HOOKS', hooks: [] };
    return { ok: true, code: null, hooks: raw.slice(0, 500).map(toHook).filter(Boolean) };
  },

  /**
   * Registers a webhook (POST /api/hooks) with the request method JSON, the
   * only body MessageGate reads.
   *
   * @param {{config: object, targetUrl: string, eventType: string, settings?: object, fetchImpl?: Function}} input
   * @returns {Promise<{ok: boolean, code: string|null, id: string|null}>}
   */
  async createHook({ config, targetUrl, eventType, settings, fetchImpl }) {
    const form = new URLSearchParams({ target_url: targetUrl, event_type: eventType, request_method: 'JSON' });
    const res = await request({
      url: `${settings?.baseUrl || DEFAULT_BASE}/api/hooks`,
      headers: {
        'x-api-key': config.apiKey,
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      timeoutMs: 10_000,
      fetchImpl,
    });
    const id = res.json?.id;
    if (res.outcome === 'accepted' && res.json?.success === true && /^\d{1,20}$/.test(String(id ?? ''))) {
      return { ok: true, code: null, id: String(id) };
    }
    return { ok: false, code: hookError(res), id: null };
  },

  /**
   * Deletes a webhook by id (DELETE /api/hooks, form field `id`).
   *
   * @param {{config: object, id: string, settings?: object, fetchImpl?: Function}} input
   * @returns {Promise<{ok: boolean, code: string|null}>}
   */
  async deleteHook({ config, id, settings, fetchImpl }) {
    const res = await request({
      url: `${settings?.baseUrl || DEFAULT_BASE}/api/hooks`,
      method: 'DELETE',
      headers: {
        'x-api-key': config.apiKey,
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ id: String(id) }).toString(),
      timeoutMs: 10_000,
      fetchImpl,
    });
    const ok = res.outcome === 'accepted' && res.json?.success === true;
    return { ok, code: ok ? null : hookError(res) };
  },
};
