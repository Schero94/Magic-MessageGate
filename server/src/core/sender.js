'use strict';

/**
 * Public send API: validation, contact resolution, consent, routing and the
 * fallback chain (for example WhatsApp → SMS → e-mail through Magic Mail).
 */
const { z } = require('zod');
const { MessageGateError } = require('../utils/errors');
const { hashValue } = require('../utils/crypto');
const engine = require('../utils/template-engine');

const sendSchema = z
  .object({
    channel: z.enum(['auto', 'whatsapp', 'telegram', 'sms']).default('auto'),
    to: z.string().trim().min(3).max(40).optional(),
    userId: z.number().int().positive().optional(),
    contactId: z.string().max(32).optional(),
    email: z.string().email().max(254).optional(),
    template: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,119}$/)
      .optional(),
    language: z
      .string()
      .regex(/^[a-z]{2,3}(_[A-Z]{2})?$/)
      .optional(),
    variables: z
      .record(z.string().max(60), z.union([z.string().max(1024), z.number(), z.boolean()]))
      .refine((o) => Object.keys(o).length <= 50, { message: 'at most 50 variables' })
      .optional(),
    text: z.string().trim().min(1).max(4096).optional(),
    idempotencyKey: z.string().trim().min(1).max(200).optional(),
    notAfter: z.union([z.date(), z.string().datetime({ offset: true }), z.number().int().positive()]).optional(),
    transactional: z.boolean().default(false),
    tags: z.array(z.string().max(40)).max(10).default([]),
    accountId: z.string().max(32).optional(),
    priority: z.enum(['high', 'normal', 'low']).default('normal'),
    metadata: z
      .record(z.string().max(60), z.union([z.string().max(500), z.number(), z.boolean(), z.null()]))
      .refine((o) => Object.keys(o).length <= 20, { message: 'at most 20 metadata keys' })
      .optional(),
  })
  .strict()
  .refine((v) => Boolean(v.template || v.text), { message: 'template or text is required', path: ['template'] })
  .refine((v) => Boolean(v.to || v.userId || v.contactId), {
    message: 'to, userId or contactId is required',
    path: ['to'],
  });

const PRIORITY = { high: 10, normal: 100, low: 200 };
const WINDOW_MS = 24 * 3_600_000;

/**
 * @param {import('./context').CoreContext} ctx
 * @param {{settings: object, accounts: object, templates: object, contacts: object, outbox: object}} deps
 */
