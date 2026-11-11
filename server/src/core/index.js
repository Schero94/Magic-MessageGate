'use strict';

/**
 * Builds the MessageGate core from a knex connection and plugin config.
 */
const crypto = require('node:crypto');
const { createContext } = require('./context');
const { createSettings } = require('./settings');
const { createAccounts } = require('./accounts');
const { createTemplates } = require('./templates');
const { createContacts } = require('./contacts');
const { createOutbox } = require('./outbox');
const { createSender } = require('./sender');
const { createWebhooks } = require('./webhooks');
const { createLookup } = require('./lookup');
const { createAnalytics } = require('./analytics');
const { createAttachments } = require('./attachments');
const { createInbound } = require('./inbound');
const { createHooksOut } = require('./hooks-out');
const { ensureSchema } = require('../store/schema');
const { MessageGateError } = require('../utils/errors');
const { parsePhone } = require('../utils/phone');

/**
 * @param {object} input - See createContext.
 * @returns {object} Core services.
 */
function createCore(input) {
  const ctx = createContext(input);
  // Every event also feeds the optional outgoing webhook. Events are emitted
  // by exactly one process (the one that won the state change), so the
  // delivery row is created once.
  const emitApp = ctx.emit;
  let hooksOut = null;
  ctx.emit = (name, payload) => {
    emitApp(name, payload);
    if (hooksOut) {
      hooksOut.enqueue(name, payload).catch((error) => {
        ctx.log.warn(`[magic-messagegate] outgoing webhook not queued: ${error?.name || 'Error'}`);
      });
    }
  };
  const settings = createSettings(ctx);
  const accounts = createAccounts(ctx);
  const attachments = createAttachments(ctx);
  const templates = createTemplates(ctx, { accounts, attachments });
  const contacts = createContacts(ctx);
  const outbox = createOutbox(ctx, { accounts, contacts });
  const lookup = createLookup(ctx, { settings, accounts, contacts });
  const sender = createSender(ctx, { settings, accounts, templates, contacts, outbox, lookup, attachments });
  outbox.setFailureHandler((row, code) => sender.onFailure(row, code));
  const inbound = createInbound(ctx, { settings, accounts, contacts, attachments });
  const webhooks = createWebhooks(ctx, { settings, accounts, templates, contacts, outbox, inbound });
  const analytics = createAnalytics(ctx);
  hooksOut = createHooksOut(ctx, { settings });

  const REPLY_FIELDS = [
    'text',
    'buttons',
    'template',
    'language',
    'variables',
    'attachment',
    'idempotencyKey',
    'notAfter',
    'metadata',
    'transactional',
  ];

  /**
   * Answers an inbound message on the same channel and account. WhatsApp
   * free text only works inside the 24-hour window (WINDOW_CLOSED: use a
   * template).
   *
   * @param {string} inboundId
   * @param {object} input - `text` (+ `buttons`) or `template` + `variables`, optional `attachment`, `idempotencyKey`, `notAfter`, `metadata`
   * @param {{source?: string, keyScope?: string, dryRun?: boolean}} [options]
   * @returns {Promise<object>}
   * @throws {MessageGateError} NOT_FOUND, INVALID_REQUEST, WINDOW_CLOSED and every send error
   */
  async function reply(inboundId, input = {}, options = {}) {
    const row = await inbound.getRow(inboundId);
    if (!row?.contact_id) throw new MessageGateError('NOT_FOUND');
    const contact = await contacts.getRowById(row.contact_id);
    if (!contact) throw new MessageGateError('NOT_FOUND');
    const extra = Object.keys(input || {}).filter((k) => !REPLY_FIELDS.includes(k));
    if (extra.length) throw new MessageGateError('INVALID_REQUEST', undefined, { field: extra[0].slice(0, 60) });
    const account = row.account_id ? await accounts.getRowById(row.account_id) : null;
    const sameAccount = account && account.is_active && account.channel === row.channel;
    return sender.send(
      {
        ...input,
        contactId: contact.document_id,
        channel: row.channel,
        ...(sameAccount ? { accountId: account.document_id } : {}),
      },
      { source: 'reply', ...options }
    );
  }

  /**
   * Sandbox only: stores an inbound message as if a provider had sent it, so
   * app tests can drive their automations (event, reply, media path).
   *
   * @param {object} input - `to` | `contactId`, `channel`, `text`, `buttonPayload`, `buttonTitle`,
   *   `media: { mime, size, filename, caption, duration, expired?, mismatch? }`, `location`, `replyTo`
   * @returns {Promise<object>} inbound DTO, or `{ duplicate: true }`
   * @throws {MessageGateError} SANDBOX_ONLY, INVALID_PHONE, NOT_FOUND
   */
  async function simulateInbound(input = {}) {
    if (ctx.config.providers.mode !== 'sandbox') throw new MessageGateError('SANDBOX_ONLY');
    const value = await settings.get();
    const channel = ['whatsapp', 'rcs', 'telegram', 'sms'].includes(input.channel) ? input.channel : 'whatsapp';
    let contact;
    if (input.contactId) contact = await contacts.getRow(String(input.contactId));
    else {
      const parsed = parsePhone(String(input.to || ''), value.defaultCountry);
      if (!parsed.valid) throw new MessageGateError('INVALID_PHONE');
      contact = (await contacts.upsertByPhone(parsed.e164, { country: value.defaultCountry })).row;
    }
    if (!contact) throw new MessageGateError('NOT_FOUND');
    const account = (await accounts.forChannel(channel))[0] || null;
    let kind = 'text';
    if (input.buttonPayload) kind = 'button';
    else if (input.media) kind = 'media';
    else if (input.location) kind = 'location';
    let media;
    if (input.media) {
      const mime = String(input.media.mime || 'image/jpeg').slice(0, 120);
      const size = Math.max(1, Math.min(Number(input.media.size) || 2048, 200 * 1024 * 1024));
      media = {
        ref: {
          provider: 'sandbox',
          mime,
          size,
          expired: Boolean(input.media.expired),
          mismatch: Boolean(input.media.mismatch),
        },
        mime,
        size,
        filename: input.media.filename,
        caption: input.media.caption,
        duration: input.media.duration,
      };
    }
    const at = ctx.now();
    const row = await inbound.record({
      provider: 'sandbox',
      providerMessageId: String(input.providerMessageId || crypto.randomBytes(12).toString('hex')).slice(0, 120),
      channel,
      contact,
      account,
      kind,
      text: input.text || input.media?.caption,
      buttonPayload: input.buttonPayload,
      buttonTitle: input.buttonTitle,
      media,
      location: input.location,
      replyMessageDocumentId: input.replyTo,
      at,
    });
    if (!row) return { duplicate: true };
    await contacts.touch(contact.id, 'inbound', at, channel);
    return inbound.get(row.document_id);
  }

  /**
   * GDPR export of a contact including inbound messages (decrypted).
   *
   * @param {string} documentId
   * @returns {Promise<object>}
   */
  async function exportContact(documentId) {
    const data = await contacts.exportData(documentId);
    const row = await contacts.getRow(documentId);
    return { ...data, inbound: await inbound.exportFor(row.id) };
  }

  /**
   * GDPR erasure including inbound messages and their stored files.
   *
   * @param {string} documentId
   * @returns {Promise<void>}
   */
  async function eraseContact(documentId) {
    const row = await contacts.getRow(documentId);
    if (!row) throw new MessageGateError('NOT_FOUND');
    await inbound.eraseFor(row.id);
    await contacts.erase(documentId);
  }

  return {
    ctx,
    exportContact,
    eraseContact,
    settings,
    accounts,
    templates,
    contacts,
    outbox,
    sender,
    webhooks,
    lookup,
    analytics,
    attachments,
    inbound,
    hooksOut,
    reply,
    simulateInbound,
    /** Creates missing tables and columns. */
    init: () => ensureSchema(ctx.knex),
  };
}

module.exports = { createCore };
