'use strict';

/**
 * Telegram Bot API adapter.
 *
 * Source: https://core.telegram.org/bots/api (Bot API 10.4, read 2026-11-10)
 * - sendMessage: chat_id, text (1-4096 characters after entity parsing),
 *   parse_mode HTML, link_preview_options.
 * - setWebhook: url, secret_token (1-256 chars, A-Za-z0-9_-) echoed in
 *   X-Telegram-Bot-Api-Secret-Token, allowed_updates.
 * - Errors: { ok: false, error_code, description, parameters.retry_after }.
 * Bots cannot write to a phone number and get no read receipts.
 */
const { request } = require('./http');

const DEFAULT_BASE = 'https://api.telegram.org';
const MAX_TEXT = 4096;

/**
 * @param {{outcome: string, status: number, json: any, code: string|null, retryAfterMs: number|null}} res
 * @returns {{outcome: string, code: string|null, retryAfterMs: number|null, accountProblem: boolean, blocked: boolean}}
 */
function classify(res) {
  if (res.outcome === 'accepted' && res.json?.ok === true) {
    return { outcome: 'accepted', code: null, retryAfterMs: null, accountProblem: false, blocked: false };
  }
  const errorCode = Number(res.json?.error_code || res.status);
  if (errorCode === 429) {
    const retryAfter = Number(res.json?.parameters?.retry_after);
    return {
      outcome: 'transient',
      code: 'TG_429',
      retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : res.retryAfterMs,
      accountProblem: false,
      blocked: false,
    };
  }
  if (errorCode === 401 || errorCode === 404) {
    return { outcome: 'rejected', code: `TG_${errorCode}`, retryAfterMs: null, accountProblem: true, blocked: false };
  }
  if (errorCode === 403) {
    // "Forbidden: bot was blocked by the user" or the user deactivated.
    return { outcome: 'rejected', code: 'TG_403', retryAfterMs: null, accountProblem: false, blocked: true };
  }
  if (res.outcome === 'accepted' || errorCode === 400) {
    return {
      outcome: 'rejected',
      code: `TG_${errorCode || 400}`,
      retryAfterMs: null,
      accountProblem: false,
      blocked: false,
    };
  }
  return {
    outcome: res.outcome,
    code: res.code,
    retryAfterMs: res.retryAfterMs,
    accountProblem: false,
    blocked: false,
  };
}

/**
 * @param {object} config
 * @param {object} [settings]
 * @param {string} method
 * @returns {string}
 */
const url = (config, settings, method) => `${settings?.baseUrl || DEFAULT_BASE}/bot${config.botToken}/${method}`;

module.exports = {
  channel: 'telegram',
  provider: 'telegram',
  MAX_TEXT,

  /**
   * @param {{config: object, to: string, payload: {text: string}, settings?: object, fetchImpl?: Function}} input
   * @returns {Promise<{outcome: string, providerMessageId: string|null, code: string|null, retryAfterMs: number|null, accountProblem: boolean, blocked: boolean}>}
   */
  async send({ config, to, payload, settings, fetchImpl }) {
    const res = await request({
      url: url(config, settings, 'sendMessage'),
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        chat_id: to,
        text: String(payload.text).slice(0, MAX_TEXT),
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      }),
      timeoutMs: settings?.timeoutMs || 15_000,
      fetchImpl,
    });
    const mapped = classify(res);
    const id = res.json?.result?.message_id;
    return { ...mapped, providerMessageId: id !== undefined && id !== null ? `${to}:${id}` : null };
  },

  /**
   * @param {{config: object, settings?: object, fetchImpl?: Function}} input
   * @returns {Promise<{ok: boolean, code: string|null, info: object}>}
   */
  async testConnection({ config, settings, fetchImpl }) {
    const res = await request({
      url: url(config, settings, 'getMe'),
      method: 'GET',
      headers: { accept: 'application/json' },
      timeoutMs: 10_000,
      fetchImpl,
    });
    const mapped = classify(res);
    if (mapped.outcome !== 'accepted') return { ok: false, code: mapped.code, info: {} };
    return { ok: true, code: null, info: { username: res.json?.result?.username || null } };
  },

  /**
   * Registers the webhook with a secret token.
   *
   * @param {{config: object, webhookUrl: string, secretToken: string, settings?: object, fetchImpl?: Function}} input
   * @returns {Promise<{ok: boolean, code: string|null}>}
   */
  async setWebhook({ config, webhookUrl, secretToken, settings, fetchImpl }) {
    const res = await request({
      url: url(config, settings, 'setWebhook'),
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: secretToken,
        allowed_updates: ['message'],
        drop_pending_updates: false,
      }),
      timeoutMs: 10_000,
      fetchImpl,
    });
    const mapped = classify(res);
    return { ok: mapped.outcome === 'accepted', code: mapped.code };
  },
};
