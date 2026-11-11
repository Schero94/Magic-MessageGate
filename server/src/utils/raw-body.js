'use strict';

/**
 * Captures the exact request bytes of MessageGate webhooks before Strapi's
 * body parser runs; signatures (Meta, seven.io) are computed over the raw
 * body. Mounted with `strapi.server.use()` during `register`, which runs
 * before `strapi::body`. The content type is then swapped for a private one
 * so koa-body ignores the consumed stream; the original type is kept in
 * `ctx.state.messagegateContentType` for the handler.
 */

const LIMIT_BYTES = 512 * 1024;
const PRIVATE_TYPE = 'application/x-magic-messagegate-webhook';

/**
 * @param {import('stream').Readable} stream
 * @param {number} limit
 * @returns {Promise<Buffer|null>} null when the body is larger than `limit`.
 */
function readLimited(stream, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (value, error) => {
      if (done) return;
      done = true;
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        if (typeof stream.resume === 'function') stream.resume();
        finish(null);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish(Buffer.concat(chunks));
    const onError = (error) => finish(null, error);
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}

/**
 * @param {{pathPrefix: string, limit?: number}} options
 * @returns {(ctx: any, next: () => Promise<void>) => Promise<void>}
 */
function createRawBodyMiddleware({ pathPrefix, limit = LIMIT_BYTES }) {
  return async (ctx, next) => {
    if (ctx.method !== 'POST' || typeof ctx.path !== 'string' || !ctx.path.startsWith(pathPrefix)) return next();
    const declared = Number(ctx.get?.('content-length'));
    if (Number.isFinite(declared) && declared > limit) {
      ctx.status = 413;
      ctx.body = '';
      return undefined;
    }
    const raw = await readLimited(ctx.req, limit);
    if (raw === null) {
      ctx.status = 413;
      ctx.body = '';
      return undefined;
    }
    ctx.state.messagegateRaw = raw;
    ctx.state.messagegateContentType = String(ctx.req.headers['content-type'] || '').toLowerCase();
    ctx.req.headers['content-type'] = PRIVATE_TYPE;
    return next();
  };
}

module.exports = { createRawBodyMiddleware, readLimited, LIMIT_BYTES, PRIVATE_TYPE };
