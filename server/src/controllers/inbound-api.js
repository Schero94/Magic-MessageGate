'use strict';

/**
 * Content API for inbound messages, their files and conversations. These
 * routes return message text and files, so they are a separate controller:
 * Strapi lists them as their own permissions (`inbound-api.*`), and a custom
 * API token only gets them when they are ticked explicitly. Same caller rule
 * as the rest of the Content API (API token; users-permissions only with
 * `contentApi.allowUsersPermissions`), rate limited per token across processes.
 */
const { z } = require('zod');
const { coreFor } = require('../services');
const { handle, sendError } = require('./respond');
const { MessageGateError } = require('../utils/errors');
const { allowedCaller, limited, bodyOf, principal } = require('./content-api');

const docId = z.string().regex(/^[a-z0-9]{6,32}$/);

/**
 * @param {object} ctx
 * @returns {string}
 */
function idParam(ctx) {
  const parsed = docId.safeParse(ctx.params?.id);
  if (!parsed.success) throw new MessageGateError('NOT_FOUND');
  return parsed.data;
}

module.exports = ({ strapi }) => {
  const core = () => coreFor(strapi);

  /**
   * Common guard: caller check and the inbound rate limit.
   *
   * @param {object} ctx
   * @returns {Promise<boolean>} true when refused
   */
  const guard = async (ctx) => {
    const c = core();
    if (!allowedCaller(ctx, c.ctx.config)) {
      sendError(ctx, 403, 'FORBIDDEN', 'Use a Strapi API token for the MessageGate Content API');
      return true;
    }
    return limited(c, ctx, 'inbound', c.ctx.config.rateLimits.inboundPerMinute);
  };

  return {
    /** GET /api/magic-messagegate/inbound */
    async list(ctx) {
      if (await guard(ctx)) return undefined;
      return handle(
        ctx,
        () => {
          const q = z
            .object({
              page: z.coerce.number().int().min(1).max(2000).optional(),
              pageSize: z.coerce.number().int().min(1).max(100).optional(),
              channel: z.enum(['whatsapp', 'rcs', 'telegram', 'sms']).optional(),
              kind: z.enum(['text', 'button', 'media', 'location', 'other']).optional(),
              contactId: docId.optional(),
              processed: z.enum(['true', 'false']).optional(),
              from: z.coerce.number().int().positive().optional(),
              to: z.coerce.number().int().positive().optional(),
            })
            .strip()
            .parse(ctx.query || {});
          return core().inbound.list({
            ...q,
            processed: q.processed === undefined ? undefined : q.processed === 'true',
          });
        },
        strapi
      );
    },

    /** GET /api/magic-messagegate/inbound/:id */
    async get(ctx) {
      if (await guard(ctx)) return undefined;
      return handle(ctx, () => core().inbound.get(idParam(ctx)), strapi);
    },

    /** POST /api/magic-messagegate/inbound/:id/processed */
    async processed(ctx) {
      if (await guard(ctx)) return undefined;
      return handle(ctx, () => core().inbound.markProcessed(idParam(ctx)), strapi);
    },

    /** GET /api/magic-messagegate/inbound/:id/media?as=stream|base64 */
    async media(ctx) {
      if (await guard(ctx)) return undefined;
      return handle(
        ctx,
        async () => {
          const as = ctx.query?.as === 'base64' ? 'base64' : 'buffer';
          const file = await core().inbound.getMedia(idParam(ctx), { as });
          if (as === 'base64') return { ...file };
          ctx.set('Content-Type', file.mime);
          ctx.set('Content-Length', String(file.size));
          ctx.set('Content-Disposition', `attachment; filename="${file.filename}"`);
          ctx.set('X-Content-Type-Options', 'nosniff');
          ctx.set('Content-Security-Policy', "default-src 'none'; sandbox");
          ctx.set('Cache-Control', 'private, no-store');
          ctx.body = file.data;
          return undefined;
        },
        strapi
      );
    },

    /** POST /api/magic-messagegate/inbound/:id/media-url */
    async mediaUrl(ctx) {
      if (await guard(ctx)) return undefined;
      return handle(
        ctx,
        () => {
          const body = z
            .object({ ttlSeconds: z.number().int().min(30).max(3600).optional() })
            .strict()
            .parse(bodyOf(ctx));
          return core().inbound.createMediaUrl(idParam(ctx), body);
        },
        strapi
      );
    },

    /** POST /api/magic-messagegate/inbound/:id/reply */
    async reply(ctx) {
      if (await guard(ctx)) return undefined;
      const c = core();
      if (await limited(c, ctx, 'send', c.ctx.config.rateLimits.sendPerMinute)) return undefined;
      return handle(
        ctx,
        async () => {
          const { dryRun, ...input } = bodyOf(ctx);
          const result = await c.reply(idParam(ctx), input, {
            source: 'content-api',
            keyScope: principal(ctx),
            dryRun: dryRun === true,
          });
          ctx.status = dryRun === true || result.duplicate ? 200 : 202;
          return result;
        },
        strapi
      );
    },

    /** GET /api/magic-messagegate/conversations/:id */
    async conversation(ctx) {
      if (await guard(ctx)) return undefined;
      return handle(
        ctx,
        () => {
          const q = z
            .object({
              limit: z.coerce.number().int().min(1).max(200).optional(),
              since: z.coerce.number().int().min(0).optional(),
              includeMedia: z.enum(['true', 'false']).optional(),
            })
            .strip()
            .parse(ctx.query || {});
          return core().inbound.history(idParam(ctx), {
            limit: q.limit,
            since: q.since,
            includeMedia: q.includeMedia !== 'false',
          });
        },
        strapi
      );
    },

    /** POST /api/magic-messagegate/sandbox/inbound (sandbox mode only) */
    async simulate(ctx) {
      if (await guard(ctx)) return undefined;
      return handle(
        ctx,
        async () => {
          const body = z
            .object({
              to: z.string().max(40).optional(),
              contactId: docId.optional(),
              channel: z.enum(['whatsapp', 'rcs', 'telegram', 'sms']).optional(),
              text: z.string().max(4096).optional(),
              buttonPayload: z.string().max(256).optional(),
              buttonTitle: z.string().max(256).optional(),
              replyTo: docId.optional(),
              providerMessageId: z.string().max(120).optional(),
              location: z
                .object({
                  latitude: z.number().min(-90).max(90),
                  longitude: z.number().min(-180).max(180),
                  name: z.string().max(200).optional(),
                  address: z.string().max(300).optional(),
                })
                .strict()
                .optional(),
              media: z
                .object({
                  mime: z.string().max(120),
                  size: z.number().int().min(1).max(209_715_200).optional(),
                  filename: z.string().max(200).optional(),
                  caption: z.string().max(1024).optional(),
                  duration: z.number().min(0).max(86_400).optional(),
                  expired: z.boolean().optional(),
                  mismatch: z.boolean().optional(),
                })
                .strict()
                .optional(),
            })
            .strict()
            .parse(bodyOf(ctx));
          ctx.status = 201;
          return core().simulateInbound(body);
        },
        strapi
      );
    },
  };
};
