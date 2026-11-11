'use strict';

/**
 * Inbound messages: storage, the `messagegate.message.received` event, reply
 * context, inbound media downloads and access for app code.
 *
 * - Every webhook message is stored once: `provider_key` is unique, so only
 *   the process whose insert wins emits the event (exactly once across
 *   processes, also when a provider retries the webhook).
 * - Text, captions, button titles, locations and provider media references
 *   are sealed (AES-256-GCM, purpose `inbound-content`) like phone numbers.
 * - Media is downloaded by a worker job (claimed with a lease like the
 *   outbox), checked (size while streaming, MIME allow-list, magic bytes,
 *   optional scan hook), stripped of JPEG/PNG location metadata and stored in
 *   the Strapi media library, or not at all (`inboundMedia.storage: 'none'`).
 */
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { T } = require('../store/schema');
const { affected } = require('../store/coordination');
const { seal, tryOpen } = require('../utils/crypto');
const { MessageGateError } = require('../utils/errors');
const filetype = require('../utils/filetype');
const { newId } = require('./context');

const CONTENT = 'inbound-content';
const MEDIA_REF = 'inbound-media-ref';
const KINDS = ['text', 'button', 'media', 'location', 'other'];
const MEDIA_RETRY_MS = [60_000, 300_000, 900_000, 3_600_000];
/** How long a provider keeps inbound media retrievable (see adapters). */
const MEDIA_WINDOW_MS = { meta: 7 * 86_400_000, telegram: 86_400_000, twilio: 7 * 86_400_000, sandbox: 3_600_000 };

/**
 * @param {import('./context').CoreContext} ctx
 * @param {{settings: object, accounts: object, contacts: object, attachments: object}} deps
 */
