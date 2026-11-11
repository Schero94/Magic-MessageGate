// Loads the built server bundles (CJS and ESM) and checks the plugin shape:
// lifecycle hooks, routes with RBAC policies on every admin route, signed
// public webhooks only, controllers that exist for every handler, and a config
// default that passes its own validator.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const fail = (format, message) => {
  throw new Error(`${format} bundle: ${message}`);
};

for (const [format, mod] of [
  ['cjs', require('../dist/server/index.js')],
  ['esm', await import('../dist/server/index.mjs')],
]) {
  const plugin = mod.default || mod;
  for (const hook of ['register', 'bootstrap', 'destroy']) {
    if (typeof plugin[hook] !== 'function') fail(format, `missing ${hook}()`);
  }
  const defaults = plugin.config.default();
  plugin.config.validator(defaults);
  if (defaults.worker.enabled !== true) fail(format, 'worker must be enabled by default');

  const controllers = Object.fromEntries(
    Object.entries(plugin.controllers).map(([name, factory]) => [name, factory({ strapi: {} })])
  );
  const adminRoutes = plugin.routes.admin.routes;
  const apiRoutes = plugin.routes['content-api'].routes;
  for (const route of [...adminRoutes, ...apiRoutes]) {
    const [controller, action] = route.handler.split('.');
    if (typeof controllers[controller]?.[action] !== 'function') fail(format, `no handler ${route.handler}`);
  }
  for (const route of adminRoutes) {
    const policies = route.config?.policies || [];
    const rbac = policies.find((p) => p?.name === 'admin::hasPermissions');
    if (!policies.includes('admin::isAuthenticatedAdmin') || !rbac?.config?.actions?.length) {
      fail(format, `admin route ${route.method} ${route.path} lacks RBAC`);
    }
  }
  for (const route of apiRoutes) {
    if (route.config?.auth === false && !route.path.startsWith('/webhooks/')) {
      fail(format, `public route ${route.method} ${route.path} is not a webhook`);
    }
  }
}
console.log('Magic MessageGate server bundles load; routes, RBAC and config verified');
