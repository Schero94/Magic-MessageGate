'use strict';

/**
 * Minimal `strapi` stand-in for controller tests: real knex (SQLite), plugin
 * config, a recording logger and event hub. Controllers and services use the
 * same `coreFor(strapi)` path as in production.
 */
const { sqliteKnex, TEST_KEY } = require('./core');
const { coreFor } = require('../../server/src/services');
const { ensureSchema } = require('../../server/src/store/schema');
const { resetKeyCache } = require('../../server/src/utils/crypto');

/**
 * @param {object} [pluginConfig]
 * @returns {Promise<object>}
 */
async function fakeStrapi(pluginConfig = {}) {
  resetKeyCache();
  const knex = sqliteKnex();
  await ensureSchema(knex);
  const logs = [];
  const emitted = [];
  const config = { encryptionKey: TEST_KEY, publicUrl: 'https://cms.example.test', ...pluginConfig };
  const strapi = {
    db: { connection: knex },
    config: { get: (key) => (key === 'plugin::magic-messagegate' ? config : key === 'server.url' ? '' : undefined) },
    log: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
      debug: () => {},
    },
    eventHub: { emit: (name, payload) => emitted.push({ name, payload }) },
    plugin: () => null,
    logs,
    emitted,
  };
  strapi.core = coreFor(strapi);
  return strapi;
}

/**
 * Koa-like context for a controller call.
 *
 * @param {object} input
 * @returns {object}
 */
function makeCtx({
  method = 'GET',
  params = {},
  query = {},
  body,
  headers = {},
  state = {},
  path = '/',
  raw,
  user,
} = {}) {
  const qs = new URLSearchParams(query).toString();
  const ctx = {
    method,
    params,
    query,
    path,
    origin: 'https://cms.example.test',
    originalUrl: `${path}${qs ? `?${qs}` : ''}`,
    ip: '127.0.0.1',
    request: { headers, body, ip: '127.0.0.1' },
    state: {
      ...state,
      user,
      ...(raw !== undefined
        ? { messagegateRaw: Buffer.from(raw), messagegateContentType: headers['content-type'] || '' }
        : {}),
    },
    type: undefined,
    set(key, value) {
      this.headers = { ...(this.headers || {}), [key]: value };
    },
    get(key) {
      return headers[String(key).toLowerCase()];
    },
  };
  // Koa semantics: status starts at 404 and becomes 200 when a body is set
  // without an explicit status (https://koajs.com/#response-body-1).
  let status = 404;
  let explicit = false;
  let responseBody;
  Object.defineProperty(ctx, 'status', {
    get: () => status,
    set: (v) => {
      status = v;
      explicit = true;
    },
  });
  Object.defineProperty(ctx, 'body', {
    get: () => responseBody,
    set: (v) => {
      responseBody = v;
      if (!explicit) status = 200;
    },
  });
  return ctx;
}

module.exports = { fakeStrapi, makeCtx };
