'use strict';

/**
 * Attachments for `send()`: one file per message, either from the Strapi
 * media library (`fileId`) or a public `https` URL.
 *
 * MessageGate never stores file content. A message keeps only a reference
 * (file id or URL, name, type) inside its encrypted payload; SMS (and
 * Telegram files that the Bot API cannot fetch by URL) get a short signed,
 * expiring download link instead of the file.
 *
 * Limits per channel (read 2026-11-11):
 * - WhatsApp: image/jpeg, image/png 5 MB; video/mp4 16 MB; application/pdf 100 MB
 *   https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media
 * - RCS (Twilio): jpeg, png, mp4, pdf, 16 MB
 *   https://www.twilio.com/docs/messaging/guides/accepted-mime-types
 * - Telegram by URL: photos 5 MB; sendDocument by URL only for .PDF and .ZIP, 20 MB
 *   https://core.telegram.org/bots/api#sending-files
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { z } = require('zod');
const { T } = require('../store/schema');
const { seal, tryOpen, safeEqual, hashValue } = require('../utils/crypto');
const { checkUrl } = require('../utils/url-guard');
const { MessageGateError } = require('../utils/errors');

const MB = 1024 * 1024;
const REF = 'attachment-ref';

/** MIME types MessageGate accepts at all, with the file extensions that match. */
const MIME = Object.freeze({
  'image/jpeg': { kind: 'image', ext: ['jpg', 'jpeg'] },
  'image/png': { kind: 'image', ext: ['png'] },
  'application/pdf': { kind: 'document', ext: ['pdf'] },
  'video/mp4': { kind: 'video', ext: ['mp4'] },
});

/** Size caps per channel and type (bytes). */
const LIMITS = Object.freeze({
  whatsapp: { 'image/jpeg': 5 * MB, 'image/png': 5 * MB, 'video/mp4': 16 * MB, 'application/pdf': 100 * MB },
  rcs: { 'image/jpeg': 16 * MB, 'image/png': 16 * MB, 'video/mp4': 16 * MB, 'application/pdf': 16 * MB },
  telegramPhoto: { 'image/jpeg': 5 * MB, 'image/png': 5 * MB },
  telegramDocument: { 'application/pdf': 20 * MB },
});

const attachmentSchema = z
  .object({
    fileId: z.number().int().positive().optional(),
    url: z.string().trim().max(2000).optional(),
    filename: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,119}$/)
      .optional(),
    mimeType: z.enum(Object.keys(MIME)).optional(),
  })
  .strict()
  .refine((a) => Boolean(a.fileId) !== Boolean(a.url), { message: 'fileId or url (exactly one)' });

/**
 * Checks the first bytes of a file against its declared type.
 *
 * @param {Buffer} head - At least 12 bytes.
 * @param {string} mime
 * @returns {boolean}
 */
function sniffMatches(head, mime) {
  if (!Buffer.isBuffer(head) || head.length < 4) return false;
  if (mime === 'image/jpeg') return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (mime === 'image/png')
    return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === 'application/pdf') return head.subarray(0, 5).toString('latin1') === '%PDF-';
  if (mime === 'video/mp4') return head.length >= 8 && head.subarray(4, 8).toString('latin1') === 'ftyp';
  return false;
}

/**
 * @param {string} name
 * @returns {string} Lower-case extension without the dot.
 */
const extOf = (name) =>
  String(name || '')
    .toLowerCase()
    .split('.')
    .pop();

/**
 * @param {import('./context').CoreContext} ctx
 */
