'use strict';

/**
 * Channel accounts: one WhatsApp number, Telegram bot or SMS provider login
 * each. Secrets are stored encrypted (AES-256-GCM, purpose `account-config`)
 * and never leave the server; DTOs only show which secrets are set.
 */
const crypto = require('node:crypto');
const { z } = require('zod');
const { T } = require('../store/schema');
const { PROVIDERS_BY_CHANNEL } = require('../adapters');
const { seal, tryOpen, randomToken } = require('../utils/crypto');
const { MessageGateError } = require('../utils/errors');
const { newId, parseJson } = require('./context');

const PURPOSE = 'account-config';

/** Embedded Signup result events that create an account (Meta session events). */
const SIGNUP_EVENTS = ['FINISH', 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'];

const embeddedSignupSchema = z
  .object({
    code: z.string().trim().min(10).max(2048),
    event: z.enum(SIGNUP_EVENTS),
    wabaId: z.string().regex(/^\d{5,25}$/),
    phoneNumberId: z.string().regex(/^\d{5,25}$/),
    businessId: z
      .string()
      .regex(/^\d{5,25}$/)
      .optional(),
    name: z.string().trim().min(1).max(120),
    isDefault: z.boolean().default(false),
  })
  .strict();
const secret = (max = 512) => z.string().trim().min(8).max(max);

/** Config schema per provider; `secretKeys` lists values that are masked. */
const PROVIDER_CONFIG = Object.freeze({
  meta: {
    schema: z
      .object({
        accessToken: secret(1024),
        phoneNumberId: z.string().regex(/^\d{5,25}$/),
        wabaId: z.string().regex(/^\d{5,25}$/),
        appSecret: secret(256),
        verifyToken: z
          .string()
          .regex(/^[A-Za-z0-9_-]{16,128}$/)
          .optional(),
        graphVersion: z
          .string()
          .regex(/^v\d{1,3}\.\d$/)
          .optional(),
        // Set by Embedded Signup: how the number was connected.
        onboarding: z.enum(['manual', 'embedded']).optional(),
        coexistence: z.boolean().optional(),
        businessId: z
          .string()
          .regex(/^\d{5,25}$/)
          .optional(),
        twoStepPin: z
          .string()
          .regex(/^\d{6}$/)
          .optional(),
        // Meta app id: needed for the Resumable Upload API (media template samples).
        appId: z
          .string()
          .regex(/^\d{5,25}$/)
          .optional(),
      })
      .strict(),
    secretKeys: ['accessToken', 'appSecret', 'verifyToken', 'twoStepPin'],
    generated: { verifyToken: () => randomToken(24) },
  },
  telegram: {
    schema: z
      .object({
        botToken: z.string().regex(/^\d{3,20}:[A-Za-z0-9_-]{20,80}$/),
        botUsername: z
          .string()
          .regex(/^[A-Za-z0-9_]{3,64}$/)
          .optional(),
        secretToken: z
          .string()
          .regex(/^[A-Za-z0-9_-]{16,256}$/)
          .optional(),
      })
      .strict(),
    secretKeys: ['botToken', 'secretToken'],
    generated: { secretToken: () => randomToken(32) },
  },
  seven: {
    schema: z
      .object({
        apiKey: secret(256),
        signingKey: secret(256),
        senderId: z
          .string()
          .regex(/^[A-Za-z0-9 ]{1,11}$|^\+?\d{3,16}$/)
          .optional(),
      })
      .strict(),
    secretKeys: ['apiKey', 'signingKey'],
    generated: {},
  },
  twilio: {
    schema: z
      .object({
        accountSid: z.string().regex(/^AC[0-9a-f]{32}$/),
        authToken: z.string().regex(/^[0-9a-f]{32}$/),
        apiKeySid: z
          .string()
          .regex(/^SK[0-9a-f]{32}$/)
          .optional(),
        apiKeySecret: secret(128).optional(),
        from: z
          .string()
          .regex(/^\+\d{6,16}$|^[A-Za-z0-9 ]{1,11}$/)
          .optional(),
        messagingServiceSid: z
          .string()
          .regex(/^MG[0-9a-f]{32}$/)
          .optional(),
        // RCS only: let Twilio fall back to SMS by itself (off: MessageGate's chain decides).
        twilioFallback: z.boolean().optional(),
      })
      .strict()
      .refine((c) => Boolean(c.from || c.messagingServiceSid), { message: 'from or messagingServiceSid is required' }),
    secretKeys: ['authToken', 'apiKeySecret'],
    generated: {},
  },
});

const baseSchema = z
  .object({
    channel: z.enum(['whatsapp', 'rcs', 'telegram', 'sms']),
    provider: z.enum(['meta', 'telegram', 'seven', 'twilio']),
    name: z.string().trim().min(1).max(120),
    isActive: z.boolean().default(true),
    isDefault: z.boolean().default(false),
    priority: z.number().int().min(1).max(1000).default(100),
    limits: z
      .object({
        perSecond: z.number().int().min(1).max(1000).optional(),
        perDay: z.number().int().min(1).max(10_000_000).optional(),
      })
      .strict()
      .default({}),
    config: z.record(z.string(), z.unknown()),
  })
  .strict();

/**
 * @param {import('./context').CoreContext} ctx
 */
function createAccounts(ctx) {
  // An unreadable config (changed encryption key) reads as empty: the account
  // shows its secrets as unset and must be re-entered.
  const decrypt = (row) => tryOpen(row.config_sealed, PURPOSE, ctx.encryptionKey, {});

  /**
   * @param {object} row
   * @returns {object} Public DTO without secrets.
   */
  function toDto(row) {
    const provider = PROVIDER_CONFIG[row.provider];
    const config = decrypt(row);
    const publicConfig = {};
    const secretsSet = {};
    for (const [key, value] of Object.entries(config)) {
      if (provider?.secretKeys.includes(key)) secretsSet[key] = Boolean(value);
      else publicConfig[key] = value;
    }
    return {
      id: row.document_id,
      channel: row.channel,
      provider: row.provider,
      name: row.name,
      isActive: Boolean(row.is_active),
      isDefault: Boolean(row.is_default),
      priority: Number(row.priority),
      limits: parseJson(row.limits, {}),
      config: publicConfig,
      secretsSet,
      webhookUrl: webhookUrl(row),
      health: {
        status: row.health_status || 'unknown',
        code: row.health_code || null,
        at: row.health_at ? Number(row.health_at) : null,
      },
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  /**
   * @param {object} row
   * @returns {string|null}
   */
  function webhookUrl(row) {
    if (!ctx.publicUrl) return null;
    return `${ctx.publicUrl}/api/magic-messagegate/webhooks/${row.provider}/${row.webhook_path}`;
  }

  /**
   * Validates provider config; keeps stored secrets for omitted or masked values.
   *
   * @param {string} provider
   * @param {object} incoming
   * @param {object} [previous]
   * @returns {object}
   */
  function buildConfig(provider, incoming, previous = {}) {
    const spec = PROVIDER_CONFIG[provider];
    const merged = { ...previous };
    for (const [key, value] of Object.entries(incoming || {})) {
      if (value === undefined || value === null) continue;
      if (spec.secretKeys.includes(key) && (value === '' || /^\*+$/.test(String(value)))) continue;
      merged[key] = typeof value === 'string' ? value.trim() : value;
    }
    for (const [key, make] of Object.entries(spec.generated)) if (!merged[key]) merged[key] = make();
    const parsed = spec.schema.safeParse(merged);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new MessageGateError('CONFIG_INVALID', undefined, {
        field: String(issue.path[0] ?? 'config'),
        reason: issue.message.slice(0, 120),
      });
    }
    return parsed.data;
  }

  const api = {
    PROVIDER_CONFIG,
    toDto,

    /**
     * @returns {Promise<object[]>}
     */
    async list() {
      const rows = await ctx
        .knex(T.accounts)
        .orderBy([{ column: 'channel' }, { column: 'priority' }, { column: 'id' }]);
      return rows.map(toDto);
    },

    /**
     * @param {string} documentId
     * @returns {Promise<object|null>} Raw row.
     */
    async getRow(documentId) {
      return (await ctx.knex(T.accounts).where('document_id', String(documentId).slice(0, 32)).first()) || null;
    },

    /**
     * @param {number} id
     * @returns {Promise<object|null>}
     */
    async getRowById(id) {
      return (await ctx.knex(T.accounts).where('id', id).first()) || null;
    },

    /**
     * @param {string} provider
     * @param {string} webhookPath
     * @returns {Promise<object|null>}
     */
    async byWebhookPath(provider, webhookPath) {
      if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(webhookPath))) return null;
      return (await ctx.knex(T.accounts).where({ provider, webhook_path: webhookPath }).first()) || null;
    },

    /** Decrypted config of an account row (server side only). */
    configOf: decrypt,

    /**
     * Active accounts for a channel in send order (default first, then priority).
     *
     * @param {string} channel
     * @returns {Promise<object[]>}
     */
    async forChannel(channel) {
      return ctx
        .knex(T.accounts)
        .where({ channel, is_active: true })
        .orderBy([{ column: 'is_default', order: 'desc' }, { column: 'priority' }, { column: 'id' }]);
    },

    /**
     * @param {object} input
     * @returns {Promise<object>} DTO
     */
    async create(input) {
      const parsed = baseSchema.safeParse(input);
      if (!parsed.success) {
        throw new MessageGateError('CONFIG_INVALID', undefined, {
          field: String(parsed.error.issues[0].path[0] ?? ''),
        });
      }
      const data = parsed.data;
      if (!PROVIDERS_BY_CHANNEL[data.channel].includes(data.provider)) {
        throw new MessageGateError('CONFIG_INVALID', undefined, { field: 'provider' });
      }
      const config = buildConfig(data.provider, data.config);
      // RCS goes through the Messaging Service that holds the RCS sender.
      if (data.channel === 'rcs' && !config.messagingServiceSid) {
        throw new MessageGateError('CONFIG_INVALID', undefined, { field: 'messagingServiceSid' });
      }
      const now = ctx.now();
      const row = {
        document_id: newId(),
        channel: data.channel,
        provider: data.provider,
        name: data.name,
        is_active: data.isActive,
        is_default: data.isDefault,
        priority: data.priority,
        config_sealed: seal(config, PURPOSE, ctx.encryptionKey),
        webhook_path: randomToken(24),
        limits: JSON.stringify(data.limits),
        health_status: 'unknown',
        created_at: now,
        updated_at: now,
      };
      await ctx.knex.transaction(async (trx) => {
        if (data.isDefault)
          await trx(T.accounts).where({ channel: data.channel }).update({ is_default: false, updated_at: now });
        await trx(T.accounts).insert(row);
      });
      const saved = await api.getRow(row.document_id);
      return toDto(saved);
    },

    /**
     * @param {string} documentId
     * @param {object} patch - name, isActive, isDefault, priority, limits, config (partial).
     * @returns {Promise<object>} DTO
     */
    async update(documentId, patch) {
      const row = await api.getRow(documentId);
      if (!row) throw new MessageGateError('NOT_FOUND');
      const partial = baseSchema
        .partial()
        .omit({ channel: true, provider: true })
        .safeParse(patch || {});
      if (!partial.success) {
        throw new MessageGateError('CONFIG_INVALID', undefined, {
          field: String(partial.error.issues[0].path[0] ?? ''),
        });
      }
      const data = partial.data;
      const now = ctx.now();
      const update = { updated_at: now };
      if (data.name !== undefined) update.name = data.name;
      if (data.isActive !== undefined) update.is_active = data.isActive;
      if (data.isDefault !== undefined) update.is_default = data.isDefault;
      if (data.priority !== undefined) update.priority = data.priority;
      if (data.limits !== undefined) update.limits = JSON.stringify(data.limits);
      if (data.config !== undefined) {
        const config = buildConfig(row.provider, data.config, decrypt(row));
        if (row.channel === 'rcs' && !config.messagingServiceSid) {
          throw new MessageGateError('CONFIG_INVALID', undefined, { field: 'messagingServiceSid' });
        }
        update.config_sealed = seal(config, PURPOSE, ctx.encryptionKey);
      }
      await ctx.knex.transaction(async (trx) => {
        if (data.isDefault)
          await trx(T.accounts).where({ channel: row.channel }).whereNot('id', row.id).update({ is_default: false });
        await trx(T.accounts).where('id', row.id).update(update);
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
      await ctx.knex(T.accounts).where('id', row.id).del();
    },

    /**
     * Records the health of an account after a send or a test.
     *
     * @param {number} id
     * @param {boolean} ok
     * @param {string|null} code
     * @returns {Promise<void>}
     */
    async setHealth(id, ok, code) {
      await ctx
        .knex(T.accounts)
        .where('id', id)
        .update({
          health_status: ok ? 'ok' : 'error',
          health_code: ok ? null : String(code || 'ERROR').slice(0, 64),
          health_at: ctx.now(),
        });
    },

    /**
     * Calls the provider to check the credentials. For Telegram the webhook
     * is (re)registered when a public URL is configured.
     *
     * @param {string} documentId
     * @returns {Promise<{ok: boolean, code: string|null, info: object}>}
     */
    /**
     * Completes Meta Embedded Signup on the server: exchanges the 30-second
     * code for a business token, subscribes the app to the WABA, registers a
     * new number (random two-step PIN, stored encrypted) or, for a WhatsApp
     * Business App number (Coexistence), skips registration and starts the
     * one-time contacts and history syncs. The app secret never leaves the
     * server: it comes from the plugin config.
     *
     * @param {object} input - See embeddedSignupSchema.
     * @returns {Promise<{account: object, steps: object}>}
     * @throws {MessageGateError} EMBEDDED_SIGNUP_DISABLED, CONFIG_INVALID, PROVIDER_ERROR
     */
    async completeEmbeddedSignup(input) {
      const signup = ctx.config.providers.meta.embeddedSignup || {};
      if (!signup.appId || !signup.appSecret || !signup.configId) {
        throw new MessageGateError('EMBEDDED_SIGNUP_DISABLED');
      }
      const parsed = embeddedSignupSchema.safeParse(input || {});
      if (!parsed.success) {
        throw new MessageGateError('CONFIG_INVALID', undefined, {
          field: String(parsed.error.issues[0].path[0] ?? ''),
        });
      }
      const data = parsed.data;
      const adapter = ctx.adapter('meta');
      const settings = ctx.config.providers.meta || {};
      const exchanged = await adapter.exchangeCode({
        appId: signup.appId,
        appSecret: signup.appSecret,
        code: data.code,
        settings,
        fetchImpl: ctx.fetchImpl,
      });
      if (!exchanged.ok)
        throw new MessageGateError('PROVIDER_ERROR', undefined, { step: 'exchange', reason: exchanged.code });

      const coexistence = data.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING';
      const config = {
        accessToken: exchanged.accessToken,
        phoneNumberId: data.phoneNumberId,
        wabaId: data.wabaId,
        appSecret: signup.appSecret,
        onboarding: 'embedded',
        coexistence,
        ...(data.businessId ? { businessId: data.businessId } : {}),
        ...(coexistence ? {} : { twoStepPin: String(crypto.randomInt(100000, 1000000)) }),
      };
      const steps = { exchange: 'ok', subscribe: null, register: null, contactsSync: null, historySync: null };
      const sub = await adapter.subscribeApp({ config, settings, fetchImpl: ctx.fetchImpl });
      steps.subscribe = sub.ok ? 'ok' : sub.code;
      if (!sub.ok) throw new MessageGateError('PROVIDER_ERROR', undefined, { step: 'subscribe', reason: sub.code });
      if (coexistence) {
        const contacts = await adapter.startBusinessAppSync({
          config,
          syncType: 'smb_app_state_sync',
          settings,
          fetchImpl: ctx.fetchImpl,
        });
        steps.contactsSync = contacts.ok ? 'started' : contacts.code;
        const history = await adapter.startBusinessAppSync({
          config,
          syncType: 'history',
          settings,
          fetchImpl: ctx.fetchImpl,
        });
        steps.historySync = history.ok ? 'started' : history.code;
      } else {
        const reg = await adapter.registerNumber({
          config,
          pin: config.twoStepPin,
          settings,
          fetchImpl: ctx.fetchImpl,
        });
        steps.register = reg.ok ? 'ok' : reg.code;
        if (!reg.ok) throw new MessageGateError('PROVIDER_ERROR', undefined, { step: 'register', reason: reg.code });
      }
      const account = await api.create({
        channel: 'whatsapp',
        provider: 'meta',
        name: data.name,
        isDefault: data.isDefault,
        config,
      });
      return { account, steps };
    },

    /**
     * Meta webhook verify token of a manually connected number (admin only).
     *
     * @param {string} documentId
     * @returns {Promise<{verifyToken: string|null}>}
     */
    async verifyToken(documentId) {
      const row = await api.getRow(documentId);
      if (!row || row.provider !== 'meta') throw new MessageGateError('NOT_FOUND');
      return { verifyToken: decrypt(row).verifyToken || null };
    },

    /**
     * Calls the provider with the stored credentials and records the health.
     *
     * @param {string} documentId
     * @returns {Promise<{ok: boolean, code: string|null, info: object}>}
     */
    async testConnection(documentId) {
      const row = await api.getRow(documentId);
      if (!row) throw new MessageGateError('NOT_FOUND');
      const adapter = ctx.adapter(row.provider);
      const config = decrypt(row);
      const settings = ctx.config.providers[row.provider] || {};
      const result = await adapter.testConnection({ config, settings, fetchImpl: ctx.fetchImpl });
      if (result.ok && row.provider === 'telegram' && webhookUrl(row)) {
        const hook = await adapter.setWebhook({
          config,
          webhookUrl: webhookUrl(row),
          secretToken: config.secretToken,
          settings,
          fetchImpl: ctx.fetchImpl,
        });
        result.info.webhook = hook.ok ? 'registered' : 'failed';
        if (result.info.username && result.info.username !== config.botUsername) {
          await ctx
            .knex(T.accounts)
            .where('id', row.id)
            .update({
              config_sealed: seal({ ...config, botUsername: result.info.username }, PURPOSE, ctx.encryptionKey),
            });
        }
      }
      await api.setHealth(row.id, result.ok, result.code);
      return result;
    },
  };
  return api;
}

module.exports = { createAccounts, PROVIDER_CONFIG };
