'use strict';

/**
 * WhatsApp Cloud API adapter (Meta Graph API, plain HTTPS).
 *
 * Sources (read 2026-11-10):
 * - Messages: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
 *   POST /{version}/{phone-number-id}/messages, Bearer token, response
 *   `messages[0].id` (wamid). No idempotency key exists, so timeouts are
 *   "ambiguous" and never retried automatically.
 * - Templates: https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account/message_templates/
 *   GET/POST /{version}/{waba-id}/message_templates; status enum APPROVED,
 *   IN_APPEAL, PENDING, REJECTED, PENDING_DELETION, DELETED, DISABLED,
 *   PAUSED, LIMIT_EXCEEDED, ARCHIVED.
 * - Error codes: https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 *
 * Media (read 2026-11-11):
 * - Document/image/video messages: `type` plus `{ link, caption, filename }`
 *   https://developers.facebook.com/docs/whatsapp/cloud-api/messages/document-messages
 * - Template header media at send time: `{type: 'header', parameters: [{type:
 *   'image'|'video'|'document', image|video|document: {link|id}}]}`
 *   https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-media.md
 * - Templates with an IMAGE/VIDEO/DOCUMENT header need `example.header_handle`
 *   from the Resumable Upload API (POST /{app-id}/uploads, then POST
 *   /upload:<id> with `Authorization: OAuth <token>` and `file_offset: 0`,
 *   answer `{ h }`): https://developers.facebook.com/docs/graph-api/guides/upload
 *   and .../whatsapp/templates/components.md
 */
const { request } = require('./http');
const { fetchLimited, onHost } = require('../utils/download');

/**
 * Hosts a media URL from GET /{media-id} may point to. Meta documents only
 * that the URL needs the access token and expires after 5 minutes; the host
 * is not documented, so the Meta CDN domains are allowed and nothing else.
 */
const MEDIA_HOSTS = [/(^|\.)fbsbx\.com$/, /(^|\.)fbcdn\.net$/, /(^|\.)whatsapp\.net$/, /(^|\.)facebook\.com$/];

const DEFAULT_BASE = 'https://graph.facebook.com';
const DEFAULT_VERSION = 'v23.0';

/** Meta error codes that mean "throttled, nothing was sent, try later". */
const TRANSIENT_CODES = new Set([4, 80007, 130429, 131048, 131056, 133016]);
/** Error codes that point at the account configuration (token, number). */
const ACCOUNT_CODES = new Set([0, 3, 10, 190, 200, 131005, 131030, 131031, 131042, 133010]);

/** Template status values documented by Meta. */
const TEMPLATE_STATUSES = Object.freeze([
  'APPROVED',
  'IN_APPEAL',
  'PENDING',
  'REJECTED',
  'PENDING_DELETION',
  'DELETED',
  'DISABLED',
  'PAUSED',
  'LIMIT_EXCEEDED',
  'ARCHIVED',
]);

/**
 * @param {object} config - Decrypted account config.
 * @param {object} [settings] - Plugin config `providers.meta`.
 * @returns {{base: string, version: string, headers: Record<string,string>}}
 */
