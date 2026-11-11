'use strict';

/**
 * Public download route for signed links:
 *   GET /api/magic-messagegate/files/:token
 *
 * Used for SMS (and Telegram) attachment links and for short-lived inbound
 * media URLs. The token is `<random id>.<expiry>.<HMAC>`; anything wrong
 * (format, signature, expiry, unknown or purged link, missing file) answers
 * the same plain 404, so links cannot be enumerated or probed. Requests are
 * rate limited per client IP across processes. Files are sent as downloads
 * with `nosniff` and a sandboxing CSP, never rendered as HTML. Media-library
 * files on a remote upload provider (S3, …) are answered with a redirect to
 * their public URL instead of being proxied (no server-side fetch).
 */
const fs = require('node:fs');
const { coreFor } = require('../services');
const { hit } = require('../store/coordination');

/**
 * @param {object} ctx
 * @param {string} mime
 * @param {string} filename
 */
function fileHeaders(ctx, mime, filename) {
  const safe = String(filename || 'file')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 120);
  ctx.set('Content-Type', mime);
  ctx.set('Content-Disposition', `attachment; filename="${safe}"`);
  ctx.set('X-Content-Type-Options', 'nosniff');
  ctx.set('Content-Security-Policy', "default-src 'none'; sandbox");
  ctx.set('Cache-Control', 'private, no-store');
  ctx.set('Referrer-Policy', 'no-referrer');
}

module.exports = ({ strapi }) => ({
  async download(ctx) {
    const core = coreFor(strapi);
    const notFound = () => {
      ctx.status = 404;
      ctx.type = 'text/plain';
      ctx.body = 'Not found';
    };
    const hits = await hit(core.ctx.knex, `download:${ctx.request.ip}`, 60_000, 1, core.ctx.now());
    if (hits > core.ctx.config.rateLimits.downloadPerMinute) {
      ctx.status = 429;
      ctx.set('Retry-After', '60');
      ctx.body = '';
      return;
    }
    try {
      const ref = await core.attachments.openLink(String(ctx.params?.token || ''));
      const source = await core.attachments.source(ref);
      if (!source) return notFound();
      if (source.type === 'redirect') {
        ctx.set('Cache-Control', 'private, no-store');
        ctx.set('Referrer-Policy', 'no-referrer');
        ctx.redirect(source.url);
        return undefined;
      }
      if (source.type === 'inbound') {
        const file = await core.inbound.mediaForLink(source.inboundId).catch(() => null);
        if (!file) return notFound();
        fileHeaders(ctx, file.mime, file.filename);
        ctx.set('Content-Length', String(file.size));
        ctx.body = file.bytes;
        return undefined;
      }
      const stat = await fs.promises.stat(source.path).catch(() => null);
      if (!stat?.isFile()) return notFound();
      fileHeaders(ctx, source.mimeType, source.filename);
      ctx.set('Content-Length', String(stat.size));
      ctx.body = fs.createReadStream(source.path);
      return undefined;
    } catch (error) {
      strapi.log.error(`[magic-messagegate] download failed: ${error?.name || 'Error'}`);
      return notFound();
    }
  },
});
