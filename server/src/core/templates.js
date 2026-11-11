'use strict';

/**
 * Message templates per channel and language.
 *
 * WhatsApp templates must be approved by Meta before they can be sent
 * outside the 24-hour window; they start as DRAFT, become PENDING after
 * "Submit to Meta" and follow Meta's status from then on (sync or webhook).
 * Telegram and SMS templates need no review and are APPROVED on save.
 * RCS templates with plain text (optionally one image/file URL) are APPROVED
 * on save; a rich card with a title or buttons becomes a Twilio Content
 * template ("Create on Twilio") and is APPROVED once it has a Content SID.
 */
const { z } = require('zod');
const { T } = require('../store/schema');
const { MessageGateError } = require('../utils/errors');
const engine = require('../utils/template-engine');
const { newId, parseJson } = require('./context');

const KEY = /^[a-z][a-z0-9_]{0,119}$/;
const LANGUAGE = /^[a-z]{2,3}(_[A-Z]{2})?$/;

const variableDef = z
  .object({
    name: z.string().regex(/^([a-z][a-z0-9_]{0,59}|[1-9][0-9]?)$/),
    label: z.string().trim().max(80).optional(),
    example: z.string().max(200).optional(),
    required: z.boolean().default(true),
    maxLength: z.number().int().min(1).max(1024).default(256),
  })
  .strict();

const whatsappContent = z
  .object({
    header: z
      .object({
        format: z.enum(['TEXT', 'IMAGE', 'DOCUMENT', 'VIDEO']),
        text: z.string().max(60).optional(),
        mediaId: z
          .string()
          .regex(/^\d{1,30}$/)
          .optional(),
        // Media-library file: the sample uploaded to Meta on submit and the
        // default header media at send time (a per-message attachment wins).
        fileId: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    body: z.string().trim().min(1).max(1024),
    footer: z.string().max(60).optional(),
    buttons: z
      .array(
        z
          .object({
            type: z.enum(['QUICK_REPLY', 'URL', 'COPY_CODE']),
            text: z.string().trim().min(1).max(25),
            url: z.string().url().max(2000).startsWith('https://').optional(),
            variable: z.string().max(60).optional(),
            // QUICK_REPLY: fixed payload returned in the inbound button message.
            payload: z
              .string()
              .regex(/^[A-Za-z0-9_.:-]{1,64}$/)
              .optional(),
          })
          .strict()
      )
      .max(10)
      .optional(),
  })
  .strict();

const textContent = (max) => z.object({ text: z.string().trim().min(1).max(max) }).strict();

/** Telegram: text plus optional inline keyboard buttons with fixed callback data. */
const telegramContent = z
  .object({
    text: z.string().trim().min(1).max(4096),
    buttons: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(40),
            payload: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/),
          })
          .strict()
      )
      .max(8)
      .optional(),
  })
  .strict();

/** Rich card actions (https://www.twilio.com/docs/content/twiliocard): up to 4 on the card. */
const rcsContent = z
  .object({
    text: z.string().trim().min(1).max(1600),
    title: z.string().trim().min(1).max(200).optional(),
    mediaUrl: z.string().url().max(2000).startsWith('https://').optional(),
    buttons: z
      .array(
        z
          .object({
            type: z.enum(['URL', 'PHONE_NUMBER', 'QUICK_REPLY']),
            title: z.string().trim().min(1).max(25),
            url: z.string().url().max(2000).startsWith('https://').optional(),
            phone: z
              .string()
              .regex(/^\+\d{6,16}$/)
              .optional(),
            payload: z
              .string()
              .regex(/^[A-Za-z0-9_.:-]{1,64}$/)
              .optional(),
          })
          .strict()
          .refine((b) => (b.type === 'URL' ? Boolean(b.url) : b.type === 'PHONE_NUMBER' ? Boolean(b.phone) : true), {
            message: 'url or phone is required for this button type',
          })
          .refine((b) => b.type !== 'QUICK_REPLY' || b.title.length <= 20, { message: 'quick reply title ≤ 20' })
      )
      .max(4)
      .optional(),
    contentSid: z
      .string()
      .regex(/^HX[0-9a-f]{32}$/)
      .optional(),
    variableOrder: z.array(z.string().max(60)).max(50).optional(),
  })
  .strict();

