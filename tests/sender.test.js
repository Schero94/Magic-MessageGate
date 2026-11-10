'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startFakeProviders } = require('./helpers/fake-providers');
const { scenario } = require('./helpers/scenario');
const { PHONE, PHONE2 } = require('./helpers/core');
const { DEFAULTS } = require('../server/src/core/settings');

let fake;
test.before(async () => {
  fake = await startFakeProviders();
});
test.after(() => fake.close());
test.beforeEach(() => fake.reset());

const base = (core, extra = {}) => ({
  to: PHONE,
  template: 'order_shipped',
  language: 'de',
  variables: core.vars,
  ...extra,
});

test('input validation reports the field, never the value', async () => {
  const core = await scenario(fake);
  await assert.rejects(
    core.sender.send({ to: PHONE }),
    (e) => e.code === 'INVALID_REQUEST' && e.details.field === 'template'
  );
  await assert.rejects(
    core.sender.send({ template: 'x' }),
    (e) => e.code === 'INVALID_REQUEST' && e.details.field === 'to'
  );
  await assert.rejects(core.sender.send(base(core, { unknown: 1 })), { code: 'INVALID_REQUEST' });
  await assert.rejects(core.sender.send(base(core, { to: '+999 12345678' })), { code: 'INVALID_PHONE' });
  await assert.rejects(core.sender.send(base(core, { channel: 'fax' })), { code: 'INVALID_REQUEST' });
  await assert.rejects(
    core.sender.send(base(core, { variables: { name: 'A' } })),
    (e) => e.code === 'MISSING_VARIABLE' && e.details.field === 'order'
  );
  await assert.rejects(core.sender.send(base(core, { template: 'nope' })), { code: 'UNKNOWN_TEMPLATE' });
});

test('consent is required by default; revoked consent blocks, AUTHENTICATION transactional is exempt', async () => {
  const core = await scenario(fake);
  const { row } = await core.contacts.upsertByPhone(PHONE2);
  await assert.rejects(core.sender.send(base(core, { to: PHONE2 })), { code: 'NO_CONSENT' });
  await core.templates.create({
    key: 'login_code',
    channel: 'sms',
    language: 'de',
    name: 'Login code',
    category: 'AUTHENTICATION',
    content: { text: 'Code {{code}}' },
  });
  const otp = await core.sender.send({
    to: PHONE2,
    template: 'login_code',
    language: 'de',
    channel: 'sms',
    variables: { code: '123456' },
    transactional: true,
  });
  assert.equal(otp.status, 'queued');
  await assert.rejects(
    core.sender.send({ to: PHONE2, template: 'login_code', language: 'de', channel: 'sms', variables: { code: '1' } }),
    { code: 'NO_CONSENT' }
  );
  await core.contacts.setConsent(row.id, 'sms', 'granted', 'test');
  await core.contacts.setConsent(row.id, 'sms', 'revoked', 'test');
  await assert.rejects(core.sender.send(base(core, { to: PHONE2, channel: 'sms' })), { code: 'NO_CONSENT' });
});

test('consent can be switched off in settings', async () => {
  const core = await scenario(fake, { settings: { requireConsent: false } });
  const res = await core.sender.send(base(core, { to: PHONE2 }));
  assert.equal(res.channel, 'whatsapp');
});

test('WhatsApp templates must be approved; edits reset approval', async () => {
  const core = await scenario(fake);
  const [wa] = await core.templates.list({ channel: 'whatsapp' });
  await core.templates.update(wa.id, { content: { body: 'Neu: {{name}} {{order}}' } });
  const updated = await core.templates.list({ channel: 'whatsapp' });
  assert.equal(updated[0].approvalStatus, 'DRAFT');
  assert.equal(updated[0].version, 2);
  await assert.rejects(core.sender.send(base(core, { channel: 'whatsapp' })), { code: 'TEMPLATE_NOT_APPROVED' });
  const auto = await core.sender.send(base(core));
  assert.equal(auto.channel, 'sms', 'auto routing skips the unapproved WhatsApp template');
});

test('free-form WhatsApp text needs an open 24 h customer service window', async () => {
  const core = await scenario(fake);
  await assert.rejects(core.sender.send({ to: PHONE, channel: 'whatsapp', text: 'Hi' }), { code: 'WINDOW_CLOSED' });
  await core.contacts.touch(core.contact.id, 'inbound', core.clock.t, 'whatsapp');
  const ok = await core.sender.send({ to: PHONE, channel: 'whatsapp', text: 'Hi' });
  assert.equal(ok.status, 'queued');
  core.advance(24 * 3_600_000 + 1);
  await assert.rejects(core.sender.send({ to: PHONE, channel: 'whatsapp', text: 'Hi' }), { code: 'WINDOW_CLOSED' });
});

test('routing rules pick the chain by template, country or tag', async () => {
  const core = await scenario(fake);
  const { revision } = await core.settings.getWithRevision();
  await core.settings.save(
    {
      ...DEFAULTS,
      routing: {
        defaultChain: ['whatsapp', 'sms'],
        rules: [
          { id: 'urgent', name: 'Urgent by SMS', templateKeys: [], countries: [], tags: ['urgent'], chain: ['sms'] },
        ],
      },
    },
    revision
  );
  assert.equal((await core.sender.send(base(core, { tags: ['urgent'] }))).channel, 'sms');
  assert.equal((await core.sender.send(base(core))).channel, 'whatsapp');
});

