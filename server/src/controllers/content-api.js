'use strict';

/**
 * Content API for apps and services (Strapi API tokens; the token needs the
 * `magic-messagegate` permissions). Sending is rate limited per token,
 * shared across processes.
 */
const { z } = require('zod');
const services = require('../services');

const { coreFor } = services;
const { handle, sendError } = require('./respond');
const { hit } = require('../store/coordination');
const { MessageGateError } = require('../utils/errors');

/**
 * @param {object} ctx
 * @returns {string}
 */
function principal(ctx) {
  const auth = ctx.state?.auth;
  if (auth?.strategy?.name === 'api-token' && auth.credentials?.id) return `token:${auth.credentials.id}`;
  if (ctx.state?.user?.id) return `user:${ctx.state.user.id}`;
  return `ip:${ctx.request.ip}`;
}

/**
 * Whether the caller may use the Content API: a Strapi API token, or a
 * users-permissions login when `contentApi.allowUsersPermissions` is on.
 *
 * @param {object} ctx
 * @param {object} config - Plugin config.
 * @returns {boolean}
 */
function allowedCaller(ctx, config) {
  const strategy = ctx.state?.auth?.strategy?.name;
  if (strategy === 'api-token') return true;
  return Boolean(config?.contentApi?.allowUsersPermissions) && strategy === 'users-permissions';
}

module.exports = ({ strapi }) => {
  const core = () => coreFor(strapi);

  /**
   * Answers 403 for callers without an API token (see allowedCaller).
   *
   * @param {object} ctx
   * @returns {boolean} true when the request was refused.
   */
  const refuse = (ctx) => {
    if (allowedCaller(ctx, core().ctx.config)) return false;
    sendError(ctx, 403, 'FORBIDDEN', 'Use a Strapi API token for the MessageGate Content API');
    return true;
  };

  return {
    /** POST /api/magic-messagegate/messages */
    async send(ctx) {
      if (refuse(ctx)) return undefined;
      const c = core();
      const key = principal(ctx);
      const hits = await hit(c.ctx.knex, `send:${key}`, 60_000, 1, c.ctx.now());
      if (hits > c.ctx.config.rateLimits.sendPerMinute) {
        ctx.set('Retry-After', '60');
        return sendError(ctx, 429, 'RATE_LIMITED', 'Too many requests, try again later');
      }
      return handle(
        ctx,
        async () => {
          const result = await c.sender.send(ctx.request.body?.data ?? ctx.request.body ?? {}, {
            source: 'content-api',
            keyScope: key,
          });
          ctx.status = result.duplicate ? 200 : 202;
          return result;
        },
        strapi
      );
    },

    /** GET /api/magic-messagegate/messages/:id */
    async status(ctx) {
      if (refuse(ctx)) return undefined;
      return handle(
        ctx,
        async () => {
          if (!/^[a-z0-9]{6,32}$/.test(String(ctx.params?.id))) throw new MessageGateError('NOT_FOUND');
          const detail = await core().outbox.detail(ctx.params.id);
          return {
            id: detail.id,
            status: detail.status,
            channel: detail.channel,
            templateKey: detail.templateKey,
            errorCode: detail.errorCode,
            sentAt: detail.sentAt,
            deliveredAt: detail.deliveredAt,
            readAt: detail.readAt,
            failedAt: detail.failedAt,
            timeline: detail.timeline,
            fallbacks: detail.fallbacks,
          };
        },
        strapi
      );
    },

    /** POST /api/magic-messagegate/consent */
    async consent(ctx) {
      if (refuse(ctx)) return undefined;
      return handle(
        ctx,
        async () => {
          const body = z
            .object({
              phone: z.string().max(40),
              channel: z.enum(['whatsapp', 'telegram', 'sms']),
              status: z.enum(['granted', 'revoked']),
              userId: z.number().int().positive().optional(),
            })
            .strict()
            .parse(ctx.request.body?.data ?? ctx.request.body ?? {});
          const c = core();
          const settings = await c.settings.get();
          const { row } = await c.contacts.upsertByPhone(body.phone, {
            country: settings.defaultCountry,
            userId: body.userId,
          });
          await c.contacts.setConsent(row.id, body.channel, body.status, 'api');
          return { contactId: row.document_id, channel: body.channel, status: body.status };
        },
        strapi
      );
    },

    /** POST /api/magic-messagegate/telegram-link */
    async telegramLink(ctx) {
      if (refuse(ctx)) return undefined;
      return handle(
        ctx,
        async () => {
          const body = z
            .object({ phone: z.string().max(40) })
            .strict()
            .parse(ctx.request.body?.data ?? ctx.request.body ?? {});
          const c = core();
          const settings = await c.settings.get();
          const { row } = await c.contacts.upsertByPhone(body.phone, { country: settings.defaultCountry });
          return services.telegram({ strapi }).createLink(row.document_id);
        },
        strapi
      );
    },

    /** POST /api/magic-messagegate/lookup */
    async lookup(ctx) {
      if (refuse(ctx)) return undefined;
      const c = core();
      const hits = await hit(c.ctx.knex, `lookup:${principal(ctx)}`, 60_000, 1, c.ctx.now());
      if (hits > c.ctx.config.rateLimits.lookupPerMinute)
        return sendError(ctx, 429, 'RATE_LIMITED', 'Too many requests, try again later');
      return handle(
        ctx,
        async () => {
          const body = z
            .object({ phone: z.string().max(40) })
            .strict()
            .parse(ctx.request.body?.data ?? ctx.request.body ?? {});
          return c.lookup.check(body.phone);
        },
        strapi
      );
    },
  };
};
