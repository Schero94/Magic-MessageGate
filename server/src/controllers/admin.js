'use strict';

/**
 * Admin API (Strapi admin JWT + RBAC policies on every route, see
 * routes/admin.js). Request bodies are validated with strict zod schemas in
 * the core; ids are bounded strings. Secrets never leave the server.
 */
const { z } = require('zod');
const services = require('../services');

const { coreFor } = services;
const { handle, sendError } = require('./respond');
const { hit } = require('../store/coordination');
const { MessageGateError } = require('../utils/errors');

const id = z.string().regex(/^[a-z0-9]{6,32}$/);
const channel = z.enum(['whatsapp', 'telegram', 'sms']);

/**
 * @param {object} ctx
 * @returns {string}
 */
function paramId(ctx) {
  const parsed = id.safeParse(ctx.params?.id);
  if (!parsed.success) throw new MessageGateError('NOT_FOUND');
  return parsed.data;
}

/**
 * Shared write limit per admin user.
 *
 * @param {object} strapi
 * @param {object} ctx
 * @returns {Promise<boolean>} false when limited (response already set).
 */
async function writeLimit(strapi, ctx) {
  const core = coreFor(strapi);
  const userId = ctx.state?.user?.id ?? 'anon';
  const hits = await hit(core.ctx.knex, `admin-write:${userId}`, 60_000, 1, core.ctx.now());
  if (hits > core.ctx.config.rateLimits.adminWritePerMinute) {
    sendError(ctx, 429, 'RATE_LIMITED', 'Too many requests, try again later');
    return false;
  }
  return true;
}

/**
 * @param {object} query
 * @returns {object}
 */
function listQuery(query = {}) {
  const schema = z
    .object({
      page: z.coerce.number().int().min(1).max(2000).optional(),
      pageSize: z.coerce.number().int().min(1).max(100).optional(),
      status: z.enum(['queued', 'sent', 'delivered', 'read', 'failed', 'uncertain', 'expired', 'discarded']).optional(),
      channel: channel.optional(),
      templateKey: z
        .string()
        .regex(/^[a-z][a-z0-9_]{0,119}$/)
        .optional(),
      from: z.coerce.number().int().positive().optional(),
      to: z.coerce.number().int().positive().optional(),
      phone: z.string().max(40).optional(),
      search: z.string().max(60).optional(),
    })
    .strip();
  const parsed = schema.safeParse(query);
  if (!parsed.success)
    throw new MessageGateError('INVALID_REQUEST', undefined, { field: String(parsed.error.issues[0].path[0]) });
  return parsed.data;
}

