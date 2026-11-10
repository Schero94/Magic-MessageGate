'use strict';

/**
 * Secret handling for MessageGate.
 *
 * - `seal` / `open`: AES-256-GCM authenticated encryption of JSON values.
 *   Each value gets a fresh 12-byte IV; the key is derived with HKDF-SHA256
 *   from the master key and a per-purpose label, so a ciphertext from one
 *   column can never be replayed into another (the purpose is also bound as
 *   additional authenticated data).
 * - `hashValue`: keyed HMAC-SHA256 for lookups and logs (phone numbers,
 *   idempotency keys) so raw values never appear in indexes or log lines.
 *
 * Master key: `MESSAGEGATE_ENCRYPTION_KEY` (any string, at least 32 chars
 * recommended) or, as a fallback, the host's `APP_KEYS`. Node's built-in
 * `crypto` module only; no third-party crypto.
 *
 * @see https://nodejs.org/api/crypto.html#cryptohkdfsyncdigest-ikm-salt-info-keylen
 */
const crypto = require('crypto');

const VERSION = 'g1';
const keyCache = new Map();

/**
 * Resolves the master key material from config or the environment.
 *
 * @param {string|undefined} configured - `encryptionKey` plugin config value.
 * @returns {Buffer}
 * @throws {Error} When no key material is available.
 */
function masterKey(configured) {
  const raw =
    configured || process.env.MESSAGEGATE_ENCRYPTION_KEY || process.env.APP_KEYS || process.env.ADMIN_JWT_SECRET;
  if (!raw || String(raw).length < 16) {
    throw new Error('MessageGate needs MESSAGEGATE_ENCRYPTION_KEY (or APP_KEYS) with at least 16 characters');
  }
  return Buffer.from(String(raw), 'utf8');
}

/**
 * Derives (and caches) a 32-byte key for a purpose.
 *
 * @param {string} purpose
 * @param {string} [configured]
 * @returns {Buffer}
 */
function derive(purpose, configured) {
  const id = `${purpose}\u0000${configured || ''}`;
  if (!keyCache.has(id)) {
    const ikm = masterKey(configured);
    const key = Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.from('magic-messagegate'), purpose, 32));
    keyCache.set(id, key);
  }
  return keyCache.get(id);
}

/**
 * Encrypts a JSON-serialisable value.
 *
 * @param {*} value
 * @param {string} purpose - Label such as `account-config` or `contact-phone`.
 * @param {string} [configured] - Optional configured master key.
 * @returns {string} `g1:<iv>:<tag>:<ciphertext>` (base64url parts).
 */
function seal(value, purpose, configured) {
  const key = derive(purpose, configured);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(purpose));
  const body = Buffer.concat([cipher.update(JSON.stringify(value ?? null), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), body.toString('base64url')].join(':');
}

/**
 * Decrypts a value written by `seal`.
 *
 * @param {string|null|undefined} sealed
 * @param {string} purpose
 * @param {string} [configured]
 * @returns {*} The original value, or null for empty input.
 * @throws {Error} On tampering, a wrong key or a wrong purpose.
 */
function open(sealed, purpose, configured) {
  if (sealed === null || sealed === undefined || sealed === '') return null;
  const parts = String(sealed).split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('Unsupported ciphertext format');
  const key = derive(purpose, configured);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64url'));
  decipher.setAAD(Buffer.from(purpose));
  decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
  const plain = Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

/**
 * Like `open`, but returns `fallback` when the value cannot be decrypted
 * (changed key, tampering). Used where a broken value must not break a list.
 *
 * @param {string|null|undefined} sealed
 * @param {string} purpose
 * @param {string} [configured]
 * @param {*} [fallback]
 * @returns {*}
 */
function tryOpen(sealed, purpose, configured, fallback = null) {
  try {
    return open(sealed, purpose, configured) ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Keyed hash for lookups and logs.
 *
 * @param {string} value
 * @param {string} purpose
 * @param {string} [configured]
 * @returns {string} 64 hex characters.
 */
function hashValue(value, purpose, configured) {
  return crypto
    .createHmac('sha256', derive(`hash:${purpose}`, configured))
    .update(String(value))
    .digest('hex');
}

/**
 * Short, non-reversible prefix for log lines.
 *
 * @param {string} hash
 * @returns {string}
 */
function logRef(hash) {
  return typeof hash === 'string' ? hash.slice(0, 10) : '-';
}

/**
 * Random URL-safe token.
 *
 * @param {number} [bytes]
 * @returns {string}
 */
function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/**
 * Constant-time string comparison that also hides length differences.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
  const left = crypto
    .createHash('sha256')
    .update(String(a ?? ''))
    .digest();
  const right = crypto
    .createHash('sha256')
    .update(String(b ?? ''))
    .digest();
  return crypto.timingSafeEqual(left, right) && String(a ?? '').length === String(b ?? '').length;
}

/** Clears derived keys (tests and key rotation). */
function resetKeyCache() {
  keyCache.clear();
}

module.exports = { seal, open, tryOpen, hashValue, logRef, randomToken, safeEqual, resetKeyCache };
