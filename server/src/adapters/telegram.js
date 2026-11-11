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
 * - sendPhoto / sendDocument: `photo`/`document` as an HTTP URL, `caption`
 *   0-1024 characters after entity parsing. By URL: photos up to 5 MB, other
 *   files 20 MB, and sendDocument by URL only works for .PDF and .ZIP.
 * Bots cannot write to a phone number and get no read receipts.
 */
const { request } = require('./http');
const { fetchLimited } = require('../utils/download');

/** getFile downloads are limited to 20 MB by the Bot API. */
const MAX_DOWNLOAD = 20 * 1024 * 1024;

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
    let method = 'sendMessage';
    let body = {
      chat_id: to,
      text: String(payload.text).slice(0, MAX_TEXT),
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    };
    if (payload.kind === 'photo' || payload.kind === 'document') {
      method = payload.kind === 'photo' ? 'sendPhoto' : 'sendDocument';
      body = { chat_id: to, [payload.kind]: payload.url, parse_mode: 'HTML' };
      if (payload.caption) body.caption = payload.caption;
    }
    // Inline keyboard: one button per row, callback_data 1-64 bytes.
    if (Array.isArray(payload.buttons) && payload.buttons.length) {
      body.reply_markup = {
        inline_keyboard: payload.buttons.map((b) => [{ text: b.title, callback_data: b.payload }]),
      };
    }
    const res = await request({
      url: url(config, settings, method),
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
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
   * Downloads an inbound file: getFile → file_path (link valid at least one
   * hour), then https://api.telegram.org/file/bot<token>/<file_path>.
   *
   * @param {{config: object, ref: {id: string}, maxBytes: number, settings?: object, fetchImpl?: Function}} input
   * @returns {Promise<{ok: boolean, bytes?: Buffer, mime?: string|null, code: string|null}>}
   */
  async downloadMedia({ config, ref, maxBytes, settings, fetchImpl }) {
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(String(ref?.id || ''))) return { ok: false, code: 'MEDIA_REF_INVALID' };
    const res = await request({
      url: url(config, settings, 'getFile'),
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ file_id: ref.id }),
      timeoutMs: 15_000,
      fetchImpl,
    });
    const filePath = res.json?.result?.file_path;
    if (classify(res).outcome !== 'accepted' || typeof filePath !== 'string') {
      return { ok: false, code: res.json?.description?.includes?.('too big') ? 'MEDIA_TOO_LARGE' : 'MEDIA_EXPIRED' };
    }
    if (!/^[A-Za-z0-9_./-]{1,300}$/.test(filePath) || filePath.includes('..')) {
      return { ok: false, code: 'MEDIA_REF_INVALID' };
    }
    const file = await fetchLimited({
      url: `${settings?.baseUrl || DEFAULT_BASE}/file/bot${config.botToken}/${filePath}`,
      maxBytes: Math.min(maxBytes, MAX_DOWNLOAD),
      fetchImpl,
    });
    if (!file.ok) {
      const code = { TOO_LARGE: 'MEDIA_TOO_LARGE', EXPIRED: 'MEDIA_EXPIRED' }[file.code] || 'MEDIA_FETCH_FAILED';
      return { ok: false, code };
    }
    return { ok: true, bytes: file.bytes, mime: null, code: null };
  },

  /**
   * Stops the loading indicator after an inline keyboard press.
   *
   * @param {{config: object, callbackQueryId: string, settings?: object, fetchImpl?: Function}} input
   * @returns {Promise<{ok: boolean}>}
   */
  async answerCallback({ config, callbackQueryId, settings, fetchImpl }) {
    const res = await request({
      url: url(config, settings, 'answerCallbackQuery'),
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId }),
      timeoutMs: 10_000,
      fetchImpl,
    });
    return { ok: classify(res).outcome === 'accepted' };
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
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: false,
      }),
      timeoutMs: 10_000,
      fetchImpl,
    });
    const mapped = classify(res);
    return { ok: mapped.outcome === 'accepted', code: mapped.code };
  },
};
