'use strict';

/** Plugin wiring: routes and RBAC, lifecycle, controllers, raw-body middleware, services. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const plugin = require('../server/src');
const { ACTIONS } = require('../server/src/permissions');
const { createRawBodyMiddleware, PRIVATE_TYPE } = require('../server/src/utils/raw-body');
const { startFakeProviders } = require('./helpers/fake-providers');
const { fakeStrapi, makeCtx } = require('./helpers/strapi');
const { CREDS, PHONE } = require('./helpers/core');

let fake;
test.before(async () => {
  fake = await startFakeProviders();
});
test.after(() => fake.close());
test.beforeEach(() => fake.reset());

test('routes: every admin route needs an admin session and a registered RBAC action', () => {
  const known = new Set(ACTIONS.map((a) => `plugin::magic-messagegate.${a.uid}`));
  const used = new Set();
  for (const route of plugin.routes.admin.routes) {
    const [auth, rbac] = route.config.policies;
    assert.equal(auth, 'admin::isAuthenticatedAdmin', `${route.method} ${route.path}`);
    assert.equal(rbac.name, 'admin::hasPermissions');
    for (const action of rbac.config.actions) {
      assert.ok(known.has(action), action);
      used.add(action);
    }
    const [controller, handler] = route.handler.split('.');
    assert.equal(typeof plugin.controllers[controller]({ strapi: {} })[handler], 'function', route.handler);
  }
  assert.equal(used.size, known.size, 'every RBAC action is used by a route');
  for (const route of plugin.routes['content-api'].routes) {
    if (route.config.auth === false) assert.match(route.path, /^\/webhooks\/:provider\/:path$/);
  }
});

test('config: defaults pass the validator; invalid config is rejected', () => {
  const defaults = plugin.config.default();
  plugin.config.validator(defaults);
  assert.throws(() => plugin.config.validator({ worker: { intervalMs: 1 } }));
  assert.throws(() => plugin.config.validator({ unknown: true }));
  assert.throws(() => plugin.config.validator({ providers: { meta: { baseUrl: 'not a url' } } }));
});

test('lifecycle: register mounts the raw-body middleware; bootstrap creates tables, RBAC and timers; destroy stops them', async () => {
  const strapi = await fakeStrapi({ worker: { enabled: true, intervalMs: 1000 } });
  const middlewares = [];
  const registered = [];
  strapi.server = { use: (fn) => middlewares.push(fn) };
  strapi.service = (uid) => {
    assert.equal(uid, 'admin::permission');
    return { actionProvider: { registerMany: async (list) => registered.push(...list) } };
  };
  plugin.register({ strapi });
  assert.equal(middlewares.length, 1);
  await plugin.bootstrap({ strapi });
  assert.equal(registered.length, ACTIONS.length);
  assert.ok(registered.every((a) => a.section === 'plugins' && a.pluginName === 'magic-messagegate'));
  assert.ok(await strapi.db.connection.schema.hasTable('mg_messages'));
  assert.ok(strapi.logs.some(([level, m]) => level === 'info' && /ready \(worker on\)/.test(m)));
  plugin.destroy({ strapi });
});

test('raw-body middleware keeps the exact bytes and hides the body from the JSON parser', async () => {
  const mw = createRawBodyMiddleware({ pathPrefix: '/api/magic-messagegate/webhooks/', limit: 64 });
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const ctx = {
      method: req.method,
      path: req.url,
      req,
      state: {},
      get: (h) => req.headers[h.toLowerCase()] || '',
      status: 200,
      body: '',
    };
    await mw(ctx, async () => {
      seen.push({
        raw: ctx.state.messagegateRaw?.toString('utf8'),
        type: req.headers['content-type'],
        original: ctx.state.messagegateContentType,
      });
    });
    res.writeHead(ctx.status);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const body = '{"a": 1,  "b":"ü"}';
    let r = await fetch(`${url}/api/magic-messagegate/webhooks/meta/x`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    assert.equal(r.status, 200);
    assert.deepEqual(seen[0], { raw: body, type: PRIVATE_TYPE, original: 'application/json' });
    r = await fetch(`${url}/api/magic-messagegate/webhooks/meta/x`, { method: 'POST', body: 'x'.repeat(65) });
    assert.equal(r.status, 413);
    r = await fetch(`${url}/api/other`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(seen[1].raw, undefined, 'other paths are untouched');
    assert.equal(seen[1].type, 'application/json');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

async function apiSetup(config = {}) {
  const strapi = await fakeStrapi({ providers: fake.providers, ...config });
  const core = strapi.core;
  await core.accounts.create({ channel: 'sms', provider: 'seven', name: 'SMS', config: CREDS.seven });
  await core.templates.create({
    key: 'hello',
    channel: 'sms',
    language: 'de',
    name: 'Hello',
    content: { text: 'Hallo {{name}}' },
  });
  const { row } = await core.contacts.upsertByPhone(PHONE);
  await core.contacts.setConsent(row.id, 'sms', 'granted', 'test');
  const api = plugin.controllers['content-api']({ strapi });
  const admin = plugin.controllers.admin({ strapi });
  const token = { auth: { strategy: { name: 'api-token' }, credentials: { id: 7 } } };
  return { strapi, core, api, admin, token };
}

test('content API: 202 on new, 200 on duplicate, Strapi error shape on invalid input', async () => {
  const { api, token, core } = await apiSetup();
  const body = {
    data: {
      to: PHONE,
      channel: 'sms',
      template: 'hello',
      language: 'de',
      variables: { name: 'Ana' },
      idempotencyKey: 'x1',
    },
  };
  let ctx = makeCtx({ method: 'POST', body, state: token });
  await api.send(ctx);
  assert.equal(ctx.status, 202);
  assert.equal(ctx.body.data.status, 'queued');
  const id = ctx.body.data.id;
  ctx = makeCtx({ method: 'POST', body, state: token });
  await api.send(ctx);
  assert.equal(ctx.status, 200);
  assert.equal(ctx.body.data.id, id);

  ctx = makeCtx({ method: 'POST', body: { data: { to: PHONE } }, state: token });
  await api.send(ctx);
  assert.equal(ctx.status, 400);
  assert.equal(ctx.body.data, null);
  assert.equal(ctx.body.error.name, 'ValidationError');
  assert.equal(ctx.body.error.details.code, 'INVALID_REQUEST');

  await core.outbox.tick();
  ctx = makeCtx({ params: { id }, state: token });
  await api.status(ctx);
  assert.equal(ctx.status, 200);
  assert.equal(ctx.body.data.status, 'sent');
  assert.deepEqual(
    ctx.body.data.timeline.map((e) => e.type),
    ['queued', 'sent']
  );
  assert.ok(!JSON.stringify(ctx.body).includes('15123456789'));

  ctx = makeCtx({ params: { id: '../../etc' }, state: token });
  await api.status(ctx);
  assert.equal(ctx.status, 404);
});

test('content API: send rate limit per token answers 429 with Retry-After', async () => {
  const { api, token } = await apiSetup({ rateLimits: { sendPerMinute: 2 } });
  const statuses = [];
  let last;
  for (let i = 0; i < 3; i += 1) {
    last = makeCtx({
      method: 'POST',
      body: { to: PHONE, channel: 'sms', template: 'hello', language: 'de', variables: { name: 'A' } },
      state: token,
    });
    await api.send(last);
    statuses.push(last.status);
  }
  assert.deepEqual(statuses, [202, 202, 429]);
  assert.equal(last.headers['Retry-After'], '60');
  assert.equal(last.body.error.details.code, 'RATE_LIMITED');
});

test('content API: consent and lookup', async () => {
  const { api, token, core } = await apiSetup();
  let ctx = makeCtx({
    method: 'POST',
    body: { phone: '0170 1234567', channel: 'whatsapp', status: 'granted' },
    state: token,
  });
  await api.consent(ctx);
  assert.equal(ctx.status, 200);
  const row = await core.contacts.getRow(ctx.body.data.contactId);
  assert.equal(await core.contacts.consentStatus(row.id, 'whatsapp'), 'granted');
  ctx = makeCtx({ method: 'POST', body: { phone: PHONE, extra: 1 }, state: token });
  await api.lookup(ctx);
  assert.equal(ctx.status, 400);
  ctx = makeCtx({ method: 'POST', body: { phone: PHONE }, state: token });
  await api.lookup(ctx);
  assert.equal(ctx.body.data.valid, true);
});

test('admin API: masked accounts, error mapping, write rate limit', async () => {
  const { admin } = await apiSetup({ rateLimits: { adminWritePerMinute: 3 } });
  const user = { id: 1 };
  let ctx = makeCtx({
    method: 'POST',
    body: { channel: 'whatsapp', provider: 'meta', name: 'WA', config: CREDS.meta },
    user,
  });
  await admin.createAccount(ctx);
  assert.equal(ctx.status, 200);
  assert.ok(!JSON.stringify(ctx.body).includes(CREDS.meta.accessToken));
  ctx = makeCtx({ method: 'POST', body: { channel: 'whatsapp', provider: 'meta', name: 'WA', config: {} }, user });
  await admin.createAccount(ctx);
  assert.equal(ctx.status, 400);
  assert.equal(ctx.body.error.details.code, 'CONFIG_INVALID');
  ctx = makeCtx({ method: 'POST', params: { id: 'zzzzzzzzzz' }, body: {}, user });
  await admin.retryMessage(ctx);
  assert.equal(ctx.status, 404);
  ctx = makeCtx({ method: 'POST', body: {}, user });
  await admin.createAccount(ctx);
  assert.equal(ctx.status, 429);
  ctx = makeCtx({ query: { status: 'bogus' }, user });
  await admin.listMessages(ctx);
  assert.equal(ctx.status, 400);
  ctx = makeCtx({ user });
  await admin.getSettings(ctx);
  assert.equal(ctx.body.data.revision, 0);
  assert.equal(ctx.body.data.magicMailInstalled, false);
});

test('service API: send, get, contacts and Telegram link', async () => {
  const { strapi } = await apiSetup();
  const services = plugin.services;
  const messages = services.messages({ strapi });
  const sent = await messages.send({
    to: PHONE,
    channel: 'sms',
    template: 'hello',
    language: 'de',
    variables: { name: 'Ana' },
  });
  assert.equal(sent.status, 'queued');
  assert.equal((await messages.get(sent.id)).source, 'service');
  const contact = await services.contacts({ strapi }).upsert('+4917612345678');
  await services.contacts({ strapi }).grantConsent(contact.id, 'sms');
  const link = await services.telegram({ strapi }).createLink(contact.id);
  assert.equal(link.url, null, 'no Telegram account configured yet');
  assert.match(link.token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal((await services.lookup({ strapi }).check(PHONE)).valid, true);
});