test('e-mail is the last step through Magic Mail when installed', async () => {
  const mails = [];
  const magicMail = { send: async (data, options) => mails.push({ data, options }) };
  const core = await scenario(fake, { magicMail });
  const { revision } = await core.settings.getWithRevision();
  await core.settings.save(
    {
      ...DEFAULTS,
      routing: { defaultChain: ['whatsapp', 'email'], rules: [] },
      fallback: { emailEnabled: true, emailTemplateReferenceId: 7 },
    },
    revision
  );
  fake.queue('meta.send', { status: 400, json: { error: { code: 131026, message: 'undeliverable' } } });
  const res = await core.sender.send(base(core, { email: 'ana@example.test', idempotencyKey: 'mail-1' }));
  assert.equal(res.channel, 'whatsapp');
  await core.drain();
  assert.equal(mails.length, 1);
  assert.equal(mails[0].data.to, 'ana@example.test');
  assert.equal(mails[0].data.templateReferenceId, 7);
  assert.deepEqual(mails[0].data.templateData, { name: 'Ana', order: 'A-1', text: '' });
  assert.equal(mails[0].options.idempotencyScope, 'magic-messagegate');
  assert.match(mails[0].options.idempotencyKey, /^fallback:[a-z0-9]+:email$/);
});

test('without Magic Mail the e-mail step is skipped with NO_ROUTE', async () => {
  const core = await scenario(fake);
  const { revision } = await core.settings.getWithRevision();
  await core.settings.save(
    {
      ...DEFAULTS,
      routing: { defaultChain: ['email'], rules: [] },
      fallback: { emailEnabled: true, emailTemplateReferenceId: 7 },
    },
    revision
  );
  await assert.rejects(core.sender.send(base(core, { email: 'ana@example.test' })), { code: 'NO_ROUTE' });
});

test('Telegram needs a linked chat; linking grants consent', async () => {
  const core = await scenario(fake);
  const { addAccount } = require('./helpers/core');
  await addAccount(core, 'telegram');
  await core.templates.create({
    key: 'order_shipped',
    channel: 'telegram',
    language: 'de',
    name: 'TG',
    content: { text: '<b>{{name}}</b> {{order}}' },
  });
  const { row } = await core.contacts.upsertByPhone(PHONE2);
  await assert.rejects(core.sender.send(base(core, { to: PHONE2, channel: 'telegram' })), { code: 'NOT_LINKED' });
  const token = await core.contacts.createLinkToken(row.id);
  assert.ok(await core.contacts.consumeLinkToken(token, '777001'));
  assert.equal(await core.contacts.consumeLinkToken(token, '777001'), null, 'tokens work once');
  const res = await core.sender.send(
    base(core, { to: PHONE2, channel: 'telegram', variables: { name: '<Ana>', order: 'A-1' } })
  );
  await core.drain();
  assert.equal((await core.outbox.getRow(res.id)).status, 'sent');
  assert.equal(fake.of('telegram.send')[0].json.text, '<b>&lt;Ana&gt;</b> A-1');
});

test('pinned account and missing accounts', async () => {
  const core = await scenario(fake);
  await assert.rejects(core.sender.send(base(core, { channel: 'whatsapp', accountId: core.sms.id })), {
    code: 'NO_ACCOUNT',
  });
  const res = await core.sender.send(base(core, { channel: 'whatsapp', accountId: core.wa.id }));
  assert.equal(res.status, 'queued');
  await core.accounts.remove(core.sms.id);
  await assert.rejects(core.sender.send(base(core, { channel: 'sms' })), { code: 'NO_ACCOUNT' });
});

test('failover to a second account of the same channel when the first is throttled', async () => {
  const core = await scenario(fake);
  const { addAccount } = require('./helpers/core');
  await addAccount(core, 'twilio', { fields: { priority: 200 } });
  fake.queue('seven.send', { status: 200, json: { success: '500', messages: [] } });
  const { id } = await core.sender.send(base(core, { channel: 'sms' }));
  assert.deepEqual(await core.drain(), ['sent']);
  const row = await core.outbox.getRow(id);
  assert.match(row.provider_message_id, /^SM/);
  assert.equal(fake.count('seven.send'), 1);
  assert.equal(fake.count('twilio.send'), 1);
});

test('send by userId uses the linked contact', async () => {
  const core = await scenario(fake);
  await core.contacts.upsertByPhone(PHONE2, { userId: 42 });
  await assert.rejects(core.sender.send({ userId: 43, template: 'order_shipped', variables: core.vars }), {
    code: 'NOT_FOUND',
  });
  const { row } = await core.contacts.upsertByPhone(PHONE2);
  await core.contacts.setConsent(row.id, 'sms', 'granted', 'test');
  const res = await core.sender.send({
    userId: 42,
    channel: 'sms',
    template: 'order_shipped',
    language: 'de',
    variables: core.vars,
  });
  assert.equal(res.status, 'queued');
});
