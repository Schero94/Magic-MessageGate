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
 *
 * RCS (read 2026-11-11):
 * - https://www.twilio.com/docs/rcs/send-an-rcs-message : RCS goes through the
 *   same Messages API with the Messaging Service that holds the RCS sender.
 *   With `To=rcs:+…` Twilio does not fall back to SMS by itself, so
 *   MessageGate's own chain decides (whatsapp → rcs → sms). `Body` plus
 *   `MediaUrl` becomes a rich card; `ContentSid` + `ContentVariables` sends a
 *   Content template (twilio/card with title, media and buttons).
 * - https://www.twilio.com/docs/api/errors/63036 : the number cannot be
 *   reached over RCS (device not RCS capable, offline).
 * - https://www.twilio.com/docs/content/twiliocard : POST
 *   https://content.twilio.com/v1/Content with `types['twilio/card']`.
 * - Status `read` is reported for RCS (message-resource, MessageStatus).
 * - Twilio has no RCS capability lookup (Lookup v2 data packages:
 *   https://www.twilio.com/docs/lookup/v2-api); capability is learned from sends.
 */
const { request } = require('./http');
const { fetchLimited, onHost } = require('../utils/download');

/**
 * Twilio media: "Twilio enforces HTTP Basic Authentication for all media
 * URLs" (https://www.twilio.com/docs/messaging/api/media-resource). A media
 * URL may answer with a redirect to a short-lived storage URL; only Twilio's
 * media hosts are followed (not documented on docs pages, see AGENTS.md).
 */
const MEDIA_REDIRECT_HOSTS = [/(^|\.)twiliocdn\.com$/, /(^|\.)twilio\.com$/, /^s3-external-1\.amazonaws\.com$/];

const API_BASE = 'https://api.twilio.com';
const LOOKUP_BASE = 'https://lookups.twilio.com';
const CONTENT_BASE = 'https://content.twilio.com';

/** Twilio error codes that are about the recipient (permanent). */
const RECIPIENT_CODES = new Set([21211, 21214, 21408, 21610, 21612, 21614, 63021, 63035, 63036]);
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
  async send({ config, to, payload, channel, statusCallbackUrl, settings, fetchImpl }) {
    const form = new URLSearchParams();
    if (channel === 'rcs') {
      // Without the rcs: prefix Twilio would fall back to SMS on its own and
      // MessageGate could not tell which channel was used.
      form.set('To', config.twilioFallback ? to : `rcs:${to}`);
      form.set('MessagingServiceSid', config.messagingServiceSid);
      if (payload.contentSid) {
        form.set('ContentSid', payload.contentSid);
        if (payload.contentVariables) form.set('ContentVariables', JSON.stringify(payload.contentVariables));
      } else {
        form.set('Body', payload.text);
        if (payload.mediaUrl) form.set('MediaUrl', payload.mediaUrl);
      }
    } else {
      form.set('To', to);
      form.set('Body', payload.text);
      if (config.messagingServiceSid) form.set('MessagingServiceSid', config.messagingServiceSid);
      else form.set('From', config.from);
    }
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
   * Downloads inbound media from the MediaUrl of a webhook. The URL must be
   * this account's media resource on api.twilio.com.
   *
   * @param {{config: object, ref: {url: string}, maxBytes: number, settings?: object, fetchImpl?: Function}} input
   * @returns {Promise<{ok: boolean, bytes?: Buffer, mime?: string|null, code: string|null}>}
   */
  async downloadMedia({ config, ref, maxBytes, settings, fetchImpl }) {
    const base = settings?.baseUrl || API_BASE;
    const prefix = `${base}/2010-04-01/Accounts/${config.accountSid}/Messages/`;
    const value = String(ref?.url || '');
    if (!value.startsWith(prefix) || !/\/Media\/ME[0-9a-f]{32}$/.test(value) || value.includes('..')) {
      return { ok: false, code: 'MEDIA_HOST_REFUSED' };
    }
    let file = await fetchLimited({
      url: value,
      headers: { authorization: basicAuth(config) },
      maxBytes,
      fetchImpl,
      redirect: 'manual',
    });
    if (!file.ok && file.code === 'REDIRECT') {
      if (!onHost(file.location, MEDIA_REDIRECT_HOSTS, settings?.baseUrl))
        return { ok: false, code: 'MEDIA_HOST_REFUSED' };
      file = await fetchLimited({ url: file.location, maxBytes, fetchImpl });
    }
    if (!file.ok) {
      const code = { TOO_LARGE: 'MEDIA_TOO_LARGE', EXPIRED: 'MEDIA_EXPIRED' }[file.code] || 'MEDIA_FETCH_FAILED';
      return { ok: false, code };
    }
    return { ok: true, bytes: file.bytes, mime: file.contentType, code: null };
  },

  /**
   * Creates a Content template for an RCS rich card (title, body, media,
   * buttons) with a plain-text type for devices without RCS.
   *
   * @param {{config: object, content: {friendlyName: string, language: string, variables: Record<string,string>, card: object, text: string}, settings?: object, fetchImpl?: Function}} input
   * @returns {Promise<{ok: boolean, sid: string|null, code: string|null}>}
   */
  async createContent({ config, content, settings, fetchImpl }) {
    const res = await request({
      url: `${settings?.contentBaseUrl || CONTENT_BASE}/v1/Content`,
      headers: { authorization: basicAuth(config), accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        friendly_name: content.friendlyName,
        language: content.language,
        variables: content.variables,
        types: { 'twilio/card': content.card, 'twilio/text': { body: content.text } },
      }),
      timeoutMs: 15_000,
      fetchImpl,
    });
    const sid = res.json?.sid;
    if (res.outcome !== 'accepted' || typeof sid !== 'string' || !/^HX[0-9a-f]{32}$/.test(sid)) {
      const twilioCode = Number(res.json?.code);
      return { ok: false, sid: null, code: Number.isFinite(twilioCode) ? `TWILIO_${twilioCode}` : res.code };
    }
    return { ok: true, sid, code: null };
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