/**
 * Whether an RCS template needs a Twilio Content template (title or buttons).
 *
 * @param {object} content
 * @returns {boolean}
 */
const needsContent = (content) => Boolean(content.title || content.buttons?.length);

/**
 * Initial approval status for a template.
 *
 * @param {string} channel
 * @param {object} content
 * @returns {string}
 */
const initialStatus = (channel, content) => {
  if (channel === 'whatsapp') return 'DRAFT';
  if (channel === 'rcs' && needsContent(content) && !content.contentSid) return 'DRAFT';
  return 'APPROVED';
};

const templateSchema = z
  .object({
    key: z.string().regex(KEY),
    channel: z.enum(['whatsapp', 'rcs', 'telegram', 'sms']),
    language: z.string().regex(LANGUAGE),
    name: z.string().trim().min(1).max(160),
    category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']).default('UTILITY'),
    parameterFormat: z.enum(['named', 'positional']).default('named'),
    content: z.unknown(),
    variables: z.array(variableDef).max(50).default([]),
    accountId: z.string().max(32).nullable().optional(),
    isActive: z.boolean().default(true),
  })
  .strict();

/**
 * @param {import('./context').CoreContext} ctx
 * @param {{accounts: ReturnType<typeof import('./accounts').createAccounts>}} deps
 */
