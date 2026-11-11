'use strict';

/**
 * Contacts, consent, suppression and Telegram linking.
 *
 * Phone numbers and Telegram chat ids are stored encrypted and looked up by
 * a keyed hash, so the database never holds them in clear text and log lines
 * only carry a short hash prefix.
 */
const { T } = require('../store/schema');
const { affected } = require('../store/coordination');
const { seal, tryOpen, hashValue, randomToken } = require('../utils/crypto');
const { parsePhone } = require('../utils/phone');
const { MessageGateError } = require('../utils/errors');
const { newId } = require('./context');

const PHONE = 'contact-phone';
const TELEGRAM = 'contact-telegram';
const CHANNELS = ['whatsapp', 'rcs', 'telegram', 'sms'];
/** A learned "not RCS capable" is trusted for this long (devices change). */
const RCS_NOT_CAPABLE_MS = 30 * 86_400_000;

/**
 * @param {import('./context').CoreContext} ctx
 */
function createContacts(ctx) {
  const phoneHash = (e164) => hashValue(e164, PHONE, ctx.encryptionKey);
  const chatHash = (chatId) => hashValue(String(chatId), TELEGRAM, ctx.encryptionKey);

  /**
   * @param {object} row
   * @param {object[]} [consents]
   * @param {object[]} [suppressions]
   * @returns {object}
   */
  function toDto(row, consents = [], suppressions = []) {
    const phone = row.phone_sealed ? tryOpen(row.phone_sealed, PHONE, ctx.encryptionKey) : null;
    return {
      id: row.document_id,
      phone,
      phoneMasked: phone ? `${phone.slice(0, 4)}•••${phone.slice(-2)}` : null,
      telegramLinked: Boolean(row.telegram_hash),
      userId: row.user_id ?? null,
      locale: row.locale || null,
      country: row.country || null,
      lineType: row.line_type || null,
      whatsapp: {
        reachability: row.wa_reachability,
        since: row.wa_reachability_at ? Number(row.wa_reachability_at) : null,
      },
      rcs: {
        capability: row.rcs_capability || 'unknown',
        since: row.rcs_capability_at ? Number(row.rcs_capability_at) : null,
      },
      line: {
        active: row.line_active === 'active' ? true : row.line_active === 'inactive' ? false : null,
        checkedAt: row.line_checked_at ? Number(row.line_checked_at) : null,
      },
      lastActivity: {
        inboundAt: row.last_inbound_at ? Number(row.last_inbound_at) : null,
        inboundChannel: row.last_inbound_channel || null,
        deliveredAt: row.last_delivered_at ? Number(row.last_delivered_at) : null,
        readAt: row.last_read_at ? Number(row.last_read_at) : null,
      },
      consent: Object.fromEntries(
        CHANNELS.map((channel) => {
          const c = consents.find((x) => x.channel === channel);
          return [
            channel,
            c
              ? { status: c.status, source: c.source, at: Number(c.granted_at || c.revoked_at || c.updated_at) }
              : { status: 'none' },
          ];
        })
      ),
      suppressions: suppressions.map((s) => ({
        channel: s.channel,
        reason: s.reason,
        until: s.until ? Number(s.until) : null,
      })),
      createdAt: Number(row.created_at),
    };
  }

  const api = {
    phoneHash,
    chatHash,

    /**
     * Finds or creates a contact for a phone number (race-safe on the
     * unique hash).
     *
     * @param {string} input
     * @param {{country?: string, userId?: number, locale?: string}} [extra]
     * @returns {Promise<{row: object, e164: string, parsed: object}>}
     * @throws {MessageGateError} INVALID_PHONE
     */
    async upsertByPhone(input, extra = {}) {
      const parsed = parsePhone(input, extra.country || 'DE');
      if (!parsed.valid) throw new MessageGateError('INVALID_PHONE');
      const hash = phoneHash(parsed.e164);
      let row = await ctx.knex(T.contacts).where('phone_hash', hash).first();
      if (!row) {
        const now = ctx.now();
        try {
          await ctx.knex(T.contacts).insert({
            document_id: newId(),
            phone_hash: hash,
            phone_sealed: seal(parsed.e164, PHONE, ctx.encryptionKey),
            user_id: Number.isInteger(extra.userId) ? extra.userId : null,
            locale: extra.locale ? String(extra.locale).slice(0, 16) : null,
            country: parsed.country,
            wa_reachability: 'unknown',
            created_at: now,
            updated_at: now,
          });
        } catch {
          // A parallel request created it.
        }
        row = await ctx.knex(T.contacts).where('phone_hash', hash).first();
      } else if (Number.isInteger(extra.userId) && !row.user_id) {
        await ctx.knex(T.contacts).where('id', row.id).update({ user_id: extra.userId, updated_at: ctx.now() });
        row.user_id = extra.userId;
      }
      return { row, e164: parsed.e164, parsed };
    },

    /**
     * @param {number} userId
     * @returns {Promise<object|null>}
     */
    async byUser(userId) {
      return (await ctx.knex(T.contacts).where('user_id', userId).orderBy('id').first()) || null;
    },

    /**
     * @param {string} documentId
     * @returns {Promise<object|null>}
     */
    async getRow(documentId) {
      return (await ctx.knex(T.contacts).where('document_id', String(documentId).slice(0, 32)).first()) || null;
    },

    /**
     * @param {number} id
     * @returns {Promise<object|null>}
     */
    /**
     * Masked recipients for message lists (no full numbers leave this call).
     *
     * @param {number[]} ids - Internal contact ids.
     * @returns {Promise<Map<number, {id: string, phoneMasked: string|null}>>}
     */
    async recipientsByIds(ids) {
      const unique = [...new Set(ids.filter((v) => v != null))];
      const map = new Map();
      if (!unique.length) return map;
      const rows = await ctx.knex(T.contacts).whereIn('id', unique).select('id', 'document_id', 'phone_sealed');
      for (const row of rows) {
        const phone = row.phone_sealed ? tryOpen(row.phone_sealed, PHONE, ctx.encryptionKey) : null;
        map.set(row.id, {
          id: row.document_id,
          phoneMasked: phone ? `${phone.slice(0, 4)}•••${phone.slice(-2)}` : null,
        });
      }
      return map;
    },

    /**
     * Internal contact id for a phone number, or null.
     *
     * @param {string} phone
     * @param {string} country
     * @returns {Promise<number|null>}
     */
    async idByPhone(phone, country = 'DE') {
      const parsed = parsePhone(String(phone || ''), country);
      if (!parsed.valid) return null;
      const row = await ctx.knex(T.contacts).where('phone_hash', phoneHash(parsed.e164)).first('id');
      return row ? row.id : null;
    },

    /**
     * Contact for an E.164 number without creating one.
     *
     * @param {string} e164
     * @returns {Promise<object|null>}
     */
    async getRowByPhone(e164) {
      return (await ctx.knex(T.contacts).where('phone_hash', phoneHash(e164)).first()) || null;
    },

    async getRowById(id) {
      return (await ctx.knex(T.contacts).where('id', id).first()) || null;
    },

    /**
     * @param {object} row
     * @returns {Promise<object>}
     */
    async dto(row) {
      const consents = await ctx.knex(T.consents).where('contact_id', row.id);
      const suppressions = await ctx.knex(T.suppressions).where('contact_id', row.id);
      return toDto(row, consents, suppressions);
    },

    /**
     * Paginated list; search by exact phone number (hashed lookup).
     *
     * @param {{page?: number, pageSize?: number, phone?: string, country?: string}} query
     * @returns {Promise<{results: object[], pagination: object}>}
     */
    async list(query = {}) {
      const page = Math.max(1, Math.min(Number(query.page) || 1, 1000));
      const pageSize = Math.max(1, Math.min(Number(query.pageSize) || 25, 100));
      const q = ctx.knex(T.contacts);
      if (query.phone) {
        const parsed = parsePhone(String(query.phone), query.country || 'DE');
        q.where('phone_hash', parsed.valid ? phoneHash(parsed.e164) : '-');
      }
      const [{ total }] = await q.clone().count({ total: '*' });
      const rows = await q
        .orderBy('id', 'desc')
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      const ids = rows.map((r) => r.id);
      const consents = ids.length ? await ctx.knex(T.consents).whereIn('contact_id', ids) : [];
      const suppressions = ids.length ? await ctx.knex(T.suppressions).whereIn('contact_id', ids) : [];
      return {
        results: rows.map((r) =>
          toDto(
            r,
            consents.filter((c) => c.contact_id === r.id),
            suppressions.filter((s) => s.contact_id === r.id)
          )
        ),
        pagination: { page, pageSize, total: Number(total), pageCount: Math.ceil(Number(total) / pageSize) },
      };
    },

    /**
     * @param {number} contactId
     * @param {string} channel
     * @returns {Promise<'granted'|'revoked'|'pending'|'none'>}
     */
    async consentStatus(contactId, channel) {
      const row = await ctx.knex(T.consents).where({ contact_id: contactId, channel }).first('status');
      return row ? row.status : 'none';
    },

    /**
     * @param {number} contactId
     * @param {string} channel
     * @param {'granted'|'revoked'|'pending'} status
     * @param {string} source
     * @returns {Promise<void>}
     */
    async setConsent(contactId, channel, status, source) {
      if (!CHANNELS.includes(channel)) throw new MessageGateError('INVALID_REQUEST', undefined, { field: 'channel' });
      const now = ctx.now();
      const values = {
        status,
        source: String(source).slice(0, 24),
        granted_at: status === 'granted' ? now : null,
        revoked_at: status === 'revoked' ? now : null,
        updated_at: now,
      };
      const updated = await ctx.knex(T.consents).where({ contact_id: contactId, channel }).update(values);
      if (affected(updated) === 0) {
        try {
          await ctx.knex(T.consents).insert({ contact_id: contactId, channel, ...values });
        } catch {
          await ctx.knex(T.consents).where({ contact_id: contactId, channel }).update(values);
        }
      }
      if (status === 'revoked') ctx.emit('messagegate.contact.opted-out', { channel, at: now });
    },

    /**
     * @param {number} contactId
     * @param {string} channel
     * @returns {Promise<object|null>} Active suppression.
     */
    async suppression(contactId, channel) {
      const row = await ctx.knex(T.suppressions).where({ contact_id: contactId, channel }).first();
      if (!row) return null;
      if (row.until && Number(row.until) <= ctx.now()) return null;
      return row;
    },

    /**
     * @param {number} contactId
     * @param {string} channel
     * @param {string} reason
     * @param {number|null} [until]
     * @returns {Promise<void>}
     */
    async suppress(contactId, channel, reason, until = null) {
      const values = { reason: String(reason).slice(0, 32), until, created_at: ctx.now() };
      const updated = await ctx.knex(T.suppressions).where({ contact_id: contactId, channel }).update(values);
      if (affected(updated) === 0) {
        try {
          await ctx.knex(T.suppressions).insert({ contact_id: contactId, channel, ...values });
        } catch {
          // A parallel webhook suppressed it already.
        }
      }
    },

    /**
     * @param {number} contactId
     * @param {string} channel
     * @returns {Promise<void>}
     */
    async unsuppress(contactId, channel) {
      await ctx.knex(T.suppressions).where({ contact_id: contactId, channel }).del();
    },

    /**
     * Marks WhatsApp reachability (131026 → unreachable, delivery → ok).
     *
     * @param {number} contactId
     * @param {'ok'|'unreachable'} state
     * @returns {Promise<void>}
     */
    async setWhatsappReachability(contactId, state) {
      const result = await ctx
        .knex(T.contacts)
        .where('id', contactId)
        .whereNot('wa_reachability', state)
        .update({ wa_reachability: state, wa_reachability_at: ctx.now(), updated_at: ctx.now() });
      if (state === 'unreachable' && affected(result) === 1)
        ctx.emit('messagegate.contact.unreachable', { channel: 'whatsapp', at: ctx.now() });
    },

    /**
     * Learned RCS capability (TWILIO_63036 → not_capable, RCS delivery → capable).
     *
     * @param {number} contactId
     * @param {'capable'|'not_capable'|'unknown'} state
     * @returns {Promise<void>}
     */
    async setRcsCapability(contactId, state) {
      await ctx
        .knex(T.contacts)
        .where('id', contactId)
        .update({ rcs_capability: state, rcs_capability_at: ctx.now(), updated_at: ctx.now() });
    },

    /**
     * Whether RCS should be skipped for this contact right now.
     *
     * @param {object} row
     * @returns {boolean}
     */
    rcsKnownNotCapable(row) {
      return (
        row?.rcs_capability === 'not_capable' && ctx.now() - Number(row.rcs_capability_at || 0) < RCS_NOT_CAPABLE_MS
      );
    },

    /**
     * Stores the HLR result on the contact for the admin list.
     *
     * @param {string} hash - Phone hash.
     * @param {boolean|null} active
     * @param {number} at
     * @returns {Promise<void>}
     */
    async setLineActive(hash, active, at) {
      await ctx
        .knex(T.contacts)
        .where('phone_hash', hash)
        .update({
          line_active: active === true ? 'active' : active === false ? 'inactive' : 'unknown',
          line_checked_at: at,
        });
    },

    /**
     * @param {number} contactId
     * @param {'inbound'|'delivered'|'read'} kind
     * @param {number} at
     * @param {string} [channel]
     * @returns {Promise<void>}
     */
    async touch(contactId, kind, at, channel) {
      const column =
        kind === 'inbound' ? 'last_inbound_at' : kind === 'delivered' ? 'last_delivered_at' : 'last_read_at';
      const update = { [column]: at, updated_at: ctx.now() };
      if (kind === 'inbound' && channel) update.last_inbound_channel = channel;
      await ctx
        .knex(T.contacts)
        .where('id', contactId)
        .andWhere((q) => q.whereNull(column).orWhere(column, '<', at))
        .update(update);
    },

    /**
     * Decrypted phone number of a contact (server side only).
     *
     * @param {object} row
     * @returns {string|null}
     */
    phoneOf(row) {
      return row?.phone_sealed ? tryOpen(row.phone_sealed, PHONE, ctx.encryptionKey) : null;
    },

    /**
     * Decrypted Telegram chat id.
     *
     * @param {object} row
     * @returns {string|null}
     */
    chatIdOf(row) {
      return row?.telegram_sealed ? tryOpen(row.telegram_sealed, TELEGRAM, ctx.encryptionKey) : null;
    },

    /**
     * @param {string} chatId
     * @returns {Promise<object|null>}
     */
    async byChatId(chatId) {
      return (await ctx.knex(T.contacts).where('telegram_hash', chatHash(chatId)).first()) || null;
    },

    /**
     * Creates a one-time Telegram link token for a contact.
     *
     * @param {number} contactId
     * @param {number} [ttlMs]
     * @returns {Promise<string>} Token for `t.me/<bot>?start=<token>`.
     */
    async createLinkToken(contactId, ttlMs = 30 * 60_000) {
      const token = randomToken(24);
      await ctx.knex(T.linkTokens).insert({
        token_hash: hashValue(token, 'telegram-link', ctx.encryptionKey),
        contact_id: contactId,
        expires_at: ctx.now() + ttlMs,
      });
      return token;
    },

    /**
     * Consumes a link token exactly once and binds the chat id.
     *
     * @param {string} token
     * @param {string} chatId
     * @returns {Promise<object|null>} The linked contact or null.
     */
    async consumeLinkToken(token, chatId) {
      if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token))) return null;
      const tokenHash = hashValue(token, 'telegram-link', ctx.encryptionKey);
      const now = ctx.now();
      const won = await ctx
        .knex(T.linkTokens)
        .where({ token_hash: tokenHash })
        .whereNull('used_at')
        .andWhere('expires_at', '>', now)
        .update({ used_at: now });
      if (affected(won) !== 1) return null;
      const link = await ctx.knex(T.linkTokens).where('token_hash', tokenHash).first();
      const existing = await api.byChatId(chatId);
      if (existing && existing.id !== link.contact_id) {
        await ctx
          .knex(T.contacts)
          .where('id', existing.id)
          .update({ telegram_hash: null, telegram_sealed: null, updated_at: now });
      }
      await ctx
        .knex(T.contacts)
        .where('id', link.contact_id)
        .update({
          telegram_hash: chatHash(chatId),
          telegram_sealed: seal(String(chatId), TELEGRAM, ctx.encryptionKey),
          updated_at: now,
        });
      await api.setConsent(link.contact_id, 'telegram', 'granted', 'telegram-start');
      return api.getRowById(link.contact_id);
    },

    /**
     * GDPR export of one contact (decrypted, for the data subject).
     *
     * @param {string} documentId
     * @returns {Promise<object>}
     */
    async exportData(documentId) {
      const row = await api.getRow(documentId);
      if (!row) throw new MessageGateError('NOT_FOUND');
      const messages = await ctx
        .knex(T.messages)
        .where('contact_id', row.id)
        .orderBy('id')
        .limit(10_000)
        .select(
          'document_id',
          'channel',
          'template_key',
          'status',
          'created_at',
          'sent_at',
          'delivered_at',
          'read_at',
          'failed_at'
        );
      return { contact: await api.dto(row), messages };
    },

    /**
     * GDPR erasure: removes the contact, consents, suppressions and all
     * message payloads; message rows keep only anonymous statistics.
     *
     * @param {string} documentId
     * @returns {Promise<void>}
     */
    async erase(documentId) {
      const row = await api.getRow(documentId);
      if (!row) throw new MessageGateError('NOT_FOUND');
      await ctx.knex.transaction(async (trx) => {
        await trx(T.messages)
          .where('contact_id', row.id)
          .update({ contact_id: null, payload_sealed: null, metadata: null });
        await trx(T.consents).where('contact_id', row.id).del();
        await trx(T.suppressions).where('contact_id', row.id).del();
        await trx(T.linkTokens).where('contact_id', row.id).del();
        await trx(T.contacts).where('id', row.id).del();
      });
    },
  };
  return api;
}

module.exports = { createContacts, CHANNELS };
