'use strict';

/** 1.1 Content API and admin controllers: dry run, capabilities, render, inbound, files, sandbox route. */
const test = require('node:test');
const assert = require('node:assert/strict');

const plugin = require('../server/src');
const { startFakeProviders } = require('./helpers/fake-providers');
const { fakeStrapi, makeCtx } = require('./helpers/strapi');
const { CREDS, PHONE } = require('./helpers/core');
const { memoryFiles, PDF } = require('./helpers/files');
const { SANDBOX_NUMBERS } = require('../server/src/testing/numbers');

let fake;
test.before(async () => {
  fake = await startFakeProviders();
});
test.after(() => fake.close());
test.beforeEach(() => fake.reset());

const token = { auth: { strategy: { name: 'content-api-token' }, credentials: { id: 9 } } };

/**
 * @param {object} [config]
 * @returns {Promise<object>}
 */
async function setup(config = {}) {
  const strapi = await fakeStrapi({ providers: fake.providers, ...config });
  const core = strapi.core;
  core.ctx.files = memoryFiles();
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
  return {
    strapi,
    core,
    contact: row,
    api: plugin.controllers['content-api']({ strapi }),
    inbound: plugin.controllers['inbound-api']({ strapi }),
    files: plugin.controllers.files({ strapi }),
    admin: plugin.controllers.admin({ strapi }),
  };
}

test('content API: dryRun returns the plan with 200 and queues nothing; capabilities and render', async () => {
  const { api, core } = await setup();
  let ctx = makeCtx({
    method: 'POST',
    body: { data: { to: PHONE, channel: 'sms', template: 'hello', variables: { name: 'Ana' }, dryRun: true } },
    state: token,
  });
  await api.send(ctx);
  assert.equal(ctx.status, 200);
  assert.equal(ctx.body.data.dryRun, true);
  assert.equal(ctx.body.data.channel, 'sms');
  assert.equal(ctx.body.data.payload.text, 'Hallo Ana');
  assert.equal((await core.ctx.knex('mg_messages').count({ n: '*' }))[0].n, 0);
  ctx = makeCtx({ method: 'POST', body: { to: PHONE, template: 'hello', dryRun: 'yes' }, state: token });
  await api.send(ctx);
  assert.equal(ctx.body.error.details.field, 'dryRun');

  ctx = makeCtx({ method: 'POST', body: { phone: PHONE }, state: token });
  await api.capabilities(ctx);
  assert.deepEqual(Object.keys(ctx.body.data).sort(), [
    'active',
    'checkedAt',
    'e164',
    'rcs',
    'telegramLinked',
    'type',
    'valid',
    'whatsapp',
  ]);

  ctx = makeCtx({
    method: 'POST',
    body: { template: 'hello', channel: 'sms', variables: { name: 'Bo' } },
    state: token,
  });
  await api.renderTemplate(ctx);
  assert.equal(ctx.body.data.preview, 'Hallo Bo');
  ctx = makeCtx({ method: 'POST', body: { template: 'hello', channel: 'sms' } });
  await api.renderTemplate(ctx);
  assert.equal(ctx.status, 403, 'API token required');

  ctx = makeCtx({ method: 'POST', body: { phone: PHONE, hlr: true }, state: token });
  await api.lookup(ctx);
  assert.equal(ctx.body.error.details.code, 'LOOKUP_DISABLED');
});

test('inbound API: list, get, processed, media as stream and base64, media URL, conversation, reply; rate limit', async () => {
  const { inbound, core, contact } = await setup({
    providers: { ...fake.providers, mode: 'sandbox' },
    rateLimits: { inboundPerMinute: 12 },
  });
  const message = await core.simulateInbound({
    to: PHONE,
    channel: 'sms',
    text: 'Hallo',
    media: { mime: 'application/pdf', size: 300, filename: 'beleg.pdf' },
  });
  await core.inbound.mediaTick();
  let ctx = makeCtx({ query: { channel: 'sms' }, state: token });
  await inbound.list(ctx);
  assert.equal(ctx.body.data.results[0].text, 'Hallo');
  ctx = makeCtx({ params: { id: message.id }, state: token });
  await inbound.get(ctx);
  assert.equal(ctx.body.data.media.status, 'ready');
  ctx = makeCtx({ params: { id: message.id }, state: token });
  await inbound.media(ctx);
  assert.equal(ctx.headers['Content-Type'], 'application/pdf');
  assert.equal(ctx.headers['X-Content-Type-Options'], 'nosniff');
  assert.match(ctx.headers['Content-Disposition'], /^attachment; filename="beleg\.pdf"$/);
  assert.ok(Buffer.isBuffer(ctx.body));
  ctx = makeCtx({ params: { id: message.id }, query: { as: 'base64' }, state: token });
  await inbound.media(ctx);
  assert.equal(Buffer.from(ctx.body.data.data, 'base64').length, 300);
  ctx = makeCtx({ method: 'POST', params: { id: message.id }, body: { ttlSeconds: 120 }, state: token });
  await inbound.mediaUrl(ctx);
  const url = ctx.body.data.url;
  ctx = makeCtx({ method: 'POST', params: { id: message.id }, body: {}, state: token });
  await inbound.processed(ctx);
  assert.equal(ctx.body.data.alreadyProcessed, false);
  ctx = makeCtx({ params: { id: contact.document_id }, query: { limit: '10' }, state: token });
  await inbound.conversation(ctx);
  assert.equal(ctx.body.data.items[0].direction, 'inbound');
  ctx = makeCtx({
    method: 'POST',
    params: { id: message.id },
    body: { data: { template: 'hello', variables: { name: 'Ana' } } },
    state: token,
  });
  await inbound.reply(ctx);
  assert.equal(ctx.status, 202);
  assert.equal(ctx.body.data.channel, 'sms');
  ctx = makeCtx({ params: { id: message.id } });
  await inbound.get(ctx);
  assert.equal(ctx.status, 403);
  for (let i = 0; i < 6; i += 1) {
    ctx = makeCtx({ params: { id: message.id }, state: token });
    await inbound.get(ctx);
  }
  assert.equal(ctx.status, 429);
  assert.ok(url.includes('/api/magic-messagegate/files/'));
});

