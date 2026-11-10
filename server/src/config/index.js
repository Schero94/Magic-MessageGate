'use strict';

/**
 * Plugin configuration (`config/plugins.js` → `'magic-messagegate': { config: { … } }`).
 *
 * Only infrastructure settings live here. Business settings (routing,
 * opt-out keywords, lookup budget, retention) are edited in the admin and
 * stored in the database (services/settings.js); these values are their
 * defaults. Provider base URLs exist for tests with local fake servers and
 * must never come from user input.
 */
const { z } = require('zod');

const url = z.string().url().max(500);
/** Send timeout per provider request; a timeout counts as `uncertain`. */
const timeoutMs = z.number().int().min(100).max(60_000).optional();

const schema = z
  .object({
    encryptionKey: z.string().min(16).max(512).optional(),
    publicUrl: url.optional(),
    defaultCountry: z.string().length(2).default('DE'),
    worker: z
      .object({
        enabled: z.boolean().default(true),
        intervalMs: z.number().int().min(250).max(600_000).default(5_000),
        batchSize: z.number().int().min(1).max(100).default(10),
        concurrency: z.number().int().min(1).max(20).default(2),
        leaseMs: z.number().int().min(10_000).max(3_600_000).default(120_000),
      })
      .strict()
      .prefault({}),
    retry: z
      .object({
        delaysMs: z
          .array(z.number().int().min(1_000).max(86_400_000))
          .min(1)
          .max(10)
          .default([60_000, 300_000, 900_000]),
        jitter: z.number().min(0).max(0.5).default(0.2),
      })
      .strict()
      .prefault({}),
    defaultNotAfterHours: z.number().int().min(1).max(720).default(24),
    rateLimits: z
      .object({
        sendPerMinute: z.number().int().min(1).max(100_000).default(120),
        webhookPerMinute: z.number().int().min(10).max(1_000_000).default(1_200),
        adminWritePerMinute: z.number().int().min(1).max(10_000).default(60),
        lookupPerMinute: z.number().int().min(1).max(10_000).default(30),
      })
      .strict()
      .prefault({}),
    providers: z
      .object({
        meta: z
          .object({
            baseUrl: url.optional(),
            timeoutMs,
            graphVersion: z
              .string()
              .regex(/^v\d{1,3}\.\d$/)
              .optional(),
            // Meta Embedded Signup (README "Connect WhatsApp"): app ID and
            // configuration ID are public; the app secret stays on the server.
            embeddedSignup: z
              .object({
                appId: z
                  .string()
                  .regex(/^\d{5,25}$/)
                  .optional(),
                configId: z
                  .string()
                  .regex(/^\d{5,25}$/)
                  .optional(),
                appSecret: z.string().min(16).max(256).optional(),
              })
              .strict()
              .prefault({}),
          })
          .strict()
          .prefault({}),
        telegram: z.object({ baseUrl: url.optional(), timeoutMs }).strict().prefault({}),
        seven: z.object({ baseUrl: url.optional(), timeoutMs }).strict().prefault({}),
        twilio: z.object({ baseUrl: url.optional(), lookupBaseUrl: url.optional(), timeoutMs }).strict().prefault({}),
      })
      .strict()
      .prefault({}),
  })
  .strict();

module.exports = {
  default: () => schema.parse({}),
  /**
   * @param {object} config
   * @throws {Error} With a readable message when the config is invalid.
   */
  validator(config) {
    const result = schema.safeParse(config);
    if (!result.success) {
      const issue = result.error.issues[0];
      throw new Error(`[magic-messagegate] invalid config at ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    }
  },
  schema,
};
