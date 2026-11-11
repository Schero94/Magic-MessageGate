'use strict';

/**
 * Public send API: validation, contact resolution, consent, routing, the
 * fallback chain (for example WhatsApp → RCS → SMS, then e-mail through
 * Magic Mail when the owner turned that on), attachments and dry runs.
 */
const { z } = require('zod');
const { MessageGateError } = require('../utils/errors');
const { hashValue } = require('../utils/crypto');
const { parsePhone } = require('../utils/phone');
const engine = require('../utils/template-engine');

/** Reply buttons on a free-text message (WhatsApp interactive, Telegram inline keyboard). */
const replyButtons = z
  .array(
    z
      .object({
        payload: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/),
        title: z.string().trim().min(1).max(20),
      })
      .strict()
  )
  .min(1)
  .max(3);

const sendSchema = z
  .object({
    channel: z.enum(['auto', 'whatsapp', 'rcs', 'telegram', 'sms']).default('auto'),
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
    buttons: replyButtons.optional(),
    attachment: z.record(z.string(), z.unknown()).optional(),
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
  .refine((v) => !(v.buttons && v.template), { message: 'buttons only go with text', path: ['buttons'] })
  .refine((v) => Boolean(v.to || v.userId || v.contactId), {
    message: 'to, userId or contactId is required',
    path: ['to'],
  });

const PRIORITY = { high: 10, normal: 100, low: 200 };
const WINDOW_MS = 24 * 3_600_000;
const HEADER_KIND = { IMAGE: 'image', VIDEO: 'video', DOCUMENT: 'document' };

/**
 * Masks a phone number or chat id for dry-run output.
 *
 * @param {string|null} value
 * @returns {string|null}
 */
const mask = (value) => {
  if (!value) return null;
  const s = String(value);
  return s.startsWith('+') ? `${s.slice(0, 4)}•••${s.slice(-2)}` : `•••${s.slice(-2)}`;
};

/**
 * @param {import('./context').CoreContext} ctx
 * @param {{settings: object, accounts: object, templates: object, contacts: object, outbox: object, lookup: object, attachments: object}} deps
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

  /** @param {object} contact */
  const phoneOf = (contact) => contact._e164 || deps.contacts.phoneOf(contact);

  /**
   * Checks whether a channel can reach the contact for this request.
   *
   * @param {string} channel
   * @param {object} contact - contact row (or a virtual one in dry runs)
   * @param {object} seed - template key, language, variables, text, transactional
   * @param {object} settings
   * @param {object|null} file - resolved attachment
   * @returns {Promise<{ok: true, template: object|null, to: string, accountId: number|null, plan: object|null}|{ok: false, code: string}>}
   */
  async function eligible(channel, contact, seed, settings, file) {
    let template = null;
    if (seed.template) {
      const row = await deps.templates.resolve(channel, seed.template, seed.language);
      if (!row) return { ok: false, code: 'UNKNOWN_TEMPLATE' };
      template = deps.templates.toDto(row);
      if ((channel === 'whatsapp' || channel === 'rcs') && template.approvalStatus !== 'APPROVED')
        return { ok: false, code: 'TEMPLATE_NOT_APPROVED' };
    }
    let to;
    if (channel === 'telegram') {
      to = deps.contacts.chatIdOf(contact);
      if (!to) return { ok: false, code: 'NOT_LINKED' };
    } else {
      to = phoneOf(contact);
      if (!to) return { ok: false, code: 'INVALID_PHONE' };
      if (channel === 'whatsapp' && contact.wa_reachability === 'unreachable') return { ok: false, code: 'SUPPRESSED' };
      if (channel === 'rcs' && deps.contacts.rcsKnownNotCapable(contact)) return { ok: false, code: 'RCS_NOT_CAPABLE' };
    }
    if (contact.id && (await deps.contacts.suppression(contact.id, channel))) return { ok: false, code: 'SUPPRESSED' };
    const authException = seed.transactional && template && template.category === 'AUTHENTICATION';
    if (settings.requireConsent && !authException) {
      const consent = contact.id ? await deps.contacts.consentStatus(contact.id, channel) : 'none';
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
    let plan = null;
    if (file) {
      plan = deps.attachments.plan(channel, file);
      if (plan.mode === 'unsupported') return { ok: false, code: plan.code };
      if (channel === 'whatsapp' && template) {
        const kind = HEADER_KIND[template.content.header?.format];
        if (kind !== file.kind) return { ok: false, code: 'ATTACHMENT_UNSUPPORTED' };
      }
      if (channel === 'rcs' && template?.content.contentSid) return { ok: false, code: 'ATTACHMENT_UNSUPPORTED' };
    }
    return { ok: true, template, to, accountId, plan };
  }

  /**
   * Renders the payload for an eligible channel.
   *
   * @param {string} channel
   * @param {object|null} template
   * @param {object} seed
   * @param {object|null} file - resolved attachment
   * @param {object|null} plan - attachment plan for this channel
   * @param {{settings: object, dryRun: boolean}} options
   * @returns {Promise<{payload: object, preview?: string}>}
   */
  async function renderFor(channel, template, seed, file, plan, { settings, dryRun }) {
    const link = () => deps.attachments.createLink(file, settings.attachments.linkTtlHours, { dryRun });
    let rendered;
    if (template) {
      let headerMedia = null;
      if (channel === 'whatsapp' && HEADER_KIND[template.content.header?.format]) {
        if (file) headerMedia = { link: file.url, filename: file.filename };
        else if (template.content.header.fileId) {
          const fallback = await deps.attachments.resolve({ fileId: template.content.header.fileId });
          headerMedia = { link: fallback.url, filename: fallback.filename };
        }
      }
      try {
        rendered = engine.render(template, seed.variables || {}, { headerMedia });
      } catch (error) {
        throw new MessageGateError(error.code || 'INVALID_VARIABLE', undefined, error.details);
      }
    } else {
      const text = engine.clean(seed.text);
      if (channel === 'whatsapp') {
        if (seed.buttons?.length) {
          rendered = {
            payload: {
              kind: 'buttons',
              text: text.slice(0, 1024),
              buttons: seed.buttons.map((b) => ({ id: b.payload, title: engine.clean(b.title) })),
            },
          };
        } else rendered = { payload: { kind: 'text', text: text.slice(0, 4096) } };
      } else if (channel === 'telegram') {
        rendered = { payload: { text: engine.escapeHtml(text) } };
        if (seed.buttons?.length) {
          rendered.payload.buttons = seed.buttons.map((b) => ({ payload: b.payload, title: engine.clean(b.title) }));
        }
      } else if (channel === 'rcs') rendered = { payload: { kind: 'rcs', text: text.slice(0, 1600) } };
      else rendered = { payload: { text: text.slice(0, 1600) } };
      rendered.preview = text;
    }
    if (!file || !plan) return rendered;

    const payload = rendered.payload;
    if (channel === 'whatsapp') {
      if (template) return rendered; // the header carries the file
      if (payload.kind === 'buttons' || String(payload.text).length > 1024) {
        throw new MessageGateError('ATTACHMENT_UNSUPPORTED', undefined, { reason: 'caption' });
      }
      return {
        ...rendered,
        payload: {
          kind: 'media',
          mediaType: file.kind,
          link: file.url,
          caption: payload.text,
          filename: file.filename,
        },
      };
    }
    if (channel === 'rcs') return { ...rendered, payload: { ...payload, mediaUrl: file.url } };
    if (channel === 'telegram') {
      if ((plan.mode === 'photo' || plan.mode === 'document') && engine.telegramVisibleLength(payload.text) <= 1024) {
        return {
          ...rendered,
          payload: { kind: plan.mode, url: file.url, caption: payload.text, buttons: payload.buttons },
        };
      }
      const url = await link();
      return { ...rendered, payload: { ...payload, text: `${payload.text}\n\n${engine.escapeHtml(url)}` } };
    }
    const url = await link();
    const room = 1600 - url.length - 1;
    return { ...rendered, payload: { text: `${String(payload.text).slice(0, room)}\n${url}` } };
  }

  /**
   * Sends the e-mail step through Magic Mail when installed and configured.
   * E-mail is opt-in (`fallback.emailEnabled`, off by default); MessageGate
   * never sends e-mail itself.
   *
   * @param {object} seed
   * @param {object} settings
   * @param {number} notAfter
   * @param {string} idempotencyKey
   * @param {boolean} [dryRun]
   * @returns {Promise<{ok: boolean, code?: string}>}
   */
  async function sendEmail(seed, settings, notAfter, idempotencyKey, dryRun = false) {
    if (
      !settings.fallback.emailEnabled ||
      !ctx.magicMail ||
      !seed.email ||
      !settings.fallback.emailTemplateReferenceId
    ) {
      return { ok: false, code: 'NO_ROUTE' };
    }
    if (dryRun) return { ok: true };
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
    const file = seed.attachment ? await deps.attachments.resolve(seed.attachment) : null;
    let firstCode = null;
    for (let i = 0; i < chain.length; i += 1) {
      const channel = chain[i];
      if (channel === 'email') {
        const mail = await sendEmail(seed, settings, options.notAfter, `${options.idempotencyBase}:email`);
        if (mail.ok) return { id: null, status: 'handed-to-email', channel: 'email', duplicate: false };
        firstCode = firstCode || mail.code;
        continue;
      }
      const check = await eligible(channel, contact, seed, settings, file);
      if (!check.ok) {
        firstCode = firstCode || check.code;
        continue;
      }
      let rendered;
      try {
        rendered = await renderFor(channel, check.template, seed, file, check.plan, { settings, dryRun: false });
      } catch (error) {
        if (error?.code === 'ATTACHMENT_UNSUPPORTED') {
          firstCode = firstCode || error.code;
          continue;
        }
        throw error;
      }
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

  /**
   * Validates input and resolves the contact (shared by send and dry run).
   *
   * @param {object} input
   * @param {{dryRun: boolean}} options
   * @returns {Promise<{data: object, settings: object, contact: object}>}
   */
  async function prepare(input, { dryRun }) {
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
    let contact;
    if (data.contactId) {
      contact = await deps.contacts.getRow(data.contactId);
      if (!contact) throw new MessageGateError('NOT_FOUND', 'Contact not found');
    } else if (data.to) {
      if (dryRun) {
        const p = parsePhone(data.to, settings.defaultCountry);
        if (!p.valid) throw new MessageGateError('INVALID_PHONE');
        const existing = await deps.contacts.getRowByPhone(p.e164);
        contact = existing || {
          id: null,
          _e164: p.e164,
          country: p.country,
          wa_reachability: 'unknown',
          locale: null,
        };
      } else {
        contact = (
          await deps.contacts.upsertByPhone(data.to, { country: settings.defaultCountry, userId: data.userId })
        ).row;
      }
    } else {
      contact = await deps.contacts.byUser(data.userId);
      if (!contact) throw new MessageGateError('NOT_FOUND', 'No contact is linked to this user');
    }
    if (data.channel !== 'telegram') {
      const e164 = phoneOf(contact);
      if (e164 && (await deps.lookup.isInactive(e164, { spendBudget: !dryRun }))) {
        throw new MessageGateError('NUMBER_INACTIVE');
      }
    }
    return { data, settings, contact };
  }

  /**
   * @param {object} data
   * @param {object} contact
   * @returns {object}
   */
  const seedOf = (data, contact) => ({
    template: data.template || null,
    language: data.language || contact.locale || null,
    variables: data.variables || {},
    text: data.text || null,
    buttons: data.buttons || null,
    attachment: data.attachment || null,
    transactional: data.transactional,
    email: data.email || null,
    accountId: data.accountId || null,
    tags: data.tags,
  });

  const api = {
    sendSchema,

    /**
     * Queues a message, or with `dryRun` only plans it.
     *
     * @param {object} input - See AGENTS.md "send input".
     * @param {{source?: string, keyScope?: string, dryRun?: boolean}} [options]
     * @returns {Promise<{id: string|null, status: string, channel: string, duplicate: boolean}|object>}
     */
    async send(input, options = {}) {
      if (options.dryRun) return api.preview(input, options);
      const { data, contact } = await prepare(input, { dryRun: false });
      const now = ctx.now();
      const notAfter = data.notAfter
        ? new Date(data.notAfter).getTime()
        : now + ctx.config.defaultNotAfterHours * 3_600_000;
      if (!Number.isFinite(notAfter)) throw new MessageGateError('INVALID_REQUEST', undefined, { field: 'notAfter' });
      if (notAfter <= now) throw new MessageGateError('DEADLINE_PASSED');

      const scope = `${options.keyScope || options.source || 'api'}`;
      const idempotencyBase = data.idempotencyKey
        ? `${scope}:${data.idempotencyKey}`
        : `${scope}:auto:${now}:${Math.round(ctx.random() * 1e9)}`;
      const seed = seedOf(data, contact);
      const settings = await deps.settings.get();
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
     * Dry run: validates, resolves the route and renders the payload of the
     * channel that would be used, without queuing, sending, charging or
     * creating a contact. Phone numbers are masked; secrets never appear.
     *
     * @param {object} input - Same as `send`.
     * @returns {Promise<{dryRun: true, valid: boolean, errors: Array<{code: string, field?: string}>, chain: string[], steps: Array<{channel: string, eligible: boolean, code?: string}>, channel: string|null, account: object|null, to: string|null, payload: object|null, preview: string|null, attachment: object|null}>}
     */
    async preview(input) {
      const out = {
        dryRun: true,
        valid: false,
        errors: [],
        chain: [],
        steps: [],
        channel: null,
        account: null,
        to: null,
        payload: null,
        preview: null,
        attachment: null,
      };
      try {
        const { data, settings, contact } = await prepare(input, { dryRun: true });
        const seed = seedOf(data, contact);
        out.chain = chainFor(data, settings, contact.country);
        const file = seed.attachment ? await deps.attachments.resolve(seed.attachment) : null;
        if (file) {
          out.attachment = { source: file.source, mimeType: file.mimeType, filename: file.filename, size: file.size };
        }
        for (const channel of out.chain) {
          if (channel === 'email') {
            const mail = await sendEmail(seed, settings, ctx.now() + 60_000, 'dry-run', true);
            out.steps.push(mail.ok ? { channel, eligible: true } : { channel, eligible: false, code: mail.code });
            if (mail.ok && !out.channel) out.channel = 'email';
            continue;
          }
          const check = await eligible(channel, contact, seed, settings, file);
          if (!check.ok) {
            out.steps.push({ channel, eligible: false, code: check.code });
            continue;
          }
          if (out.channel) {
            out.steps.push({ channel, eligible: true });
            continue;
          }
          let rendered;
          try {
            rendered = await renderFor(channel, check.template, seed, file, check.plan, { settings, dryRun: true });
          } catch (error) {
            if (error?.code !== 'ATTACHMENT_UNSUPPORTED') throw error;
            out.steps.push({ channel, eligible: false, code: error.code });
            continue;
          }
          out.steps.push({ channel, eligible: true, ...(file ? { attachmentMode: check.plan.mode } : {}) });
          out.channel = channel;
          out.to = mask(check.to);
          out.payload = rendered.payload;
          out.preview = rendered.preview ?? null;
          const account = check.accountId
            ? await deps.accounts.getRowById(check.accountId)
            : (await deps.accounts.forChannel(channel))[0];
          out.account = account ? { id: account.document_id, provider: account.provider, name: account.name } : null;
        }
        if (!out.channel) out.errors.push({ code: out.steps.find((s) => s.code)?.code || 'NO_ROUTE' });
        out.valid = out.errors.length === 0;
      } catch (error) {
        if (!error?.code) throw error;
        out.errors.push({ code: error.code, ...(error.details?.field ? { field: error.details.field } : {}) });
      }
      return out;
    },

    /**
     * Failure handler for the outbox: marks WhatsApp reachability and RCS
     * capability and runs the next step of the fallback chain. Only called
     * for terminal failures, which are always "not delivered", so a
     * fallback never duplicates.
     *
     * @param {object} row - failed message row
     * @param {string} code
     * @returns {Promise<void>}
     */
    async onFailure(row, code) {
      if (row.contact_id && row.channel === 'whatsapp' && code === 'META_131026') {
        await deps.contacts.setWhatsappReachability(row.contact_id, 'unreachable');
      }
      if (row.contact_id && row.channel === 'rcs' && code === 'TWILIO_63036') {
        await deps.contacts.setRcsCapability(row.contact_id, 'not_capable');
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