test('files route: signed SMS attachment link streams the local file once valid; everything else is a plain 404', async () => {
  const { files, core, strapi } = await setup();
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-pub-'));
  fs.mkdirSync(path.join(dir, 'uploads'));
  fs.writeFileSync(path.join(dir, 'uploads', 'r.pdf'), PDF);
  const memory = core.ctx.files;
  const id = memory.add({ name: 'Rechnung.pdf', mime: 'application/pdf', size: 1, url: '/uploads/r.pdf' });
  memory.localPath = (file) => (file.url === '/uploads/r.pdf' ? path.join(dir, 'uploads', 'r.pdf') : null);
  await core.sender.send({
    to: PHONE,
    channel: 'sms',
    template: 'hello',
    variables: { name: 'A' },
    attachment: { fileId: id },
  });
  await core.outbox.tick();
  const text = fake.of('seven.send')[0].form.text;
  const tokenValue = text.split('/files/')[1];
  let ctx = makeCtx({ params: { token: tokenValue } });
  await files.download(ctx);
  assert.equal(ctx.headers['Content-Type'], 'application/pdf');
  assert.equal(ctx.headers['Content-Disposition'], 'attachment; filename="Rechnung.pdf"');
  assert.equal(ctx.headers['Content-Security-Policy'], "default-src 'none'; sandbox");
  assert.equal(typeof ctx.body.pipe, 'function');
  ctx.body.destroy();
  for (const bad of ['x', `${tokenValue}0`, tokenValue.replace(/.$/, (c) => (c === '0' ? '1' : '0'))]) {
    ctx = makeCtx({ params: { token: bad } });
    await files.download(ctx);
    assert.equal(ctx.status, 404);
    assert.equal(ctx.body, 'Not found');
  }
  assert.ok(strapi);
});

test('sandbox route only works in sandbox mode; admin inbox, conversation, settings and webhook secret', async () => {
  const live = await setup();
  let ctx = makeCtx({ method: 'POST', body: { to: PHONE, text: 'x' }, state: token });
  await live.inbound.simulate(ctx);
  assert.equal(ctx.body.error.details.code, 'SANDBOX_ONLY');

  const box = await setup({ providers: { ...fake.providers, mode: 'sandbox' } });
  ctx = makeCtx({
    method: 'POST',
    body: { to: SANDBOX_NUMBERS.read, channel: 'sms', text: 'Ja', buttonPayload: 'yes' },
    state: token,
  });
  await box.inbound.simulate(ctx);
  assert.equal(ctx.status, 201);
  assert.equal(ctx.body.data.buttonPayload, 'yes');
  const contactId = ctx.body.data.contactId;
  ctx = makeCtx({});
  await box.admin.inboundUnread(ctx);
  assert.equal(ctx.body.data.unread, 1);
  ctx = makeCtx({ params: { id: contactId } });
  await box.admin.conversation(ctx);
  assert.equal(ctx.body.data.items.length, 1);
  assert.equal(ctx.body.data.whatsappWindowOpen, false);
  ctx = makeCtx({});
  await box.admin.inboundUnread(ctx);
  assert.equal(ctx.body.data.unread, 0, 'opening the conversation marks it seen');
  ctx = makeCtx({});
  await box.admin.getSettings(ctx);
  assert.equal(ctx.body.data.sandbox, true);
  assert.equal(ctx.body.data.webhookSecretSet, false);
  ctx = makeCtx({ method: 'POST', user: { id: 1 } });
  await box.admin.rotateWebhookSecret(ctx);
  assert.match(ctx.body.data.secret, /^whsec_/);
  const settings = await box.core.settings.getWithRevision();
  ctx = makeCtx({
    method: 'PUT',
    user: { id: 1 },
    body: {
      settings: { ...settings.value, outgoingWebhook: { enabled: true, url: 'https://192.168.1.2/x', events: [] } },
      revision: settings.revision,
    },
  });
  await box.admin.updateSettings(ctx);
  assert.equal(ctx.body.error.details.code, 'WEBHOOK_URL_INVALID');
});