function createInbound(ctx, deps) {
  /** @type {null|((file: {bytes: Buffer, mime: string, size: number, filename: string, inboundId: string}) => Promise<'clean'|'infected'>)} */
  let scanner = null;

  const open = (row) => tryOpen(row.content_sealed, CONTENT, ctx.encryptionKey, {}) || {};

  /**
   * @param {object} row
   * @param {{withContent?: boolean, contact?: object|null, replyTo?: string|null}} [extra]
   * @returns {object}
   */
  function toDto(row, { withContent = true, contact = null, replyTo = null } = {}) {
    const content = withContent ? open(row) : {};
    const phone = contact ? deps.contacts.phoneOf(contact) : null;
    const dto = {
      id: row.document_id,
      channel: row.channel,
      kind: row.kind,
      contactId: contact?.document_id ?? null,
      contact: contact
        ? {
            id: contact.document_id,
            phoneMasked: phone ? `${phone.slice(0, 4)}•••${phone.slice(-2)}` : null,
            userId: contact.user_id ?? null,
          }
        : null,
      replyTo,
      buttonPayload: row.button_payload || null,
      receivedAt: Number(row.received_at),
      processedAt: row.processed_at ? Number(row.processed_at) : null,
      media:
        row.media_status === 'none'
          ? null
          : {
              status: row.media_status,
              code: row.media_code || null,
              fileId: row.media_file_id ?? null,
              mime: row.media_mime || null,
              size: row.media_size ? Number(row.media_size) : null,
              filename: content.filename || null,
              caption: withContent ? content.caption || null : undefined,
              duration: content.duration ?? null,
            },
    };
    if (withContent) {
      dto.text = content.text ?? null;
      dto.buttonTitle = content.buttonTitle ?? null;
      dto.location = content.location ?? null;
    }
    return dto;
  }

  /**
   * @param {number|null} messageId
   * @returns {Promise<string|null>} Outbound message document id.
   */
  async function messageDocId(messageId) {
    if (!messageId) return null;
    const row = await ctx.knex(T.messages).where('id', messageId).first('document_id');
    return row?.document_id || null;
  }

  /**
   * Finds the outbound message an inbound one answers.
   *
   * @param {object} input
   * @param {object|null} contact
   * @returns {Promise<number|null>}
   */
  async function replyTarget(input, contact) {
    if (input.replyProviderId) {
      const row = await ctx
        .knex(T.messages)
        .where('provider_message_id', String(input.replyProviderId).slice(0, 128))
        .first('id');
      if (row) return row.id;
    }
    if (input.replyMessageDocumentId) {
      const row = await ctx
        .knex(T.messages)
        .where('document_id', String(input.replyMessageDocumentId).slice(0, 32))
        .first('id');
      if (row) return row.id;
    }
    if (!contact || !['sms', 'rcs'].includes(input.channel)) return null;
    const settings = await deps.settings.get();
    const since = input.at - settings.inbound.replyWindowHours * 3_600_000;
    const row = await ctx
      .knex(T.messages)
      .where({ contact_id: contact.id, channel: input.channel })
      .whereNotNull('sent_at')
      .andWhere('sent_at', '>=', since)
      .orderBy('sent_at', 'desc')
      .first('id');
    return row ? row.id : null;
  }

  /**
   * @param {object} row
   * @param {object} values
   * @returns {Promise<boolean>}
   */
  async function fencedMedia(row, values) {
    const result = await ctx.knex(T.inbound).where({ id: row.id, media_lease: row.media_lease }).update(values);
    return affected(result) === 1;
  }

  /**
   * Ends a media job as failed (exactly once: fenced by the lease).
   *
   * @param {object} row
   * @param {string} code
   * @returns {Promise<void>}
   */
  async function mediaFailed(row, code) {
    const ok = await fencedMedia(row, {
      media_status: 'failed',
      media_code: code,
      media_lease: null,
      media_lease_until: null,
      media_ref_sealed: null,
    });
    if (ok) ctx.emit('messagegate.media.failed', { inboundId: row.document_id, code, at: ctx.now() });
  }

  /**
   * Downloads, checks and stores the media of one claimed inbound row.
   *
   * @param {object} row - claimed (media_lease set)
   * @returns {Promise<string>} resulting media status
   */
  async function processMedia(row) {
    const settings = await deps.settings.get();
    const now = ctx.now();
    const ref = tryOpen(row.media_ref_sealed, MEDIA_REF, ctx.encryptionKey);
    if (!ref) {
      await mediaFailed(row, 'MEDIA_EXPIRED');
      return 'failed';
    }
    if (Number(row.media_deadline) <= now) {
      await mediaFailed(row, 'MEDIA_EXPIRED');
      return 'failed';
    }
    const maxBytes = settings.inboundMedia.maxMb * 1024 * 1024;
    const declared = filetype.baseMime(ref.mime);
    if (declared && !settings.inboundMedia.allowedTypes.includes(declared)) {
      await mediaFailed(row, 'MEDIA_TYPE_BLOCKED');
      return 'failed';
    }
    if (Number(ref.size) > maxBytes) {
      await mediaFailed(row, 'MEDIA_TOO_LARGE');
      return 'failed';
    }
    let result;
    try {
      if (ref.provider === 'sandbox') {
        result = await ctx.adapter('telegram').downloadMedia({ ref, maxBytes });
        if (ctx.config.providers.mode !== 'sandbox') result = { ok: false, code: 'MEDIA_REF_INVALID' };
      } else {
        const account = row.account_id ? await deps.accounts.getRowById(row.account_id) : null;
        if (!account) {
          await mediaFailed(row, 'NO_ACCOUNT');
          return 'failed';
        }
        result = await ctx.adapter(account.provider).downloadMedia({
          config: deps.accounts.configOf(account),
          ref,
          maxBytes,
          settings: ctx.config.providers[account.provider] || {},
          fetchImpl: ctx.fetchImpl,
        });
      }
    } catch {
      result = { ok: false, code: 'MEDIA_FETCH_FAILED' };
    }
    const permanent = new Set(['MEDIA_TOO_LARGE', 'MEDIA_EXPIRED', 'MEDIA_HOST_REFUSED', 'MEDIA_REF_INVALID']);
    if (!result.ok) {
      const attempts = Number(row.media_attempts) + 1;
      const next = now + MEDIA_RETRY_MS[Math.min(attempts - 1, MEDIA_RETRY_MS.length - 1)];
      if (permanent.has(result.code) || attempts >= 5 || next >= Number(row.media_deadline)) {
        await mediaFailed(row, result.code || 'MEDIA_FETCH_FAILED');
        return 'failed';
      }
      await fencedMedia(row, {
        media_attempts: attempts,
        media_next_at: next,
        media_code: result.code,
        media_lease: null,
        media_lease_until: null,
      });
      return 'pending';
    }
    const mime = declared || filetype.baseMime(result.mime);
    if (!mime || !settings.inboundMedia.allowedTypes.includes(mime)) {
      await mediaFailed(row, 'MEDIA_TYPE_BLOCKED');
      return 'failed';
    }
    if (!filetype.matchesType(result.bytes, mime)) {
      await mediaFailed(row, 'MEDIA_TYPE_MISMATCH');
      return 'failed';
    }
    if (result.bytes.length > maxBytes) {
      await mediaFailed(row, 'MEDIA_TOO_LARGE');
      return 'failed';
    }
    const bytes = filetype.stripMetadata(result.bytes, mime);
    const filename = filetype.safeFilename(open(row).filename || `${row.channel}-${row.document_id}`, mime);
    if (scanner) {
      let verdict;
      try {
        verdict = await scanner({ bytes, mime, size: bytes.length, filename, inboundId: row.document_id });
      } catch {
        verdict = 'error';
      }
      if (verdict === 'infected') {
        await mediaFailed(row, 'MEDIA_INFECTED');
        return 'failed';
      }
      if (verdict !== 'clean') {
        // The file stays in quarantine (not stored) until the scanner answers.
        await fencedMedia(row, {
          media_status: 'quarantined',
          media_next_at: now + 300_000,
          media_lease: null,
          media_lease_until: null,
        });
        return 'quarantined';
      }
    }
    let fileId = null;
    if (settings.inboundMedia.storage === 'media-library') {
      if (!ctx.files?.store) {
        await mediaFailed(row, 'MEDIA_STORAGE_UNAVAILABLE');
        return 'failed';
      }
      try {
        fileId = await ctx.files.store({ bytes, mime, filename });
      } catch {
        await fencedMedia(row, {
          media_attempts: Number(row.media_attempts) + 1,
          media_next_at: now + 60_000,
          media_code: 'MEDIA_STORAGE_FAILED',
          media_lease: null,
          media_lease_until: null,
        });
        return 'pending';
      }
    }
    const ok = await fencedMedia(row, {
      media_status: 'ready',
      media_code: null,
      media_mime: mime,
      media_size: bytes.length,
      media_file_id: fileId,
      media_lease: null,
      media_lease_until: null,
      media_ref_sealed: null,
    });
    if (!ok) {
      // Lost the lease meanwhile: remove our copy, the other holder decides.
      if (fileId) await ctx.files.remove(fileId).catch(() => {});
      return 'lost';
    }
    ctx.emit('messagegate.media.ready', {
      inboundId: row.document_id,
      fileId,
      mime,
      size: bytes.length,
      at: ctx.now(),
    });
    return 'ready';
  }

  /**
   * Loads a ready media file from storage.
   *
   * @param {object} row
   * @returns {Promise<{bytes: Buffer, mime: string, size: number, filename: string, caption: string|null}>}
   */
  async function mediaBytes(row) {
    if (row.media_status === 'none') throw new MessageGateError('NOT_FOUND', 'This message has no media');
    if (row.media_status !== 'ready') {
      throw new MessageGateError('MEDIA_NOT_READY', undefined, { status: row.media_status, code: row.media_code });
    }
    if (!row.media_file_id) throw new MessageGateError('MEDIA_NOT_STORED');
    const bytes = await ctx.files.read(row.media_file_id, Number(row.media_size) + 1024);
    if (!bytes) throw new MessageGateError('MEDIA_NOT_STORED');
    const content = open(row);
    return {
      bytes,
      mime: row.media_mime,
      size: bytes.length,
      filename: filetype.safeFilename(content.filename || `${row.channel}-${row.document_id}`, row.media_mime),
      caption: content.caption || null,
    };
  }

  const api = {
    KINDS,
    toDto,

    /**
     * Stores one inbound message (deduplicated) and emits the event.
     *
     * @param {object} input
     * @param {string} input.provider - meta | telegram | twilio | seven | sandbox
     * @param {string} input.providerMessageId
     * @param {string} input.channel
     * @param {object|null} input.contact - contact row
     * @param {object|null} [input.account] - account row
     * @param {'text'|'button'|'media'|'location'|'other'} input.kind
     * @param {string} [input.text]
     * @param {string} [input.buttonPayload]
     * @param {string} [input.buttonTitle]
     * @param {{ref: object, mime?: string, filename?: string, caption?: string, size?: number, duration?: number}} [input.media]
     * @param {{latitude: number, longitude: number, name?: string, address?: string}} [input.location]
     * @param {string} [input.replyProviderId] - provider id of the outbound message this answers
     * @param {string} [input.replyMessageDocumentId] - our message id (sandbox)
     * @param {number} input.at
     * @returns {Promise<object|null>} The stored row, or null for a duplicate.
     */
    async record(input) {
      const now = ctx.now();
      const content = {};
      if (input.text) content.text = String(input.text).slice(0, 4096);
      if (input.buttonTitle) content.buttonTitle = String(input.buttonTitle).slice(0, 256);
      if (input.location) content.location = input.location;
      if (input.media?.caption) content.caption = String(input.media.caption).slice(0, 1024);
      if (input.media?.filename) content.filename = String(input.media.filename).slice(0, 200);
      if (Number.isFinite(Number(input.media?.duration))) content.duration = Number(input.media.duration);
      const settings = await deps.settings.get();
      const mediaStatus = input.media ? (settings.inboundMedia.storage === 'none' ? 'skipped' : 'pending') : 'none';
      const replyTo = await replyTarget(input, input.contact);
      const row = {
        document_id: newId(),
        provider_key: `${input.provider}:${input.providerMessageId}`.slice(0, 191),
        contact_id: input.contact?.id ?? null,
        account_id: input.account?.id ?? null,
        channel: input.channel,
        kind: KINDS.includes(input.kind) ? input.kind : 'other',
        content_sealed: Object.keys(content).length ? seal(content, CONTENT, ctx.encryptionKey) : null,
        button_payload: input.buttonPayload ? String(input.buttonPayload).slice(0, 256) : null,
        reply_to_message_id: replyTo,
        media_status: mediaStatus,
        media_ref_sealed:
          mediaStatus === 'pending'
            ? seal({ ...input.media.ref, mime: input.media.mime, size: input.media.size }, MEDIA_REF, ctx.encryptionKey)
            : null,
        media_mime: input.media?.mime ? filetype.baseMime(input.media.mime).slice(0, 120) : null,
        media_size: Number.isFinite(Number(input.media?.size)) ? Number(input.media.size) : null,
        media_attempts: 0,
        media_next_at: mediaStatus === 'pending' ? now : null,
        media_deadline: mediaStatus === 'pending' ? input.at + (MEDIA_WINDOW_MS[input.provider] || 86_400_000) : null,
        received_at: input.at,
        created_at: now,
      };
      try {
        await ctx.knex(T.inbound).insert(row);
      } catch {
        // Unique provider_key: another process (or a provider retry) stored it.
        return null;
      }
      const saved = await ctx.knex(T.inbound).where('document_id', row.document_id).first();
      ctx.emit('messagegate.message.received', {
        inboundId: saved.document_id,
        contactId: input.contact?.document_id ?? null,
        channel: saved.channel,
        replyTo: await messageDocId(replyTo),
        kind: saved.kind,
        ...(saved.button_payload ? { buttonPayload: saved.button_payload } : {}),
        ...(mediaStatus !== 'none' ? { media: { status: mediaStatus } } : {}),
        at: Number(saved.received_at),
      });
      return saved;
    },

    /**
     * @param {string} documentId
     * @returns {Promise<object|null>}
     */
    async getRow(documentId) {
      return (await ctx.knex(T.inbound).where('document_id', String(documentId).slice(0, 32)).first()) || null;
    },

    /**
     * One inbound message with decrypted text, masked phone and linked user.
     *
     * @param {string} documentId
     * @returns {Promise<object>}
     * @throws {MessageGateError} NOT_FOUND
     */
    async get(documentId) {
      const row = await api.getRow(documentId);
      if (!row) throw new MessageGateError('NOT_FOUND');
      const contact = row.contact_id ? await deps.contacts.getRowById(row.contact_id) : null;
      return toDto(row, { contact, replyTo: await messageDocId(row.reply_to_message_id) });
    },

    /**
     * Paginated list, newest first.
     *
     * @param {{page?: number, pageSize?: number, channel?: string, contactId?: string, kind?: string, processed?: boolean, unread?: boolean, from?: number, to?: number}} [query]
     * @returns {Promise<{results: object[], pagination: object}>}
     */
    async list(query = {}) {
      const page = Math.max(1, Math.min(Number(query.page) || 1, 2000));
      const pageSize = Math.max(1, Math.min(Number(query.pageSize) || 25, 100));
      const q = ctx.knex(T.inbound);
      if (query.channel) q.where('channel', query.channel);
      if (query.kind) q.where('kind', query.kind);
      if (query.processed === true) q.whereNotNull('processed_at');
      if (query.processed === false) q.whereNull('processed_at');
      if (query.unread === true) q.whereNull('seen_at');
      if (query.from) q.where('received_at', '>=', Number(query.from));
      if (query.to) q.where('received_at', '<', Number(query.to));
      if (query.contactId) {
        const contact = await deps.contacts.getRow(query.contactId);
        q.where('contact_id', contact ? contact.id : -1);
      }
      const [{ total }] = await q.clone().count({ total: '*' });
      const rows = await q
        .orderBy('id', 'desc')
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      const contactIds = [...new Set(rows.map((r) => r.contact_id).filter((v) => v != null))];
      const contacts = contactIds.length ? await ctx.knex(T.contacts).whereIn('id', contactIds) : [];
      const messageIds = rows.map((r) => r.reply_to_message_id).filter(Boolean);
      const replies = messageIds.length
        ? await ctx.knex(T.messages).whereIn('id', messageIds).select('id', 'document_id')
        : [];
      return {
        results: rows.map((r) =>
          toDto(r, {
            contact: contacts.find((c) => c.id === r.contact_id) || null,
            replyTo: replies.find((m) => m.id === r.reply_to_message_id)?.document_id || null,
          })
        ),
        pagination: { page, pageSize, total: Number(total), pageCount: Math.ceil(Number(total) / pageSize) },
      };
    },

    /**
     * Counts inbound messages an admin has not opened yet.
     *
     * @returns {Promise<number>}
     */
    async unreadCount() {
      const [{ total }] = await ctx.knex(T.inbound).whereNull('seen_at').count({ total: '*' });
      return Number(total);
    },

    /**
     * Marks inbound messages of a contact as seen in the admin inbox.
     *
     * @param {number} contactId
     * @returns {Promise<void>}
     */
    async markSeen(contactId) {
      await ctx.knex(T.inbound).where('contact_id', contactId).whereNull('seen_at').update({ seen_at: ctx.now() });
    },

    /**
     * Marks a message as processed by app code (idempotent workers). Only
     * the first call sets the time; `alreadyProcessed` tells later callers.
     *
     * @param {string} documentId
     * @returns {Promise<{id: string, processedAt: number, alreadyProcessed: boolean}>}
     */
    async markProcessed(documentId) {
      const row = await api.getRow(documentId);
      if (!row) throw new MessageGateError('NOT_FOUND');
      const now = ctx.now();
      const won = affected(
        await ctx.knex(T.inbound).where('id', row.id).whereNull('processed_at').update({ processed_at: now })
      );
      const fresh = await api.getRow(documentId);
      return { id: fresh.document_id, processedAt: Number(fresh.processed_at), alreadyProcessed: won !== 1 };
    },

    /**
     * Media of an inbound message for app code.
     *
     * @param {string} documentId
     * @param {{as?: 'buffer'|'stream'|'base64'}} [options]
     * @returns {Promise<{data: Buffer|import('stream').Readable|string, mime: string, size: number, filename: string, caption: string|null}>}
     * @throws {MessageGateError} NOT_FOUND, MEDIA_NOT_READY, MEDIA_NOT_STORED
     */
    async getMedia(documentId, { as = 'buffer' } = {}) {
      const row = await api.getRow(documentId);
      if (!row) throw new MessageGateError('NOT_FOUND');
      const file = await mediaBytes(row);
      const data =
        as === 'base64' ? file.bytes.toString('base64') : as === 'stream' ? Readable.from(file.bytes) : file.bytes;
      return { data, mime: file.mime, size: file.size, filename: file.filename, caption: file.caption };
    },

    /**
     * A short-lived signed https URL for one inbound file (for services
     * that fetch files by URL). Anyone holding the URL can download the file
     * until it expires, so keep the TTL short.
     *
     * @param {string} documentId
     * @param {{ttlSeconds?: number}} [options] - 30 … 3600, default 300.
     * @returns {Promise<{url: string, expiresAt: number}>}
     */
    async createMediaUrl(documentId, { ttlSeconds = 300 } = {}) {
      const row = await api.getRow(documentId);
      if (!row) throw new MessageGateError('NOT_FOUND');
      if (row.media_status !== 'ready' || !row.media_file_id) {
        throw new MessageGateError('MEDIA_NOT_READY', undefined, { status: row.media_status });
      }
      const ttl = Math.max(30, Math.min(Number(ttlSeconds) || 300, 3600));
      return deps.attachments.createRefLink({ source: 'inbound', inboundId: row.document_id }, ttl * 1000);
    },

    /** Bytes for the signed download route. */
    mediaForLink: async (documentId) => {
      const row = await api.getRow(documentId);
      return row ? mediaBytes(row) : null;
    },

    /**
     * Registers a virus scanner. Files stay quarantined (not stored) until
     * it answers 'clean'; 'infected' drops them with MEDIA_INFECTED.
     *
     * @param {(file: {bytes: Buffer, mime: string, size: number, filename: string, inboundId: string}) => Promise<'clean'|'infected'>} fn
     */
    onMediaScan(fn) {
      scanner = typeof fn === 'function' ? fn : null;
    },

    /**
     * Claims due media jobs (lease per row, safe across processes).
     *
     * @param {number} limit
     * @returns {Promise<object[]>}
     */
    async claimMedia(limit) {
      const now = ctx.now();
      const lease = crypto.randomBytes(16).toString('hex');
      const candidates = await ctx
        .knex(T.inbound)
        .whereIn('media_status', ['pending', 'quarantined'])
        .andWhere('media_next_at', '<=', now)
        .andWhere((q) => q.whereNull('media_lease_until').orWhere('media_lease_until', '<', now))
        .orderBy('id')
        .limit(limit)
        .select('id', 'media_lease');
      const won = [];
      for (const c of candidates) {
        const q = ctx.knex(T.inbound).where({ id: c.id });
        if (c.media_lease) q.andWhere('media_lease', c.media_lease);
        else q.whereNull('media_lease');
        const ok = affected(await q.update({ media_lease: lease, media_lease_until: now + 120_000 }));
        if (ok === 1) won.push(c.id);
      }
      if (!won.length) return [];
      return ctx.knex(T.inbound).whereIn('id', won).andWhere('media_lease', lease);
    },

    processMedia,

    /**
     * One media worker round.
     *
     * @returns {Promise<string[]>}
     */
    async mediaTick() {
      const rows = await api.claimMedia(5);
      const results = [];
      for (const row of rows) {
        try {
          results.push(await processMedia(row));
        } catch (error) {
          ctx.log.error(`[magic-messagegate] media job failed: ${error?.name || 'Error'}`);
          results.push('error');
        }
      }
      return results;
    },

    /**
     * Inbound and outbound messages of a contact in time order.
     *
     * @param {string|{inboundId: string}} ref - contact document id or `{ inboundId }`
     * @param {{limit?: number, since?: number, includeMedia?: boolean}} [options]
     * @returns {Promise<{contactId: string, items: object[]}>}
     */
    async history(ref, { limit = 50, since, includeMedia = true } = {}) {
      let contact;
      if (ref && typeof ref === 'object' && ref.inboundId) {
        const row = await api.getRow(ref.inboundId);
        if (!row?.contact_id) throw new MessageGateError('NOT_FOUND');
        contact = await deps.contacts.getRowById(row.contact_id);
      } else {
        contact = await deps.contacts.getRow(String(ref || ''));
      }
      if (!contact) throw new MessageGateError('NOT_FOUND');
      const max = Math.max(1, Math.min(Number(limit) || 50, 200));
      const from = Number(since) || 0;
      const inbound = await ctx
        .knex(T.inbound)
        .where('contact_id', contact.id)
        .andWhere('received_at', '>=', from)
        .orderBy('received_at', 'desc')
        .limit(max);
      const outbound = await ctx
        .knex(T.messages)
        .where('contact_id', contact.id)
        .andWhere('created_at', '>=', from)
        .orderBy('created_at', 'desc')
        .limit(max);
      const docIds = new Map(outbound.map((m) => [m.id, m.document_id]));
      const items = [
        ...inbound.map((r) => {
          const dto = toDto(r, { replyTo: docIds.get(r.reply_to_message_id) || null });
          return {
            direction: 'inbound',
            id: dto.id,
            channel: dto.channel,
            kind: dto.kind,
            text: dto.text,
            buttonPayload: dto.buttonPayload,
            buttonTitle: dto.buttonTitle,
            location: dto.location,
            media: includeMedia ? dto.media : undefined,
            status: dto.processedAt ? 'processed' : 'received',
            replyTo: dto.replyTo,
            at: dto.receivedAt,
          };
        }),
        ...outbound.map((m) => {
          // Outbound content is removed after delivery (privacy by design);
          // the text is only available while the payload still exists.
          const sealed = m.payload_sealed ? tryOpen(m.payload_sealed, 'message-payload', ctx.encryptionKey) : null;
          const p = sealed?.payload || {};
          const text = p.text ?? p.caption ?? null;
          return {
            direction: 'outbound',
            id: m.document_id,
            channel: m.channel,
            kind: m.template_key ? 'template' : p.kind === 'media' ? 'media' : 'text',
            templateKey: m.template_key || null,
            text: typeof text === 'string' ? text : null,
            status: m.status,
            replyTo: null,
            at: Number(m.created_at),
          };
        }),
      ]
        .sort((a, b) => a.at - b.at)
        .slice(-max);
      return { contactId: contact.document_id, items };
    },

    /**
     * Removes inbound rows (and stored files) past the retention period.
     *
     * @param {number} retentionDays
     * @returns {Promise<number>}
     */
    async purge(retentionDays) {
      const cutoff = ctx.now() - retentionDays * 86_400_000;
      const rows = await ctx
        .knex(T.inbound)
        .where('received_at', '<', cutoff)
        .limit(2000)
        .select('id', 'media_file_id');
      return api.removeRows(rows);
    },

    /**
     * Deletes inbound rows and their media files.
     *
     * @param {Array<{id: number, media_file_id: number|null}>} rows
     * @returns {Promise<number>}
     */
    async removeRows(rows) {
      for (const row of rows) {
        if (row.media_file_id && ctx.files?.remove) await ctx.files.remove(row.media_file_id).catch(() => {});
      }
      if (!rows.length) return 0;
      return affected(
        await ctx
          .knex(T.inbound)
          .whereIn(
            'id',
            rows.map((r) => r.id)
          )
          .del()
      );
    },

    /**
     * GDPR: every inbound message of a contact, decrypted.
     *
     * @param {number} contactId
     * @returns {Promise<object[]>}
     */
    async exportFor(contactId) {
      const rows = await ctx.knex(T.inbound).where('contact_id', contactId).orderBy('id').limit(10_000);
      return rows.map((r) => toDto(r));
    },

    /**
     * GDPR: deletes every inbound message (and file) of a contact.
     *
     * @param {number} contactId
     * @returns {Promise<number>}
     */
    async eraseFor(contactId) {
      const rows = await ctx.knex(T.inbound).where('contact_id', contactId).select('id', 'media_file_id');
      return api.removeRows(rows);
    },
  };
  return api;
}

module.exports = { createInbound, CONTENT };