function createTemplates(ctx, deps) {
  /**
   * Uploads the header sample file of a media template to Meta (Resumable
   * Upload API) and returns the handle for `example.header_handle`.
   *
   * @param {object} account - Meta account row.
   * @param {object} header - `{ format, fileId }`.
   * @returns {Promise<string>}
   * @throws {MessageGateError} CONFIG_INVALID (no sample file or app id), PROVIDER_ERROR
   */
  async function sampleHandle(account, header) {
    if (!header.fileId) throw new MessageGateError('CONFIG_INVALID', undefined, { field: 'content.header.fileId' });
    const config = deps.accounts.configOf(account);
    const appId = config.appId || ctx.config.providers.meta.embeddedSignup?.appId;
    if (!appId) throw new MessageGateError('CONFIG_INVALID', undefined, { field: 'appId' });
    const wanted = { IMAGE: 'image', VIDEO: 'video', DOCUMENT: 'document' }[header.format];
    const sample = await deps.attachments.readSample(header.fileId, 16 * 1024 * 1024);
    if (deps.attachments.MIME[sample.mimeType].kind !== wanted) {
      throw new MessageGateError('ATTACHMENT_TYPE_MISMATCH', undefined, { field: 'content.header.fileId' });
    }
    const result = await ctx.adapter('meta').uploadSample({
      appId,
      accessToken: config.accessToken,
      bytes: sample.bytes,
      fileName: sample.filename,
      mimeType: sample.mimeType,
      settings: ctx.config.providers.meta,
      fetchImpl: ctx.fetchImpl,
    });
    if (!result.ok) throw new MessageGateError('PROVIDER_ERROR', undefined, { step: 'upload', code: result.code });
    return result.handle;
  }

  /**
   * @param {object} row
   * @returns {object}
   */
  function toDto(row) {
    return {
      id: row.document_id,
      key: row.key,
      channel: row.channel,
      language: row.language,
      name: row.name,
      category: row.category,
      parameterFormat: row.parameter_format,
      content: parseJson(row.content, {}),
      variables: parseJson(row.variables, []),
      approvalStatus: row.approval_status,
      rejectionReason: row.rejection_reason || null,
      providerTemplateId: row.provider_template_id || null,
      version: Number(row.version),
      isActive: Boolean(row.is_active),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  /**
   * Validates content and derives the variable list (keeping the caller's
   * labels, examples and limits for known names).
   *
   * @param {object} data
   * @returns {{content: object, variables: object[]}}
   */
  function normalise(data) {
    const contentSchema =
      data.channel === 'whatsapp'
        ? whatsappContent
        : data.channel === 'rcs'
          ? rcsContent
          : data.channel === 'telegram'
            ? telegramContent
            : textContent(1600);
    const content = contentSchema.safeParse(data.content);
    if (!content.success) {
      throw new MessageGateError('CONFIG_INVALID', undefined, {
        field: `content.${content.error.issues[0].path.join('.')}`.slice(0, 120),
      });
    }
    const draft = { channel: data.channel, parameterFormat: data.parameterFormat, content: content.data };
    const names = engine.templateVariables(draft);
    for (const button of content.data.buttons || []) {
      if (button.type === 'COPY_CODE' && button.variable && !names.includes(button.variable))
        names.push(button.variable);
    }
    const given = new Map((data.variables || []).map((v) => [v.name, v]));
    const variables = names.map((name) => variableDef.parse({ ...(given.get(name) || {}), name }));
    return { content: content.data, variables };
  }

  const api = {
    toDto,

    /**
     * @param {{channel?: string, status?: string, search?: string}} [filters]
     * @returns {Promise<object[]>}
     */
    async list(filters = {}) {
      const q = ctx.knex(T.templates).orderBy([{ column: 'channel' }, { column: 'key' }, { column: 'language' }]);
      if (filters.channel) q.where('channel', filters.channel);
      if (filters.status) q.where('approval_status', filters.status);
      if (filters.search)
        q.where(
          'key',
          'like',
          `%${String(filters.search)
            .replace(/[%_\\]/g, '\\$&')
            .slice(0, 60)}%`
        );
      return (await q.limit(500)).map(toDto);
    },

    /**
     * @param {string} documentId
     * @returns {Promise<object|null>}
     */
    async getRow(documentId) {
      return (await ctx.knex(T.templates).where('document_id', String(documentId).slice(0, 32)).first()) || null;
    },

    /**
     * Finds the active template for a channel; falls back to any language
     * when the requested one does not exist.
     *
     * @param {string} channel
     * @param {string} key
     * @param {string} [language]
     * @returns {Promise<object|null>}
     */
    async resolve(channel, key, language) {
      const rows = await ctx.knex(T.templates).where({ channel, key, is_active: true });
      if (!rows.length) return null;
      return (
        rows.find((r) => r.language === language) ||
        rows.find((r) => r.language.split('_')[0] === String(language || '').split('_')[0]) ||
        rows[0]
      );
    },

    /**
     * @param {object} input
     * @returns {Promise<object>} DTO
     */
    async create(input) {
      const parsed = templateSchema.safeParse(input);
      if (!parsed.success) {
        throw new MessageGateError('CONFIG_INVALID', undefined, {
          field: String(parsed.error.issues[0].path[0] ?? ''),
        });
      }
      const data = parsed.data;
      const { content, variables } = normalise(data);
      const now = ctx.now();
      const row = {
        document_id: newId(),
        key: data.key,
        channel: data.channel,
        language: data.language,
        name: data.name,
        category: data.category,
        parameter_format: data.parameterFormat,
        content: JSON.stringify(content),
        variables: JSON.stringify(variables),
        approval_status: initialStatus(data.channel, content),
        version: 1,
        is_active: data.isActive,
        created_at: now,
        updated_at: now,
      };
      try {
        await ctx.knex(T.templates).insert(row);
      } catch {
        throw new MessageGateError('CONFIG_INVALID', 'A template with this key, channel and language exists', {
          field: 'key',
        });
      }
      return toDto(await api.getRow(row.document_id));
    },

    /**
     * Editing an approved WhatsApp template resets it to DRAFT (Meta must
     * review the new version).
     *
     * @param {string} documentId
     * @param {object} patch
     * @returns {Promise<object>}
     */
    async update(documentId, patch) {
      const row = await api.getRow(documentId);
      if (!row) throw new MessageGateError('NOT_FOUND');
      const current = toDto(row);
      const merged = {
        key: current.key,
        channel: current.channel,
        language: current.language,
        name: patch.name ?? current.name,
        category: patch.category ?? current.category,
        parameterFormat: patch.parameterFormat ?? current.parameterFormat,
        content: patch.content ?? current.content,
        variables: patch.variables ?? current.variables,
        isActive: patch.isActive ?? current.isActive,
      };
      const parsed = templateSchema.safeParse(merged);
      if (!parsed.success) {
        throw new MessageGateError('CONFIG_INVALID', undefined, {
          field: String(parsed.error.issues[0].path[0] ?? ''),
        });
      }
      const normalised = normalise(parsed.data);
      const { variables } = normalised;
      let { content } = normalised;
      // A changed RCS card no longer matches its Twilio Content template.
      if (row.channel === 'rcs' && current.content.contentSid) {
        const strip = (value) => {
          const copy = { ...value };
          delete copy.contentSid;
          delete copy.variableOrder;
          return copy;
        };
        const sameCard = JSON.stringify(strip(content)) === JSON.stringify(strip(current.content));
        const manualSid = content.contentSid && content.contentSid !== current.content.contentSid;
        if (!manualSid) {
          content = sameCard
            ? {
                ...strip(content),
                contentSid: current.content.contentSid,
                ...(current.content.variableOrder ? { variableOrder: current.content.variableOrder } : {}),
              }
            : strip(content);
        }
      }
      const contentChanged =
        JSON.stringify(content) !== JSON.stringify(current.content) || parsed.data.category !== current.category;
      await ctx
        .knex(T.templates)
        .where('id', row.id)
        .update({
          name: parsed.data.name,
          category: parsed.data.category,
          parameter_format: parsed.data.parameterFormat,
          content: JSON.stringify(content),
          variables: JSON.stringify(variables),
          is_active: parsed.data.isActive,
          version: contentChanged ? Number(row.version) + 1 : Number(row.version),
          approval_status:
            row.channel === 'whatsapp'
              ? contentChanged
                ? 'DRAFT'
                : row.approval_status
              : initialStatus(row.channel, content),
          updated_at: ctx.now(),
        });
      return toDto(await api.getRow(documentId));
    },

    /**
     * @param {string} documentId
     * @returns {Promise<void>}
     */
    async remove(documentId) {
      const row = await api.getRow(documentId);
      if (!row) throw new MessageGateError('NOT_FOUND');
      await ctx.knex(T.templates).where('id', row.id).del();
    },

    /**
     * Renders a template with sample or given variables (admin preview).
     *
     * @param {string} documentId
     * @param {Record<string,string>} [variables]
     * @returns {Promise<{preview: string, payload: object, sms?: object}>}
     */
    async preview(documentId, variables) {
      const row = await api.getRow(documentId);
      if (!row) throw new MessageGateError('NOT_FOUND');
      const dto = toDto(row);
      const sample = Object.fromEntries(
        dto.variables.map((v) => [v.name, variables?.[v.name] ?? v.example ?? `[${v.name}]`])
      );
      try {
        return engine.render(dto, sample);
      } catch (error) {
        throw new MessageGateError(error.code || 'INVALID_VARIABLE', undefined, error.details);
      }
    },

    /**
     * Renders the active template for a key, language and channel without
     * sending (programmatic tests, `POST /templates/render`).
     *
     * @param {string} key
     * @param {string|undefined} language
     * @param {Record<string, unknown>} variables
     * @param {string} channel
     * @returns {Promise<{templateId: string, key: string, language: string, channel: string, approvalStatus: string, preview: string, payload: object, sms?: object}>}
     * @throws {MessageGateError} UNKNOWN_TEMPLATE, MISSING_VARIABLE, INVALID_VARIABLE
     */
    async render(key, language, variables, channel) {
      const row = await api.resolve(channel, key, language);
      if (!row) throw new MessageGateError('UNKNOWN_TEMPLATE');
      const dto = toDto(row);
      let rendered;
      try {
        rendered = engine.render(dto, variables || {});
      } catch (error) {
        throw new MessageGateError(error.code || 'INVALID_VARIABLE', undefined, error.details);
      }
      return {
        templateId: dto.id,
        key: dto.key,
        language: dto.language,
        channel: dto.channel,
        approvalStatus: dto.approvalStatus,
        ...rendered,
      };
    },

    /**
     * Creates the Twilio Content template (twilio/card plus twilio/text for
     * devices without RCS) of an RCS rich card and stores its Content SID.
     * Named variables become Twilio's numbered variables in a stored order.
     *
     * @param {string} documentId
     * @param {string} accountDocumentId - Twilio account (RCS or SMS, same credentials).
     * @returns {Promise<object>} DTO
     * @throws {MessageGateError} NOT_FOUND, NO_ACCOUNT, PROVIDER_ERROR
     */
    async submitToTwilio(documentId, accountDocumentId) {
      const row = await api.getRow(documentId);
      if (!row || row.channel !== 'rcs') throw new MessageGateError('NOT_FOUND');
      const account = await deps.accounts.getRow(accountDocumentId);
      if (!account || account.provider !== 'twilio') throw new MessageGateError('NO_ACCOUNT');
      const dto = toDto(row);
      const c = dto.content;
      const order = engine.templateVariables({ ...dto, parameterFormat: dto.parameterFormat });
      const numbered = (text) => engine.fillRaw(text, dto.parameterFormat, (name) => `{{${order.indexOf(name) + 1}}}`);
      const sample = (name) => dto.variables.find((v) => v.name === name)?.example || 'Sample';
      const card = { body: numbered(c.text) };
      if (c.title) card.title = numbered(c.title);
      if (c.mediaUrl) card.media = [c.mediaUrl];
      if (c.buttons?.length) {
        card.actions = c.buttons.map((b, i) =>
          b.type === 'URL'
            ? { type: 'URL', title: b.title, url: b.url }
            : b.type === 'PHONE_NUMBER'
              ? { type: 'PHONE_NUMBER', title: b.title, phone: b.phone }
              : { type: 'QUICK_REPLY', title: b.title, id: b.payload || `btn_${i + 1}` }
        );
      }
      const result = await ctx.adapter('twilio').createContent({
        config: deps.accounts.configOf(account),
        content: {
          friendlyName: `${dto.key}_${dto.language}_v${dto.version}`.slice(0, 64),
          language: dto.language.split('_')[0],
          variables: Object.fromEntries(order.map((name, i) => [String(i + 1), sample(name)])),
          card,
          text: numbered(c.title ? `${c.title}\n\n${c.text}` : c.text).slice(0, 1600),
        },
        settings: ctx.config.providers.twilio,
        fetchImpl: ctx.fetchImpl,
      });
      if (!result.ok) throw new MessageGateError('PROVIDER_ERROR', undefined, { code: result.code });
      await ctx
        .knex(T.templates)
        .where('id', row.id)
        .update({
          content: JSON.stringify({ ...c, contentSid: result.sid, variableOrder: order }),
          provider_template_id: result.sid,
          approval_status: 'APPROVED',
          updated_at: ctx.now(),
        });
      return toDto(await api.getRow(documentId));
    },

    /**
     * Builds Meta's component list (with required samples) and submits it.
     *
     * @param {string} documentId
     * @param {string} accountDocumentId
     * @returns {Promise<object>} DTO
     */
    async submitToMeta(documentId, accountDocumentId) {
      const row = await api.getRow(documentId);
      if (!row || row.channel !== 'whatsapp') throw new MessageGateError('NOT_FOUND');
      const account = await deps.accounts.getRow(accountDocumentId);
      if (!account || account.provider !== 'meta') throw new MessageGateError('NO_ACCOUNT');
      const dto = toDto(row);
      const sample = (name) => dto.variables.find((v) => v.name === name)?.example || 'Sample';
      const format = dto.parameterFormat;
      const examples = (text) => engine.placeholders(text, format);
      const components = [];
      const c = dto.content;
      if (c.header) {
        const header = { type: 'HEADER', format: c.header.format };
        if (c.header.format === 'TEXT') {
          header.text = c.header.text;
          const names = examples(c.header.text);
          if (names.length) {
            header.example =
              format === 'named'
                ? { header_text_named_params: names.map((n) => ({ param_name: n, example: sample(n) })) }
                : { header_text: names.map(sample) };
          }
        }
        if (['IMAGE', 'DOCUMENT', 'VIDEO'].includes(c.header.format)) {
          header.example = { header_handle: [await sampleHandle(account, c.header)] };
        }
        components.push(header);
      }
      const bodyNames = examples(c.body);
      const body = { type: 'BODY', text: c.body };
      if (bodyNames.length) {
        body.example =
          format === 'named'
            ? { body_text_named_params: bodyNames.map((n) => ({ param_name: n, example: sample(n) })) }
            : { body_text: [bodyNames.map(sample)] };
      }
      components.push(body);
      if (c.footer) components.push({ type: 'FOOTER', text: c.footer });
      if (c.buttons?.length) {
        components.push({
          type: 'BUTTONS',
          buttons: c.buttons.map((b) => {
            if (b.type === 'URL') {
              const names = examples(b.url);
              return {
                type: 'URL',
                text: b.text,
                url: b.url,
                ...(names.length ? { example: [b.url.replace(/\{\{[^}]+\}\}/, sample(names[0]))] } : {}),
              };
            }
            if (b.type === 'COPY_CODE') return { type: 'COPY_CODE', example: sample(b.variable) };
            return { type: 'QUICK_REPLY', text: b.text };
          }),
        });
      }
      const adapter = ctx.adapter('meta');
      const result = await adapter.submitTemplate({
        config: deps.accounts.configOf(account),
        template: {
          name: dto.key,
          language: dto.language,
          category: dto.category,
          parameterFormat: format,
          components,
        },
        settings: ctx.config.providers.meta,
        fetchImpl: ctx.fetchImpl,
      });
      if (!result.ok) throw new MessageGateError('PROVIDER_ERROR', undefined, { code: result.code });
      await ctx
        .knex(T.templates)
        .where('id', row.id)
        .update({
          provider_template_id: result.id,
          approval_status: result.status || 'PENDING',
          rejection_reason: null,
          updated_at: ctx.now(),
        });
      return toDto(await api.getRow(documentId));
    },

    /**
     * Applies Meta's template status (sync or webhook) by name and language.
     *
     * @param {{name: string, language: string, status: string, id?: string, reason?: string}} update
     * @returns {Promise<boolean>} Whether a template changed.
     */
    async applyProviderStatus(update) {
      const status = ctx.adapter('meta').TEMPLATE_STATUSES.includes(update.status) ? update.status : null;
      if (!status) return false;
      const q = ctx.knex(T.templates).where({ channel: 'whatsapp' });
      if (update.id)
        q.andWhere((w) =>
          w.where('provider_template_id', String(update.id)).orWhere({ key: update.name, language: update.language })
        );
      else q.andWhere({ key: update.name, language: update.language });
      const result = await q.update({
        approval_status: status,
        rejection_reason:
          status === 'REJECTED'
            ? String(update.reason || 'REJECTED')
                .replace(/[^A-Z0-9_]/gi, '_')
                .slice(0, 120)
            : null,
        ...(update.id ? { provider_template_id: String(update.id) } : {}),
        updated_at: ctx.now(),
      });
      const changed = Number(Array.isArray(result) ? result.length : result) > 0;
      if (changed)
        ctx.emit('messagegate.template.status-changed', {
          name: update.name,
          language: update.language,
          status,
          at: ctx.now(),
        });
      return changed;
    },

    /**
     * Pulls every template of a Meta account and updates statuses.
     *
     * @param {string} accountDocumentId
     * @returns {Promise<{updated: number, unknown: number}>}
     */
    async syncFromMeta(accountDocumentId) {
      const account = await deps.accounts.getRow(accountDocumentId);
      if (!account || account.provider !== 'meta') throw new MessageGateError('NO_ACCOUNT');
      const remote = await ctx.adapter('meta').listTemplates({
        config: deps.accounts.configOf(account),
        settings: ctx.config.providers.meta,
        fetchImpl: ctx.fetchImpl,
      });
      let updated = 0;
      let unknown = 0;
      for (const t of remote) {
        if (await api.applyProviderStatus({ name: t.name, language: t.language, status: t.status, id: t.id }))
          updated += 1;
        else unknown += 1;
      }
      return { updated, unknown };
    },
  };
  return api;
}

module.exports = { createTemplates, templateSchema, needsContent };