function endpoint(config, settings = {}) {
  return {
    base: settings.baseUrl || DEFAULT_BASE,
    version: config.graphVersion || settings.graphVersion || DEFAULT_VERSION,
    headers: {
      authorization: `Bearer ${config.accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
  };
}

/**
 * Maps a Graph API error body to an outbox outcome.
 *
 * @param {{outcome: string, json: any, code: string|null, retryAfterMs: number|null}} res
 * @returns {{outcome: string, code: string|null, retryAfterMs: number|null, accountProblem: boolean}}
 */
function classify(res) {
  const metaCode = Number(res.json?.error?.code);
  if (Number.isFinite(metaCode) && res.outcome !== 'accepted') {
    const code = `META_${metaCode}`;
    if (TRANSIENT_CODES.has(metaCode)) {
      return { outcome: 'transient', code, retryAfterMs: res.retryAfterMs, accountProblem: false };
    }
    if (metaCode === 1 || metaCode === 2 || metaCode === 131000) {
      return { outcome: 'ambiguous', code, retryAfterMs: null, accountProblem: false };
    }
    return { outcome: 'rejected', code, retryAfterMs: null, accountProblem: ACCOUNT_CODES.has(metaCode) };
  }
  return { outcome: res.outcome, code: res.code, retryAfterMs: res.retryAfterMs, accountProblem: false };
}

/**
 * Builds the Graph API body for a rendered payload.
 *
 * @param {string} to - E.164 number.
 * @param {object} payload - `{ kind: 'template', name, language, components }` or `{ kind: 'text', text }`.
 * @returns {object}
 */
function buildBody(to, payload) {
  if (payload.kind === 'media') {
    const media = { link: payload.link };
    if (payload.caption) media.caption = payload.caption;
    if (payload.mediaType === 'document' && payload.filename) media.filename = payload.filename;
    return {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: payload.mediaType,
      [payload.mediaType]: media,
    };
  }
  if (payload.kind === 'buttons') {
    // Interactive reply buttons (session messages, max 3, title ≤ 20, id ≤ 256):
    // https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-reply-buttons-messages
    return {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: payload.text },
        action: { buttons: payload.buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })) },
      },
    };
  }
  if (payload.kind === 'text') {
    return {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body: payload.text },
    };
  }
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: { name: payload.name, language: { code: payload.language }, components: payload.components || [] },
  };
}

module.exports = {
  channel: 'whatsapp',
  provider: 'meta',
  TEMPLATE_STATUSES,

  /**
   * Sends one message.
   *
   * @param {{config: object, to: string, payload: object, settings?: object, fetchImpl?: Function}} input
   * @returns {Promise<{outcome: string, providerMessageId: string|null, code: string|null, retryAfterMs: number|null, accountProblem: boolean}>}
   */
  async send({ config, to, payload, settings, fetchImpl }) {
    const { base, version, headers } = endpoint(config, settings);
    const res = await request({
      url: `${base}/${version}/${encodeURIComponent(config.phoneNumberId)}/messages`,
      headers,
      body: JSON.stringify(buildBody(to, payload)),
      timeoutMs: settings?.timeoutMs || 15_000,
      fetchImpl,
    });
    const mapped = classify(res);
    return { ...mapped, providerMessageId: res.json?.messages?.[0]?.id || null };
  },

  /**
   * Checks the token and phone number id.
   *
   * @param {{config: object, settings?: object, fetchImpl?: Function}} input
   * @returns {Promise<{ok: boolean, code: string|null, info: object}>}
   */
  async testConnection({ config, settings, fetchImpl }) {
    const { base, version, headers } = endpoint(config, settings);
    const res = await request({
      url: `${base}/${version}/${encodeURIComponent(config.phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating`,
      method: 'GET',
      headers,
      timeoutMs: 10_000,
      fetchImpl,
    });
    if (res.outcome !== 'accepted') return { ok: false, code: classify(res).code, info: {} };
    return {
      ok: true,
      code: null,
      info: {
        displayPhoneNumber: res.json?.display_phone_number || null,
        verifiedName: res.json?.verified_name || null,
        qualityRating: res.json?.quality_rating || null,
      },
    };
  },

  /**
   * Lists the templates of the WhatsApp Business Account.
   *
   * @param {{config: object, settings?: object, fetchImpl?: Function}} input
   * @returns {Promise<Array<{id: string, name: string, language: string, status: string, category: string, components: any[]}>>}
   */
  async listTemplates({ config, settings, fetchImpl }) {
    const { base, version, headers } = endpoint(config, settings);
    const items = [];
    let url = `${base}/${version}/${encodeURIComponent(config.wabaId)}/message_templates?fields=id,name,language,status,category,components&limit=100`;
    for (let page = 0; page < 20 && url; page += 1) {
      const res = await request({ url, method: 'GET', headers, timeoutMs: 15_000, fetchImpl });
      if (res.outcome !== 'accepted')
        throw Object.assign(new Error('Template list failed'), { code: classify(res).code });
      for (const t of res.json?.data || []) {
        items.push({
          id: String(t.id),
          name: String(t.name),
          language: String(t.language),
          status: TEMPLATE_STATUSES.includes(t.status) ? t.status : 'PENDING',
          category: String(t.category || 'UTILITY'),
          components: Array.isArray(t.components) ? t.components : [],
        });
      }
      const next = res.json?.paging?.next;
      // Only follow pagination links that stay on the configured Graph host.
      url = typeof next === 'string' && next.startsWith(`${base}/`) ? next : null;
    }
    return items;
  },

  /**
   * Submits a template for review.
   *
   * @param {{config: object, template: {name: string, language: string, category: string, parameterFormat: string, components: any[]}, settings?: object, fetchImpl?: Function}} input
   * @returns {Promise<{ok: boolean, id: string|null, status: string|null, code: string|null}>}
   */
  async submitTemplate({ config, template, settings, fetchImpl }) {
    const { base, version, headers } = endpoint(config, settings);
    const res = await request({
      url: `${base}/${version}/${encodeURIComponent(config.wabaId)}/message_templates`,
      headers,
      body: JSON.stringify({
        name: template.name,
        language: template.language,
        category: template.category,
        parameter_format: template.parameterFormat === 'positional' ? 'positional' : 'named',
        components: template.components,
      }),
      timeoutMs: 15_000,
      fetchImpl,
    });
    if (res.outcome !== 'accepted') return { ok: false, id: null, status: null, code: classify(res).code };
    return { ok: true, id: String(res.json?.id || ''), status: res.json?.status || 'PENDING', code: null };
  },

  /**
   * Uploads a template sample with the Resumable Upload API and returns the
   * file handle for `example.header_handle`.
   *
   * @param {{appId: string, accessToken: string, bytes: Buffer, fileName: string, mimeType: string, settings?: object, fetchImpl?: Function}} input
   * @returns {Promise<{ok: boolean, handle: string|null, code: string|null}>}
   */
  async uploadSample({ appId, accessToken, bytes, fileName, mimeType, settings = {}, fetchImpl }) {
    const base = settings.baseUrl || DEFAULT_BASE;
    const version = settings.graphVersion || DEFAULT_VERSION;
    const query = new URLSearchParams({
      file_name: fileName,
      file_length: String(bytes.length),
      file_type: mimeType,
    });
    const session = await request({
      url: `${base}/${version}/${encodeURIComponent(appId)}/uploads?${query}`,
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      timeoutMs: 15_000,
      fetchImpl,
    });
    const id = session.json?.id;
    if (session.outcome !== 'accepted' || typeof id !== 'string' || !/^upload:[A-Za-z0-9_=:.-]{1,400}$/.test(id)) {
      return {
        ok: false,
        handle: null,
        code: session.outcome === 'accepted' ? 'NO_UPLOAD_ID' : classify(session).code,
      };
    }
    const upload = await request({
      url: `${base}/${version}/${id}`,
      headers: { authorization: `OAuth ${accessToken}`, file_offset: '0', accept: 'application/json' },
      body: bytes,
      timeoutMs: 60_000,
      fetchImpl,
    });
    const handle = upload.json?.h;
    if (upload.outcome !== 'accepted' || typeof handle !== 'string' || !handle) {
      return { ok: false, handle: null, code: upload.outcome === 'accepted' ? 'NO_HANDLE' : classify(upload).code };
    }
    return { ok: true, handle, code: null };
  },

  /**
   * Downloads inbound media: GET /{media-id} for a fresh URL (valid 5
   * minutes), then the file with the access token. Media ids from webhooks
   * expire after 7 days.
   * https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media
   *
   * @param {{config: object, ref: {id: string}, maxBytes: number, settings?: object, fetchImpl?: Function}} input
   * @returns {Promise<{ok: boolean, bytes?: Buffer, mime?: string|null, code: string|null}>}
   */
  async downloadMedia({ config, ref, maxBytes, settings, fetchImpl }) {
    if (!/^\d{1,40}$/.test(String(ref?.id || ''))) return { ok: false, code: 'MEDIA_REF_INVALID' };
    const { base, version, headers } = endpoint(config, settings);
    const info = await request({
      url: `${base}/${version}/${ref.id}`,
      method: 'GET',
      headers,
      timeoutMs: 15_000,
      fetchImpl,
    });
    if (info.outcome !== 'accepted') {
      return { ok: false, code: info.status === 404 || info.status === 400 ? 'MEDIA_EXPIRED' : 'MEDIA_FETCH_FAILED' };
    }
    const size = Number(info.json?.file_size);
    if (Number.isFinite(size) && size > maxBytes) return { ok: false, code: 'MEDIA_TOO_LARGE' };
    const url = info.json?.url;
    if (!onHost(url, MEDIA_HOSTS, settings?.baseUrl)) return { ok: false, code: 'MEDIA_HOST_REFUSED' };
    const file = await fetchLimited({
      url,
      headers: { authorization: `Bearer ${config.accessToken}` },
      maxBytes,
      fetchImpl,
    });
    if (!file.ok) {
      const code = { TOO_LARGE: 'MEDIA_TOO_LARGE', EXPIRED: 'MEDIA_EXPIRED' }[file.code] || 'MEDIA_FETCH_FAILED';
      return { ok: false, code };
    }
    return { ok: true, bytes: file.bytes, mime: info.json?.mime_type || null, code: null };
  },

  /*
   * Embedded Signup (read 2026-11-11):
   * - https://developers.facebook.com/docs/whatsapp/embedded-signup/implementation
   * - https://developers.facebook.com/docs/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider
   *   1. GET /oauth/access_token?client_id&client_secret&code -> business token
   *   2. POST /<WABA_ID>/subscribed_apps (Bearer business token)
   *   3. POST /<PHONE_NUMBER_ID>/register {messaging_product, pin} (new numbers only)
   * - https://developers.facebook.com/docs/whatsapp/embedded-signup/custom-flows/onboarding-business-app-users
   *   Business App numbers (Coexistence) skip register and start the one-time
   *   contacts and history syncs: POST /<PHONE_NUMBER_ID>/smb_app_data
   *   {messaging_product, sync_type: smb_app_state_sync | history}, within 24 hours.
   */

  /**
   * Exchanges the Embedded Signup code (valid for 30 seconds) for a business token.
   *
   * @param {{appId: string, appSecret: string, code: string, settings?: object, fetchImpl?: Function}} input
   * @returns {Promise<{ok: boolean, accessToken: string|null, code: string|null}>}
   */
  async exchangeCode({ appId, appSecret, code, settings = {}, fetchImpl }) {
    const base = settings.baseUrl || DEFAULT_BASE;
    const version = settings.graphVersion || DEFAULT_VERSION;
    const query = new URLSearchParams({ client_id: appId, client_secret: appSecret, code });
    const res = await request({
      url: `${base}/${version}/oauth/access_token?${query}`,
      method: 'GET',
      headers: { accept: 'application/json' },
      timeoutMs: 15_000,
      fetchImpl,
    });
    const token = res.outcome === 'accepted' ? res.json?.access_token : null;
    if (typeof token !== 'string' || !token) {
      return { ok: false, accessToken: null, code: res.outcome === 'accepted' ? 'NO_TOKEN' : classify(res).code };
    }
    return { ok: true, accessToken: token, code: null };
  },

  /**
   * Subscribes this app to the webhooks of the customer's WABA.
   *
   * @param {{config: object, settings?: object, fetchImpl?: Function}} input
   * @returns {Promise<{ok: boolean, code: string|null}>}
   */
  async subscribeApp({ config, settings, fetchImpl }) {
    const { base, version, headers } = endpoint(config, settings);
    const res = await request({
      url: `${base}/${version}/${encodeURIComponent(config.wabaId)}/subscribed_apps`,
      headers,
      timeoutMs: 15_000,
      fetchImpl,
    });
    return res.outcome === 'accepted' ? { ok: true, code: null } : { ok: false, code: classify(res).code };
  },

  /**
   * Registers a new Cloud API number with its two-step verification PIN.
   *
   * @param {{config: object, pin: string, settings?: object, fetchImpl?: Function}} input
   * @returns {Promise<{ok: boolean, code: string|null}>}
   */
  async registerNumber({ config, pin, settings, fetchImpl }) {
    const { base, version, headers } = endpoint(config, settings);
    const res = await request({
      url: `${base}/${version}/${encodeURIComponent(config.phoneNumberId)}/register`,
      headers,
      body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
      timeoutMs: 15_000,
      fetchImpl,
    });
    return res.outcome === 'accepted' ? { ok: true, code: null } : { ok: false, code: classify(res).code };
  },

  /**
   * Starts a one-time Business App sync (contacts or message history).
   *
   * @param {{config: object, syncType: 'smb_app_state_sync'|'history', settings?: object, fetchImpl?: Function}} input
   * @returns {Promise<{ok: boolean, code: string|null}>}
   */
  async startBusinessAppSync({ config, syncType, settings, fetchImpl }) {
    const { base, version, headers } = endpoint(config, settings);
    const res = await request({
      url: `${base}/${version}/${encodeURIComponent(config.phoneNumberId)}/smb_app_data`,
      headers,
      body: JSON.stringify({ messaging_product: 'whatsapp', sync_type: syncType }),
      timeoutMs: 15_000,
      fetchImpl,
    });
    return res.outcome === 'accepted' ? { ok: true, code: null } : { ok: false, code: classify(res).code };
  },
};
