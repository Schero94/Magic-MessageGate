'use strict';

/**
 * Error responses in Strapi's REST error shape
 * (`{ data: null, error: { status, name, message, details } }`), written
 * directly so they do not depend on which copy of `@strapi/utils` the host
 * resolved (instanceof checks fail across copies).
 */
const { isMessageGateError } = require('../utils/errors');

const NAMES = {
  400: 'ValidationError',
  401: 'UnauthorizedError',
  403: 'ForbiddenError',
  404: 'NotFoundError',
  409: 'ConflictError',
  413: 'PayloadTooLargeError',
  429: 'RateLimitError',
  502: 'ApplicationError',
};

/**
 * @param {object} ctx - Koa context.
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @param {object} [details]
 */
function sendError(ctx, status, code, message, details) {
  ctx.status = status;
  ctx.body = {
    data: null,
    error: { status, name: NAMES[status] || 'ApplicationError', message, details: { code, ...(details || {}) } },
  };
}

/**
 * Runs a handler and maps MessageGate errors; unknown errors become 500
 * without internals.
 *
 * @param {object} ctx
 * @param {() => Promise<*>} fn
 * @param {object} [strapi]
 * @returns {Promise<void>}
 */
async function handle(ctx, fn, strapi) {
  try {
    const result = await fn();
    if (result !== undefined) ctx.body = { data: result };
  } catch (error) {
    if (isMessageGateError(error)) return sendError(ctx, error.status, error.code, error.message, error.details);
    if (error?.code === 'NOT_FOUND') return sendError(ctx, 404, 'NOT_FOUND', 'Not found');
    if (error?.name === 'ZodError' && Array.isArray(error.issues)) {
      return sendError(ctx, 400, 'INVALID_REQUEST', 'The request is invalid', {
        field: String(error.issues[0]?.path?.[0] ?? '').slice(0, 60),
      });
    }
    strapi?.log?.error?.(`[magic-messagegate] request failed: ${error?.name || 'Error'}`);
    return sendError(ctx, 500, 'INTERNAL', 'Internal server error');
  }
  return undefined;
}

module.exports = { handle, sendError };
