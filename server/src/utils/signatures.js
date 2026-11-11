'use strict';

/**
 * Webhook signature checks for every provider. Each `verify*` function takes
 * the raw request body (Buffer, exactly as received) and returns a boolean;
 * comparisons are constant time. The matching `sign*` helpers produce the
 * same values and are used by tests and by the fake provider servers.
 *
 * Sources (read 2026-11-10):
 * - Meta: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(raw body, app secret)
 *   https://developers.facebook.com/docs/graph-api/webhooks/getting-started
 * - Telegram: header X-Telegram-Bot-Api-Secret-Token equals the secret_token
 *   given to setWebhook (1-256 chars, A-Z a-z 0-9 _ -)
 *   https://core.telegram.org/bots/api#setwebhook
 * - seven.io: X-Signature = HMAC-SHA256(signing key, timestamp \n nonce \n
 *   method \n url \n md5(body) [\n account id]), hex; X-Timestamp not older
 *   than 30 s; nonce unique. https://docs.seven.io/en/rest-api/signing
 * - Twilio: X-Twilio-Signature = base64(HMAC-SHA1(auth token, url +
 *   concatenation of sorted form keys and values)).
 *   https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
const crypto = require('crypto');

/**
 * @param {string|Buffer} a
 * @param {string|Buffer} b
 * @returns {boolean}
 */
function timingSafe(a, b) {
  const left = Buffer.isBuffer(a) ? a : Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.isBuffer(b) ? b : Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

/* ---------------------------------------------------------------- Meta */

/**
 * @param {Buffer} rawBody
 * @param {string} appSecret
 * @returns {string} Header value `sha256=<hex>`.
 */
function signMeta(rawBody, appSecret) {
  return `sha256=${crypto.createHmac('sha256', String(appSecret)).update(rawBody).digest('hex')}`;
}

/**
 * @param {Buffer} rawBody
 * @param {string|undefined} header - X-Hub-Signature-256
 * @param {string} appSecret
 * @returns {boolean}
 */
function verifyMeta(rawBody, header, appSecret) {
  if (!appSecret || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  if (!Buffer.isBuffer(rawBody)) return false;
  return timingSafe(signMeta(rawBody, appSecret), header.trim().toLowerCase());
}

/* ------------------------------------------------------------ Telegram */

/**
 * @param {string|undefined} header - X-Telegram-Bot-Api-Secret-Token
 * @param {string} secret
 * @returns {boolean}
 */
function verifyTelegram(header, secret) {
  if (!secret || typeof header !== 'string') return false;
  return timingSafe(header, secret);
}

/* ------------------------------------------------------------ seven.io */

/**
 * @param {{signingKey: string, timestamp: number|string, nonce: string, method: string, url: string, rawBody: Buffer, accountId?: string}} input
 * @returns {string} Lower-case hex signature.
 */
function signSeven({ signingKey, timestamp, nonce, method, url, rawBody, accountId }) {
  const bodyMd5 = crypto
    .createHash('md5')
    .update(rawBody || Buffer.alloc(0))
    .digest('hex');
  const lines = [String(timestamp), String(nonce), String(method).toUpperCase(), String(url), bodyMd5];
  if (accountId) lines.push(String(accountId));
  return crypto.createHmac('sha256', String(signingKey)).update(lines.join('\n')).digest('hex');
}

/**
 * @param {{signingKey: string, headers: Record<string, string|undefined>, method: string, url: string, rawBody: Buffer, now?: number, toleranceSeconds?: number}} input
 * @returns {{ok: boolean, nonce?: string, reason?: string}}
 */
function verifySeven({ signingKey, headers, method, url, rawBody, now = Date.now(), toleranceSeconds = 30 }) {
  if (!signingKey) return { ok: false, reason: 'no_key' };
  const signature = headers['x-signature'];
  const timestamp = Number(headers['x-timestamp']);
  const nonce = headers['x-nonce'];
  if (!signature || !Number.isFinite(timestamp) || typeof nonce !== 'string' || !/^[A-Za-z0-9]{8,128}$/.test(nonce)) {
    return { ok: false, reason: 'headers' };
  }
  const ageSeconds = now / 1000 - timestamp;
  if (ageSeconds > toleranceSeconds || ageSeconds < -toleranceSeconds) return { ok: false, reason: 'stale' };
  const expected = signSeven({
    signingKey,
    timestamp: headers['x-timestamp'],
    nonce,
    method,
    url,
    rawBody,
    accountId: headers['x-account-id'],
  });
  return timingSafe(expected, String(signature).toLowerCase())
    ? { ok: true, nonce }
    : { ok: false, reason: 'mismatch' };
}

/* -------------------------------------------------------------- Twilio */

/**
 * @param {string} url - The exact public URL Twilio called (with query string).
 * @param {Record<string, string|string[]>} params - Parsed form fields.
 * @param {string} authToken
 * @returns {string} Base64 signature.
 */
function signTwilio(url, params, authToken) {
  const data = Object.keys(params || {})
    .sort()
    .reduce((acc, key) => {
      const value = params[key];
      const values = Array.isArray(value) ? [...value].sort() : [value];
      return acc + values.map((v) => `${key}${v ?? ''}`).join('');
    }, String(url));
  return crypto.createHmac('sha1', String(authToken)).update(Buffer.from(data, 'utf8')).digest('base64');
}

/**
 * @param {string} url
 * @param {Record<string, string|string[]>} params
 * @param {string|undefined} header - X-Twilio-Signature
 * @param {string} authToken
 * @returns {boolean}
 */
function verifyTwilio(url, params, header, authToken) {
  if (!authToken || typeof header !== 'string') return false;
  return timingSafe(signTwilio(url, params, authToken), header);
}

module.exports = {
  timingSafe,
  signMeta,
  verifyMeta,
  verifyTelegram,
  signSeven,
  verifySeven,
  signTwilio,
  verifyTwilio,
};
