'use strict';

/**
 * Magic MessageGate server entry.
 *
 * Lifecycle (https://docs.strapi.io/cms/plugins-development/server-api):
 * - register: mount the raw-body middleware for webhooks (before strapi::body).
 * - bootstrap: create tables, register RBAC actions, start the worker,
 *   maintenance and retention timers (all unref'd, all multi-process safe).
 * - destroy: stop the timers.
 */
const config = require('./config');
const routes = require('./routes');
const controllers = require('./controllers');
const services = require('./services');
const { createRawBodyMiddleware } = require('./utils/raw-body');
const { registerActions } = require('./permissions');

const timers = new WeakMap();

/**
 * @param {Function} fn
 * @param {number} ms
 * @returns {NodeJS.Timeout}
 */
function every(fn, ms) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } finally {
      running = false;
    }
  }, ms);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

module.exports = {
  register({ strapi }) {
    strapi.server.use(createRawBodyMiddleware({ pathPrefix: '/api/magic-messagegate/webhooks/' }));
  },

  async bootstrap({ strapi }) {
    const core = services.coreFor(strapi);
    await core.init();
    await registerActions(strapi);
    const cfg = core.ctx.config;
    const list = [];
    const log = (scope) => (error) =>
      strapi.log.error(`[magic-messagegate] ${scope} failed: ${error?.name || 'Error'}`);
    if (cfg.worker.enabled) {
      list.push(every(() => core.outbox.tick().catch(log('worker')), cfg.worker.intervalMs));
      list.push(every(() => core.outbox.maintain().catch(log('maintenance')), 30_000));
      list.push(
        every(async () => {
          const settings = await core.settings.get();
          await core.outbox.purge(settings.retention);
        }, 60 * 60_000)
      );
    }
    timers.set(strapi, list);
    strapi.log.info(`[magic-messagegate] ready (worker ${cfg.worker.enabled ? 'on' : 'off'})`);
  },

  destroy({ strapi }) {
    for (const timer of timers.get(strapi) || []) clearInterval(timer);
    timers.delete(strapi);
  },

  config,
  routes,
  controllers,
  services,
  contentTypes: {},
  policies: {},
  middlewares: {},
};