function createAttachments(ctx) {
  const sandbox = ctx.config.providers.mode === 'sandbox';

  /**
   * Link signature: keyed HMAC-SHA256 (purpose `attachment-link`), 128 bits.
   *
   * @param {string} body
   * @returns {string}
   */
  const sign = (body) => hashValue(body, 'attachment-link', ctx.encryptionKey).slice(0, 32);

  /**
   * Reads the first bytes of a local media-library file.
   *
   * @param {object} file
   * @returns {Promise<Buffer|null>}
   */
  async function head(file) {
    const local = ctx.files?.localPath?.(file);
    if (!local) return null;
    let handle;
    try {
      handle = await fs.promises.open(local, 'r');
      const buffer = Buffer.alloc(16);
      const { bytesRead } = await handle.read(buffer, 0, 16, 0);
      return buffer.subarray(0, bytesRead);
    } catch {
      return null;
    } finally {
      await handle?.close();
    }
  }

  const api = {
    MIME,
    LIMITS,
    schema: attachmentSchema,

    /**
     * Validates an attachment reference and resolves it to a public URL.
     *
     * @param {object} input - `{ fileId } | { url, mimeType }`, optional `filename`.
     * @returns {Promise<{source: 'library'|'url', fileId: number|null, url: string, filename: string, mimeType: string, kind: string, size: number|null}>}
     * @throws {MessageGateError} ATTACHMENT_NOT_FOUND, ATTACHMENT_TYPE_NOT_ALLOWED, ATTACHMENT_TYPE_MISMATCH, ATTACHMENT_URL_INVALID
     */
    async resolve(input) {
      const parsed = attachmentSchema.safeParse(input);
      if (!parsed.success) {
        throw new MessageGateError('INVALID_REQUEST', undefined, {
          field: `attachment.${parsed.error.issues[0].path.join('.')}`.replace(/\.$/, ''),
        });
      }
      const a = parsed.data;
      if (a.fileId) {
        const file = ctx.files ? await ctx.files.get(a.fileId) : null;
        if (!file) throw new MessageGateError('ATTACHMENT_NOT_FOUND');
        const mimeType = String(file.mime || '').toLowerCase();
        if (!MIME[mimeType])
          throw new MessageGateError('ATTACHMENT_TYPE_NOT_ALLOWED', undefined, { mimeType: mimeType.slice(0, 60) });
        if (a.mimeType && a.mimeType !== mimeType) throw new MessageGateError('ATTACHMENT_TYPE_MISMATCH');
        const bytes = await head(file);
        if (bytes && !sniffMatches(bytes, mimeType)) throw new MessageGateError('ATTACHMENT_TYPE_MISMATCH');
        const raw = String(file.url || '');
        let url;
        if (/^https?:\/\//i.test(raw)) url = raw;
        else if (raw.startsWith('/') && ctx.publicUrl) url = `${ctx.publicUrl}${raw}`;
        else throw new MessageGateError('ATTACHMENT_URL_INVALID', undefined, { reason: 'no_public_url' });
        const filename = a.filename || String(file.name || `file.${MIME[mimeType].ext[0]}`).slice(0, 120);
        return {
          source: 'library',
          fileId: a.fileId,
          url,
          filename,
          mimeType,
          kind: MIME[mimeType].kind,
          size: Number.isFinite(Number(file.size)) ? Math.round(Number(file.size) * 1024) : null,
        };
      }
      const checked = checkUrl(a.url);
      if (!checked.ok) throw new MessageGateError('ATTACHMENT_URL_INVALID', undefined, { reason: checked.reason });
      const fromPath = decodeURIComponent(checked.url.pathname.split('/').pop() || '');
      const filename = a.filename || (/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,119}$/.test(fromPath) ? fromPath : 'file');
      const mimeType = a.mimeType || Object.keys(MIME).find((m) => MIME[m].ext.includes(extOf(fromPath)));
      if (!mimeType) throw new MessageGateError('ATTACHMENT_TYPE_NOT_ALLOWED');
      const ext = extOf(filename);
      if (filename.includes('.') && !MIME[mimeType].ext.includes(ext))
        throw new MessageGateError('ATTACHMENT_TYPE_MISMATCH');
      return {
        source: 'url',
        fileId: null,
        url: checked.url.toString(),
        filename,
        mimeType,
        kind: MIME[mimeType].kind,
        size: null,
      };
    },

    /**
     * How a channel carries a resolved attachment.
     *
     * @param {string} channel
     * @param {object} file - Result of `resolve`.
     * @returns {{mode: 'media'|'photo'|'document'|'link'}|{mode: 'unsupported', code: string}}
     */
    plan(channel, file) {
      const within = (limits) => limits[file.mimeType] && (file.size === null || file.size <= limits[file.mimeType]);
      if (channel === 'whatsapp' || channel === 'rcs') {
        const limits = LIMITS[channel];
        if (!limits[file.mimeType]) return { mode: 'unsupported', code: 'ATTACHMENT_TYPE_NOT_ALLOWED' };
        if (!within(limits)) return { mode: 'unsupported', code: 'ATTACHMENT_TOO_LARGE' };
        return { mode: 'media' };
      }
      if (channel === 'telegram') {
        if (within(LIMITS.telegramPhoto)) return { mode: 'photo' };
        if (within(LIMITS.telegramDocument)) return { mode: 'document' };
        return { mode: 'link' };
      }
      return { mode: 'link' };
    },

    /**
     * Creates a signed, expiring download link. Only the reference is
     * stored (encrypted); the token is never stored, only verified.
     *
     * @param {object} file - Result of `resolve`.
     * @param {number} ttlHours
     * @param {{dryRun?: boolean}} [options]
     * @returns {Promise<string>} Absolute URL.
     */
    async createLink(file, ttlHours, { dryRun = false } = {}) {
      if (dryRun) return `${ctx.publicUrl}/api/magic-messagegate/files/<signed-link>`;
      const ref = {
        source: file.source,
        fileId: file.fileId,
        url: file.url,
        filename: file.filename,
        mimeType: file.mimeType,
      };
      return (await api.createRefLink(ref, ttlHours * 3_600_000)).url;
    },

    /**
     * Signed link for any stored reference (attachments, inbound media).
     *
     * @param {object} ref
     * @param {number} ttlMs
     * @returns {Promise<{url: string, expiresAt: number}>}
     */
    async createRefLink(ref, ttlMs) {
      const id = crypto.randomBytes(12).toString('base64url');
      const exp = Math.floor((ctx.now() + ttlMs) / 1000);
      await ctx.knex(T.attachmentLinks).insert({
        link_id: id,
        ref_sealed: seal(ref, REF, ctx.encryptionKey),
        expires_at: exp * 1000,
        created_at: ctx.now(),
      });
      return {
        url: `${ctx.publicUrl}/api/magic-messagegate/files/${id}.${exp}.${sign(`${id}.${exp}`)}`,
        expiresAt: exp * 1000,
      };
    },

    /**
     * Verifies a download token and returns the stored reference. Every
     * failure returns null (one answer for all cases, no enumeration).
     *
     * @param {string} token
     * @returns {Promise<object|null>}
     */
    async openLink(token) {
      const match = /^([A-Za-z0-9_-]{16})\.(\d{9,11})\.([0-9a-f]{32})$/.exec(String(token || ''));
      if (!match) return null;
      const [, id, exp, signature] = match;
      if (!safeEqual(sign(`${id}.${exp}`), signature)) return null;
      if (Number(exp) * 1000 <= ctx.now()) return null;
      const row = await ctx.knex(T.attachmentLinks).where('link_id', id).first();
      if (!row || Number(row.expires_at) <= ctx.now()) return null;
      return tryOpen(row.ref_sealed, REF, ctx.encryptionKey);
    },

    /**
     * Where the download route gets the bytes from.
     *
     * @param {object} ref - Stored reference.
     * @returns {Promise<{type: 'file', path: string, mimeType: string, filename: string}|{type: 'redirect', url: string}|{type: 'inbound', inboundId: string}|null>}
     */
    async source(ref) {
      if (!ref) return null;
      if (ref.source === 'inbound') return { type: 'inbound', inboundId: String(ref.inboundId) };
      if (ref.source === 'library') {
        const file = ctx.files ? await ctx.files.get(ref.fileId) : null;
        if (!file || String(file.mime).toLowerCase() !== ref.mimeType) return null;
        const local = ctx.files.localPath?.(file);
        if (local) return { type: 'file', path: local, mimeType: ref.mimeType, filename: ref.filename };
        return /^https:\/\//i.test(String(file.url)) ? { type: 'redirect', url: String(file.url) } : null;
      }
      const checked = checkUrl(ref.url);
      return checked.ok ? { type: 'redirect', url: checked.url.toString() } : null;
    },

    /**
     * Reads a media-library file for a template sample upload (size capped).
     *
     * @param {number} fileId
     * @param {number} maxBytes
     * @returns {Promise<{bytes: Buffer, mimeType: string, filename: string}>}
     */
    async readSample(fileId, maxBytes) {
      const file = ctx.files ? await ctx.files.get(fileId) : null;
      if (!file) throw new MessageGateError('ATTACHMENT_NOT_FOUND');
      const mimeType = String(file.mime || '').toLowerCase();
      if (!MIME[mimeType]) throw new MessageGateError('ATTACHMENT_TYPE_NOT_ALLOWED');
      if (Number(file.size) * 1024 > maxBytes) throw new MessageGateError('ATTACHMENT_TOO_LARGE');
      const filename = String(file.name || 'sample').slice(0, 120);
      const local = ctx.files.localPath?.(file);
      let bytes;
      if (local) {
        bytes = await fs.promises.readFile(local);
      } else if (sandbox) {
        bytes = Buffer.from('%PDF-1.4 sandbox sample');
      } else {
        bytes = await ctx.files.fetchRemote(String(file.url), maxBytes);
      }
      if (!bytes || bytes.length > maxBytes) throw new MessageGateError('ATTACHMENT_TOO_LARGE');
      if (!sandbox && !sniffMatches(bytes.subarray(0, 16), mimeType))
        throw new MessageGateError('ATTACHMENT_TYPE_MISMATCH');
      return { bytes, mimeType, filename };
    },
  };
  return api;
}

/**
 * Resolves a media-library file to a path inside `<public>/uploads`, or null
 * when the file lives on a remote upload provider.
 *
 * @param {string} publicDir - `strapi.dirs.static.public`.
 * @param {object} file - Upload file row.
 * @returns {string|null}
 */
function localUploadPath(publicDir, file) {
  const url = String(file?.url || '');
  if (!publicDir || !url.startsWith('/uploads/') || url.includes('..')) return null;
  const root = path.resolve(publicDir, 'uploads');
  const full = path.resolve(publicDir, `.${decodeURIComponent(url.split('?')[0])}`);
  return full.startsWith(root + path.sep) ? full : null;
}

module.exports = { createAttachments, attachmentSchema, sniffMatches, localUploadPath, MIME, LIMITS };