function createSender(ctx, deps) {
  /**
   * Picks the channel chain for a request.
   *
   * @param {object} input
   * @param {object} settings
   * @param {string|null} country
   * @returns {string[]}
   */
  function chainFor(input, settings, country) {
    if (input.channel !== 'auto') return [input.channel];
    for (const rule of settings.routing.rules) {
      const keyOk = !rule.templateKeys.length || (input.template && rule.templateKeys.includes(input.template));
      const countryOk = !rule.countries.length || (country && rule.countries.includes(country));
      const tagOk = !rule.tags.length || input.tags.some((t) => rule.tags.includes(t));
      if (keyOk && countryOk && tagOk) return rule.chain;
    }
    return settings.routing.defaultChain;
  }

  /**
   * Checks whether a channel can reach the contact for this request.
   *
   * @param {string} channel
   * @param {object} contact - contact row
   * @param {object} seed - template key, language, variables, text, transactional
   * @param {object} settings
   * @returns {Promise<{ok: true, template: object|null, to: string, accountId: number|null}|{ok: false, code: string}>}
   */
  async function eligible(channel, contact, seed, settings) {
    let template = null;
    if (seed.template) {
      const row = await deps.templates.resolve(channel, seed.template, seed.language);
      if (!row) return { ok: false, code: 'UNKNOWN_TEMPLATE' };
      template = deps.templates.toDto(row);
      if (channel === 'whatsapp' && template.approvalStatus !== 'APPROVED')
        return { ok: false, code: 'TEMPLATE_NOT_APPROVED' };
    }
    let to;
    if (channel === 'telegram') {
      to = deps.contacts.chatIdOf(contact);
      if (!to) return { ok: false, code: 'NOT_LINKED' };
    } else {
      to = deps.contacts.phoneOf(contact);
      if (!to) return { ok: false, code: 'INVALID_PHONE' };
      if (channel === 'whatsapp' && contact.wa_reachability === 'unreachable') return { ok: false, code: 'SUPPRESSED' };
    }
    if (await deps.contacts.suppression(contact.id, channel)) return { ok: false, code: 'SUPPRESSED' };
    const authException = seed.transactional && template && template.category === 'AUTHENTICATION';
    if (settings.requireConsent && !authException) {
      const consent = await deps.contacts.consentStatus(contact.id, channel);
      if (consent !== 'granted') return { ok: false, code: 'NO_CONSENT' };
    }
    if (!seed.template && channel === 'whatsapp') {
      const inbound = Number(contact.last_inbound_at || 0);
      if (contact.last_inbound_channel !== 'whatsapp' || ctx.now() - inbound > WINDOW_MS)
        return { ok: false, code: 'WINDOW_CLOSED' };
    }
    let accountId = null;
    if (seed.accountId) {
      const account = await deps.accounts.getRow(seed.accountId);
      if (!account || account.channel !== channel || !account.is_active) return { ok: false, code: 'NO_ACCOUNT' };
      accountId = account.id;
    } else if (!(await deps.accounts.forChannel(channel)).length) {
      return { ok: false, code: 'NO_ACCOUNT' };
    }
    return { ok: true, template, to, accountId };
  }

  /**
   * Renders the payload for an eligible channel.
   *
   * @param {string} channel
   * @param {object|null} template
   * @param {object} seed
   * @returns {{payload: object}}
   */
  function renderFor(channel, template, seed) {
    if (template) {
      try {
        return engine.render(template, seed.variables || {});
      } catch (error) {
        throw new MessageGateError(error.code || 'INVALID_VARIABLE', undefined, error.details);
      }
    }
    const text = engine.clean(seed.text);
    if (channel === 'whatsapp') return { payload: { kind: 'text', text: text.slice(0, 4096) } };
    // The schema caps text at 4096 visible characters; escaping only adds entities.
    if (channel === 'telegram') return { payload: { text: engine.escapeHtml(text) } };
    return { payload: { text: text.slice(0, 1600) } };
  }

  /**
   * Sends the e-mail step through Magic Mail when installed and configured.
   *
   * @param {object} seed
   * @param {object} settings
   * @param {number} notAfter
   * @param {string} idempotencyKey
   * @returns {Promise<{ok: boolean, code?: string}>}
   */
  async function sendEmail(seed, settings, notAfter, idempotencyKey) {
    if (
      !settings.fallback.emailEnabled ||
      !ctx.magicMail ||
      !seed.email ||
      !settings.fallback.emailTemplateReferenceId
    ) {
      return { ok: false, code: 'NO_ROUTE' };
    }
    try {
      await ctx.magicMail.send(
        {
          to: seed.email,
          templateReferenceId: settings.fallback.emailTemplateReferenceId,
          templateData: { ...(seed.variables || {}), text: seed.text || '' },
          type: seed.transactional ? 'transactional' : 'notification',
        },
        { notAfter: new Date(notAfter), idempotencyKey, idempotencyScope: 'magic-messagegate' }
      );
      return { ok: true };
    } catch (error) {
      ctx.log.warn(`[magic-messagegate] e-mail fallback failed: ${error?.code || error?.name || 'Error'}`);
      return { ok: false, code: 'EMAIL_FAILED' };
    }
  }

  /**
   * Tries the channels of a chain in order and queues the first reachable one.
   *
   * @param {object} contact
   * @param {string[]} chain
   * @param {object} seed
   * @param {object} options - notAfter, notAfterFixed, idempotencyHash, source, priority, metadata, fallbackOf, idempotencyBase
   * @returns {Promise<object>}
   */
  async function route(contact, chain, seed, options) {
    const settings = await deps.settings.get();
    let firstCode = null;
    for (let i = 0; i < chain.length; i += 1) {
      const channel = chain[i];
      if (channel === 'email') {
        const mail = await sendEmail(seed, settings, options.notAfter, `${options.idempotencyBase}:email`);
        if (mail.ok) return { id: null, status: 'handed-to-email', channel: 'email', duplicate: false };
        firstCode = firstCode || mail.code;
        continue;
      }
      const check = await eligible(channel, contact, seed, settings);
      if (!check.ok) {
        firstCode = firstCode || check.code;
        continue;
      }
      const rendered = renderFor(channel, check.template, seed);
      const { row, duplicate } = await deps.outbox.enqueue({
        channel,
        accountId: check.accountId,
        templateId: check.template ? ((await deps.templates.getRow(check.template.id))?.id ?? null) : null,
        templateKey: check.template ? check.template.key : null,
        contactId: contact.id,
        to: check.to,
        payload: rendered.payload,
        seed: { ...seed, chain: chain.slice(i + 1) },
        notAfter: options.notAfter,
        notAfterFixed: options.notAfterFixed,
        idempotencyHash: options.fallbackOf
          ? hashValue(`${options.idempotencyBase}:${channel}`, 'idempotency', ctx.encryptionKey)
          : options.idempotencyHash,
        chain: chain.slice(i + 1),
        fallbackOf: options.fallbackOf ?? null,
        source: options.source,
        costCategory: check.template ? check.template.category : null,
        transactional: seed.transactional,
        metadata: options.metadata,
        priority: options.priority,
      });
      return { id: row.document_id, status: row.status, channel: row.channel, duplicate };
    }
    throw new MessageGateError(firstCode || 'NO_ROUTE');
  }

  const api = {
    sendSchema,

    /**
     * Queues a message.
     *
     * @param {object} input - See README "Sending API".
     * @param {{source?: string, keyScope?: string}} [options]
     * @returns {Promise<{id: string|null, status: string, channel: string, duplicate: boolean}>}
     */
    async send(input, options = {}) {
      const parsed = sendSchema.safeParse(input || {});
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new MessageGateError('INVALID_REQUEST', undefined, {
          field: String(issue.path[0] ?? ''),
          reason: issue.message.slice(0, 120),
        });
      }
      const data = parsed.data;
      const settings = await deps.settings.get();
      const now = ctx.now();

      let contact;
      if (data.contactId) {
        contact = await deps.contacts.getRow(data.contactId);
        if (!contact) throw new MessageGateError('NOT_FOUND', 'Contact not found');
      } else if (data.to) {
        contact = (
          await deps.contacts.upsertByPhone(data.to, { country: settings.defaultCountry, userId: data.userId })
        ).row;
      } else {
        contact = await deps.contacts.byUser(data.userId);
        if (!contact) throw new MessageGateError('NOT_FOUND', 'No contact is linked to this user');
      }

      const notAfter = data.notAfter
        ? new Date(data.notAfter).getTime()
        : now + ctx.config.defaultNotAfterHours * 3_600_000;
      if (!Number.isFinite(notAfter)) throw new MessageGateError('INVALID_REQUEST', undefined, { field: 'notAfter' });
      if (notAfter <= now) throw new MessageGateError('DEADLINE_PASSED');

      const scope = `${options.keyScope || options.source || 'api'}`;
      const idempotencyBase = data.idempotencyKey
        ? `${scope}:${data.idempotencyKey}`
        : `${scope}:auto:${now}:${Math.round(ctx.random() * 1e9)}`;
      const seed = {
        template: data.template || null,
        language: data.language || contact.locale || null,
        variables: data.variables || {},
        text: data.text || null,
        transactional: data.transactional,
        email: data.email || null,
        accountId: data.accountId || null,
        tags: data.tags,
      };
      const chain = chainFor(data, settings, contact.country);
      return route(contact, chain, seed, {
        notAfter,
        notAfterFixed: Boolean(data.notAfter),
        idempotencyHash: data.idempotencyKey ? hashValue(idempotencyBase, 'idempotency', ctx.encryptionKey) : null,
        idempotencyBase,
        source: (options.source || 'api').slice(0, 16),
        priority: PRIORITY[data.priority],
        metadata: data.metadata,
      });
    },

    /**
     * Failure handler for the outbox: marks WhatsApp reachability and runs
     * the next step of the fallback chain. Only called for terminal failures,
     * which are always "not delivered", so a fallback never duplicates.
     *
     * @param {object} row - failed message row
     * @param {string} code
     * @returns {Promise<void>}
     */
    async onFailure(row, code) {
      if (row.contact_id && row.channel === 'whatsapp' && code === 'META_131026') {
        await deps.contacts.setWhatsappReachability(row.contact_id, 'unreachable');
      }
      if (row.contact_id && row.channel === 'telegram' && code === 'TG_403') {
        await deps.contacts.suppress(row.contact_id, 'telegram', 'blocked_bot');
      }
      const chain = JSON.parse(row.chain || '[]');
      if (!chain.length || !row.contact_id || Number(row.not_after) <= ctx.now()) return;
      const sealed = deps.outbox.payloadOf(row);
      if (!sealed?.seed) return;
      const contact = await deps.contacts.getRowById(row.contact_id);
      if (!contact) return;
      try {
        const result = await route(contact, chain, sealed.seed, {
          notAfter: Number(row.not_after),
          notAfterFixed: Boolean(row.not_after_fixed),
          idempotencyBase: `fallback:${row.document_id}`,
          fallbackOf: row.id,
          source: 'fallback',
          priority: Number(row.priority),
          metadata: JSON.parse(row.metadata || 'null') || undefined,
        });
        ctx.emit('messagegate.message.fallback', {
          messageId: row.document_id,
          channel: result.channel,
          templateKey: row.template_key || null,
          status: 'fallback',
          code,
          at: ctx.now(),
        });
      } catch (error) {
        ctx.log.info(`[magic-messagegate] no fallback for ${row.document_id}: ${error?.code || 'NO_ROUTE'}`);
      }
    },
  };
  return api;
}

module.exports = { createSender, sendSchema };
