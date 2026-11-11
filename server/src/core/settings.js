'use strict';

/**
 * Admin-editable settings, stored as one JSON row in `mg_meta` with a
 * revision counter. Saves are compare-and-swap on the revision, so two admins
 * saving at the same time get a STATE_CHANGED error instead of overwriting
 * each other. Every process re-reads the row at most every few seconds.
 */
const { z } = require('zod');
const { T } = require('../store/schema');
const { affected } = require('../store/coordination');
const { MessageGateError } = require('../utils/errors');
const { parseJson } = require('./context');
const { DEFAULT_INBOUND_TYPES } = require('../utils/filetype');

/** Events an owner can forward to the outgoing webhook. */
const HOOK_EVENTS = ['message.received', 'message.status', 'media.ready', 'media.failed'];

const CHANNELS = ['whatsapp', 'rcs', 'telegram', 'sms', 'email'];
const channelList = z
  .array(z.enum(CHANNELS))
  .min(1)
  .max(5)
  .refine((list) => new Set(list).size === list.length, { message: 'channels must be unique' });

const settingsSchema = z
  .object({
    defaultCountry: z.string().regex(/^[A-Z]{2}$/),
    requireConsent: z.boolean(),
    optOutKeywords: z.array(z.string().trim().min(2).max(24)).max(20),
    routing: z
      .object({
        defaultChain: channelList,
        rules: z
          .array(
            z
              .object({
                id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
                name: z.string().trim().min(1).max(80),
                templateKeys: z.array(z.string().max(120)).max(50).default([]),
                countries: z
                  .array(z.string().regex(/^[A-Z]{2}$/))
                  .max(50)
                  .default([]),
                tags: z.array(z.string().max(40)).max(20).default([]),
                chain: channelList,
              })
              .strict()
          )
          .max(50),
      })
      .strict(),
    fallback: z
      .object({
        emailEnabled: z.boolean(),
        emailTemplateReferenceId: z.number().int().positive().nullable(),
      })
      .strict(),
    lookup: z
      .object({
        enabled: z.boolean(),
        accountId: z.string().max(32).nullable(),
        cacheDays: z.number().int().min(1).max(365),
        monthlyBudget: z.number().int().min(0).max(1_000_000),
        // seven.io HLR (is the number assigned and active), shares the budget.
        hlrEnabled: z.boolean(),
        hlrAccountId: z.string().max(32).nullable(),
        blockInactiveNumbers: z.boolean(),
      })
      .strict(),
    attachments: z
      .object({
        linkTtlHours: z.number().int().min(1).max(720),
      })
      .strict(),
    inbound: z
      .object({
        retentionDays: z.number().int().min(1).max(3650),
        // SMS has no reply context: an SMS/RCS answer within this window is
        // linked to the last outbound message to the contact.
        replyWindowHours: z.number().int().min(1).max(720),
      })
      .strict(),
    inboundMedia: z
      .object({
        storage: z.enum(['media-library', 'none']),
        maxMb: z.number().int().min(1).max(100),
        allowedTypes: z.array(z.enum(DEFAULT_INBOUND_TYPES)).max(DEFAULT_INBOUND_TYPES.length),
      })
      .strict(),
    outgoingWebhook: z
      .object({
        enabled: z.boolean(),
        // https is enforced on save and before every delivery; http only with
        // the development flag outgoingWebhooks.allowPrivateHosts.
        url: z
          .string()
          .url()
          .max(500)
          .regex(/^https?:\/\//)
          .nullable(),
        events: z.array(z.enum(HOOK_EVENTS)).max(HOOK_EVENTS.length),
      })
      .strict(),
    retention: z
      .object({
        messageDays: z.number().int().min(1).max(3650),
        receiptDays: z.number().int().min(1).max(90),
      })
      .strict(),
  })
  .strict();

const DEFAULTS = Object.freeze({
  defaultCountry: 'DE',
  requireConsent: true,
  optOutKeywords: ['STOP', 'STOPP', 'ABMELDEN', 'UNSUBSCRIBE'],
  routing: { defaultChain: ['whatsapp', 'rcs', 'sms'], rules: [] },
  // E-mail is opt-in: MessageGate never sends e-mail itself, it only hands
  // the message to Magic Mail when this is turned on.
  fallback: { emailEnabled: false, emailTemplateReferenceId: null },
  lookup: {
    enabled: false,
    accountId: null,
    cacheDays: 30,
    monthlyBudget: 500,
    hlrEnabled: false,
    hlrAccountId: null,
    blockInactiveNumbers: false,
  },
  attachments: { linkTtlHours: 72 },
  inbound: { retentionDays: 90, replyWindowHours: 72 },
  inboundMedia: { storage: 'media-library', maxMb: 25, allowedTypes: [...DEFAULT_INBOUND_TYPES] },
  outgoingWebhook: { enabled: false, url: null, events: ['message.received', 'message.status'] },
  retention: { messageDays: 90, receiptDays: 7 },
});

const CACHE_MS = 3_000;

/**
 * Merges stored or submitted settings with the defaults, one level deep, so
 * settings written by an older version (or an older admin) gain new keys such
 * as `lookup.hlrEnabled` instead of failing validation.
 *
 * @param {object} value
 * @returns {object}
 */
function withDefaults(value) {
  const merged = structuredClone(DEFAULTS);
  for (const [key, item] of Object.entries(value && typeof value === 'object' ? value : {})) {
    const base = merged[key];
    const nested = (v) => v && typeof v === 'object' && !Array.isArray(v);
    merged[key] = nested(base) && nested(item) ? { ...base, ...item } : item;
  }
  return merged;
}

/**
 * @param {import('./context').CoreContext} ctx
 */
function createSettings(ctx) {
  let cache = null;

  /**
   * @returns {Promise<{value: object, revision: number}>}
   */
  async function read() {
    const row = await ctx.knex(T.meta).where('meta_key', 'settings').first();
    if (!row) return { value: structuredClone(DEFAULTS), revision: 0 };
    const stored = parseJson(row.meta_value, {});
    const merged = withDefaults(stored);
    const parsed = settingsSchema.safeParse(merged);
    return { value: parsed.success ? parsed.data : structuredClone(DEFAULTS), revision: Number(row.revision) };
  }

  return {
    DEFAULTS,
    schema: settingsSchema,

    /**
     * Current settings (cached for a few seconds per process).
     *
     * @returns {Promise<object>}
     */
    async get() {
      if (cache && ctx.now() - cache.at < CACHE_MS) return cache.value;
      const { value, revision } = await read();
      cache = { value, revision, at: ctx.now() };
      return value;
    },

    /**
     * @returns {Promise<{value: object, revision: number}>}
     */
    async getWithRevision() {
      const result = await read();
      cache = { ...result, at: ctx.now() };
      return result;
    },

    /**
     * Saves settings when the caller still has the latest revision.
     *
     * @param {object} input - Full settings object.
     * @param {number} expectedRevision
     * @returns {Promise<{value: object, revision: number}>}
     * @throws {MessageGateError} CONFIG_INVALID, STATE_CHANGED
     */
    async save(input, expectedRevision) {
      const parsed = settingsSchema.safeParse(withDefaults(input));
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new MessageGateError('CONFIG_INVALID', undefined, { path: issue.path.join('.').slice(0, 120) });
      }
      const text = JSON.stringify(parsed.data);
      const now = ctx.now();
      if (!expectedRevision) {
        try {
          await ctx.knex(T.meta).insert({ meta_key: 'settings', meta_value: text, revision: 1, updated_at: now });
          cache = null;
          return { value: parsed.data, revision: 1 };
        } catch {
          throw new MessageGateError('STATE_CHANGED');
        }
      }
      const result = await ctx
        .knex(T.meta)
        .where({ meta_key: 'settings', revision: expectedRevision })
        .update({ meta_value: text, revision: expectedRevision + 1, updated_at: now });
      if (affected(result) !== 1) throw new MessageGateError('STATE_CHANGED');
      cache = null;
      return { value: parsed.data, revision: expectedRevision + 1 };
    },
  };
}

module.exports = { createSettings, DEFAULTS, settingsSchema, CHANNELS, withDefaults, HOOK_EVENTS };
