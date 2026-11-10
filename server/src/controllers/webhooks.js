'use strict';

/**
 * Public webhook endpoints:
 *   GET/POST /api/magic-messagegate/webhooks/:provider/:path
 *
 * `:path` is a random 32-character id per account (not guessable), and every
 * request must carry the provider's signature. Failures answer 401 without
 * detail; successful requests answer 200 quickly. Bodies are read raw by the
 * middleware in utils/raw-body.js (limit 512 KB).
 */
const { coreFor } = require('../services');
const { hit } = require('../store/coordination');

const PROVIDERS = new Set(['meta', 'telegram', 'seven', 'twilio']);

/**
 * @param {object} ctx
 * @returns {{json: any, form: Record<string,string>}}
 */
function parseBody(ctx) {
  const raw = ctx.state.messagegateRaw;
  const type = ctx.state.messagegateContentType || '';
  if (!Buffer.isBuffer(raw) || raw.length === 0) return { json: null, form: {} };
  if (type.includes('application/x-www-form-urlencoded')) {
    return { json: null, form: Object.fromEntries(new URLSearchParams(raw.toString('utf8'))) };
  }
  try {
    return { json: JSON.parse(raw.toString('utf8')), form: {} };
  } catch {
    return { json: null, form: {} };
  }
}

module.exports = ({ strapi }) => ({
  async receive(ctx) {
    const provider = String(ctx.params?.provider || '');
    const path = String(ctx.params?.path || '');
    const unauthorized = () => {
      ctx.status = 401;
      ctx.body = '';
    };
    if (!PROVIDERS.has(provider)) return unauthorized();
    const core = coreFor(strapi);
    // One app-level URL for every Embedded Signup number: Meta sends all WABA
    // events of a Tech Provider app to the app's single callback URL.
    const signup = core.ctx.config.providers.meta.embeddedSignup || {};
    const appLevel = provider === 'meta' && path === 'app';
    if (appLevel && !(signup.appSecret && signup.verifyToken)) return unauthorized();
    const appConfig = appLevel ? { appSecret: signup.appSecret, verifyToken: signup.verifyToken } : undefined;
    const account = appLevel ? null : await core.accounts.byWebhookPath(provider, path);
    if (!appLevel && (!account || !account.is_active)) return unauthorized();

    const hits = await hit(core.ctx.knex, `webhook:${appLevel ? 'meta-app' : account.id}`, 60_000, 1, core.ctx.now());
    if (hits > core.ctx.config.rateLimits.webhookPerMinute) {
      ctx.status = 429;
      ctx.body = '';
      return undefined;
    }

    const headers = Object.fromEntries(
      Object.entries(ctx.request.headers || {}).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v])
    );
    const base = core.ctx.publicUrl || ctx.origin;
    const url = `${base}${ctx.originalUrl}`;

    try {
      if (provider === 'meta' && ctx.method === 'GET') {
        const result = core.webhooks.metaVerify(account, ctx.query || {}, appConfig);
        ctx.status = result.status;
        ctx.type = 'text/plain';
        ctx.body = result.body;
        return undefined;
      }
      if (ctx.method !== 'POST') return unauthorized();
      const { json, form } = parseBody(ctx);
      const rawBody = ctx.state.messagegateRaw || Buffer.alloc(0);
      let result;
      if (provider === 'meta') result = await core.webhooks.meta(account, { headers, rawBody, body: json }, appConfig);
      else if (provider === 'telegram') result = await core.webhooks.telegram(account, { headers, body: json });
      else if (provider === 'seven')
        result = await core.webhooks.seven(account, { headers, rawBody, body: json, url, method: 'POST' });
      else result = await core.webhooks.twilio(account, { headers, params: form, url });
      ctx.status = result.status;
      ctx.body = result.status === 200 ? 'OK' : '';
    } catch (error) {
      strapi.log.error(`[magic-messagegate] webhook ${provider} failed: ${error?.name || 'Error'}`);
      // 500 lets the provider retry; the event key was released.
      ctx.status = 500;
      ctx.body = '';
    }
    return undefined;
  },
});