module.exports = ({ strapi }) => {
  const core = () => coreFor(strapi);
  const write = (fn) => async (ctx) => {
    if (!(await writeLimit(strapi, ctx))) return;
    await handle(ctx, () => fn(ctx), strapi);
  };
  const read = (fn) => async (ctx) => handle(ctx, () => fn(ctx), strapi);

  /**
   * Public Embedded Signup values; the app secret never leaves the server.
   *
   * @returns {{enabled: boolean, appId: string|null, configId: string|null, graphVersion: string, webhookUrl: string|null}}
   */
  const signupInfo = () => {
    const c = core();
    const signup = c.ctx.config.providers.meta.embeddedSignup || {};
    return {
      enabled: Boolean(signup.appId && signup.configId && signup.appSecret),
      appId: signup.appId || null,
      configId: signup.configId || null,
      graphVersion: c.ctx.config.providers.meta.graphVersion || 'v23.0',
      webhookUrl:
        signup.verifyToken && c.ctx.publicUrl ? `${c.ctx.publicUrl}/api/magic-messagegate/webhooks/meta/app` : null,
    };
  };

  return {
    // Accounts
    embeddedSignupConfig: read(() => signupInfo()),
    listAccounts: read(() => core().accounts.list()),
    createAccount: write((ctx) => core().accounts.create(ctx.request.body || {})),
    updateAccount: write((ctx) => core().accounts.update(paramId(ctx), ctx.request.body || {})),
    deleteAccount: write(async (ctx) => {
      await core().accounts.remove(paramId(ctx));
      return { deleted: true };
    }),
    completeEmbeddedSignup: write((ctx) => core().accounts.completeEmbeddedSignup(ctx.request.body || {})),
    testAccount: write((ctx) => core().accounts.testConnection(paramId(ctx))),
    // The Meta verify token must be pasted into the Meta app dashboard for
    // manually connected numbers; POST (not GET) keeps it out of caches and logs.
    revealVerifyToken: write((ctx) => core().accounts.verifyToken(paramId(ctx))),
    syncTemplates: write((ctx) => core().templates.syncFromMeta(paramId(ctx))),

    // Templates
    listTemplates: read((ctx) => {
      const q = z
        .object({
          channel: channel.optional(),
          status: z.string().max(24).optional(),
          search: z.string().max(60).optional(),
        })
        .strip()
        .parse(ctx.query || {});
      return core().templates.list(q);
    }),
    getTemplate: read(async (ctx) => {
      const row = await core().templates.getRow(paramId(ctx));
      if (!row) throw new MessageGateError('NOT_FOUND');
      return core().templates.toDto(row);
    }),
    createTemplate: write((ctx) => core().templates.create(ctx.request.body || {})),
    updateTemplate: write((ctx) => core().templates.update(paramId(ctx), ctx.request.body || {})),
    deleteTemplate: write(async (ctx) => {
      await core().templates.remove(paramId(ctx));
      return { deleted: true };
    }),
    previewTemplate: read((ctx) => {
      const vars = z.record(z.string().max(60), z.string().max(1024)).optional().parse(ctx.request.body?.variables);
      return core().templates.preview(paramId(ctx), vars);
    }),
    submitTemplate: write((ctx) => {
      const accountId = id.parse(ctx.request.body?.accountId);
      return core().templates.submitToMeta(paramId(ctx), accountId);
    }),

    // Messages
    listMessages: read((ctx) => core().outbox.list(listQuery(ctx.query))),
    getMessage: read((ctx) => core().outbox.detail(paramId(ctx))),
    sendMessage: write((ctx) => core().sender.send(ctx.request.body || {}, { source: 'admin' })),
    retryMessage: write((ctx) =>
      core().outbox.retry(paramId(ctx), { confirmDuplicateRisk: ctx.request.body?.confirmDuplicateRisk === true })
    ),
    discardMessage: write((ctx) => core().outbox.discard(paramId(ctx))),
    markMessageSent: write((ctx) => core().outbox.markSent(paramId(ctx))),

    // Contacts
    listContacts: read(async (ctx) => {
      const settings = await core().settings.get();
      return core().contacts.list({ ...listQuery(ctx.query), country: settings.defaultCountry });
    }),
    getContact: read(async (ctx) => {
      const row = await core().contacts.getRow(paramId(ctx));
      if (!row) throw new MessageGateError('NOT_FOUND');
      return core().contacts.dto(row);
    }),
    upsertContact: write(async (ctx) => {
      const body = z
        .object({
          phone: z.string().max(40),
          userId: z.number().int().positive().optional(),
          locale: z.string().max(16).optional(),
        })
        .strict()
        .parse(ctx.request.body || {});
      const settings = await core().settings.get();
      const { row } = await core().contacts.upsertByPhone(body.phone, { ...body, country: settings.defaultCountry });
      return core().contacts.dto(row);
    }),
    setConsent: write(async (ctx) => {
      const body = z
        .object({ channel, status: z.enum(['granted', 'revoked']) })
        .strict()
        .parse(ctx.request.body || {});
      const row = await core().contacts.getRow(paramId(ctx));
      if (!row) throw new MessageGateError('NOT_FOUND');
      await core().contacts.setConsent(row.id, body.channel, body.status, 'admin');
      return core().contacts.dto(await core().contacts.getRowById(row.id));
    }),
    removeSuppression: write(async (ctx) => {
      const ch = channel.parse(ctx.params?.channel);
      const row = await core().contacts.getRow(paramId(ctx));
      if (!row) throw new MessageGateError('NOT_FOUND');
      await core().contacts.unsuppress(row.id, ch);
      // Clearing the WhatsApp block also forgets the learned "not on WhatsApp".
      if (ch === 'whatsapp') await core().contacts.setWhatsappReachability(row.id, 'unknown');
      return core().contacts.dto(await core().contacts.getRowById(row.id));
    }),
    telegramLink: write((ctx) => services.telegram({ strapi }).createLink(paramId(ctx))),
    exportContact: read((ctx) => core().contacts.exportData(paramId(ctx))),
    eraseContact: write(async (ctx) => {
      await core().contacts.erase(paramId(ctx));
      return { erased: true };
    }),

    // Lookup, analytics, settings
    lookup: write((ctx) => {
      const body = z
        .object({ phone: z.string().max(40), remote: z.boolean().optional() })
        .strict()
        .parse(ctx.request.body || {});
      return core().lookup.check(body.phone, { remote: body.remote !== false });
    }),
    lookupBudget: read(() => core().lookup.budgetStatus()),
    analytics: read((ctx) => {
      const q = z
        .object({
          from: z.coerce.number().int().positive().optional(),
          to: z.coerce.number().int().positive().optional(),
        })
        .strip()
        .parse(ctx.query || {});
      return core().analytics.summary(q);
    }),
    getSettings: read(async () => {
      const { value, revision } = await core().settings.getWithRevision();
      return {
        settings: value,
        revision,
        magicMailInstalled: Boolean(core().ctx.magicMail),
        publicUrl: core().ctx.publicUrl || null,
        embeddedSignup: signupInfo(),
      };
    }),
    updateSettings: write(async (ctx) => {
      const body = z
        .object({ settings: z.record(z.string(), z.unknown()), revision: z.number().int().min(0) })
        .strict()
        .parse(ctx.request.body || {});
      return core().settings.save(body.settings, body.revision);
    }),
  };
};
