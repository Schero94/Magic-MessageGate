'use strict';

/** Accounts, templates (Meta submit/sync), contacts (GDPR), settings, lookup, analytics. */
const test = require('node:test');
const assert = require('node:assert/strict');

const { startFakeProviders } = require('./helpers/fake-providers');
const { scenario } = require('./helpers/scenario');
const { addAccount, CREDS, PHONE, PHONE2 } = require('./helpers/core');
const { DEFAULTS } = require('../server/src/core/settings');

let fake;
test.before(async () => {
  fake = await startFakeProviders();
});
test.after(() => fake.close());
test.beforeEach(() => fake.reset());

test('accounts: secrets are encrypted at rest, masked in DTOs and kept on partial update', async () => {
  const core = await scenario(fake);
  const raw = await core.knex('mg_accounts').where('document_id', core.wa.id).first();
  assert.ok(!JSON.stringify(raw).includes(CREDS.meta.accessToken), 'the token must not be stored in clear text');
  const [dto] = (await core.accounts.list()).filter((a) => a.id === core.wa.id);
  assert.ok(!JSON.stringify(dto).includes(CREDS.meta.accessToken));
  assert.ok(!JSON.stringify(dto).includes(CREDS.meta.appSecret));
  assert.deepEqual(dto.secretsSet, { accessToken: true, appSecret: true, verifyToken: true });
  assert.equal(dto.config.phoneNumberId, CREDS.meta.phoneNumberId);
  assert.match(
    dto.webhookUrl,
    /^https:\/\/cms\.example\.test\/api\/magic-messagegate\/webhooks\/meta\/[A-Za-z0-9_-]{24,}$/
  );
  await core.accounts.update(core.wa.id, { name: 'Renamed', config: { phoneNumberId: '1234567899', accessToken: '' } });
  const config = core.accounts.configOf(await core.accounts.getRow(core.wa.id));
  assert.equal(config.accessToken, CREDS.meta.accessToken, 'an empty secret keeps the stored one');
  assert.equal(config.phoneNumberId, '1234567899');
  await assert.rejects(
    core.accounts.create({ channel: 'whatsapp', provider: 'meta', name: 'x', config: { accessToken: 'short' } }),
    { code: 'CONFIG_INVALID' }
  );
  await assert.rejects(core.accounts.create({ channel: 'sms', provider: 'meta', name: 'x', config: CREDS.meta }), {
    code: 'CONFIG_INVALID',
  });
});

test('accounts: one default per channel; test connection records health', async () => {
  const core = await scenario(fake);
  const second = await addAccount(core, 'meta', { fields: { isDefault: true } });
  const defaults = (await core.accounts.list()).filter((a) => a.channel === 'whatsapp' && a.isDefault);
  assert.deepEqual(
    defaults.map((a) => a.id),
    [second.id]
  );
  const ok = await core.accounts.testConnection(core.wa.id);
  assert.equal(ok.ok, true);
  fake.queue('meta.info', { status: 401, json: { error: { code: 190, message: 'expired' } } });
  const bad = await core.accounts.testConnection(core.wa.id);
  assert.equal(bad.ok, false);
  const [dto] = (await core.accounts.list()).filter((a) => a.id === core.wa.id);
  assert.equal(dto.health.status, 'error');
  assert.equal(dto.health.code, 'META_190');
});

test('accounts: Telegram test registers the webhook with a secret and stores the bot name', async () => {
  const core = await scenario(fake);
  const tg = await addAccount(core, 'telegram');
  const result = await core.accounts.testConnection(tg.id);
  assert.equal(result.ok, true);
  const hook = fake.of('telegram.setWebhook')[0].json;
  assert.equal(hook.url, tg.webhookUrl);
  assert.equal(hook.secret_token, core.accounts.configOf(await core.accounts.getRow(tg.id)).secretToken);
  assert.equal(core.accounts.configOf(await core.accounts.getRow(tg.id)).botUsername, 'synthetic_test_bot');
});

test('templates: submit to Meta builds components with examples; sync updates statuses', async () => {
  const core = await scenario(fake);
  const t = await core.templates.create({
    key: 'appointment',
    channel: 'whatsapp',
    language: 'de',
    name: 'Appointment',
    content: {
      header: { format: 'TEXT', text: 'Termin {{date}}' },
      body: 'Hallo {{name}}, Ihr Termin ist am {{date}}.',
      footer: 'Praxis',
      buttons: [{ type: 'URL', text: 'Details', url: 'https://example.test/a/{{ref}}' }],
    },
    variables: [
      { name: 'date', example: '01.02.' },
      { name: 'name', example: 'Ana' },
      { name: 'ref', example: 'R1' },
    ],
  });
  assert.equal(t.approvalStatus, 'DRAFT');
  assert.deepEqual(
    t.variables.map((v) => v.name),
    ['date', 'name', 'ref']
  );
  const submitted = await core.templates.submitToMeta(t.id, core.wa.id);
  assert.equal(submitted.approvalStatus, 'PENDING');
  const body = fake.of('meta.submit')[0].json;
  assert.equal(body.name, 'appointment');
  assert.equal(body.parameter_format, 'named');
  const types = body.components.map((c) => c.type);
  assert.deepEqual(types, ['HEADER', 'BODY', 'FOOTER', 'BUTTONS']);
  assert.deepEqual(body.components[1].example, {
    body_text_named_params: [
      { param_name: 'name', example: 'Ana' },
      { param_name: 'date', example: '01.02.' },
    ],
  });
  fake.queue('meta.templates', {
    status: 200,
    json: {
      data: [
        {
          id: submitted.providerTemplateId,
          name: 'appointment',
          language: 'de',
          status: 'APPROVED',
          category: 'UTILITY',
          components: [],
        },
      ],
    },
  });
  const sync = await core.templates.syncFromMeta(core.wa.id);
  assert.ok(sync.updated >= 1);
  assert.equal((await core.templates.getRow(t.id)).approval_status, 'APPROVED');
});

test('templates: preview renders without sending; duplicate key/channel/language is refused', async () => {
  const core = await scenario(fake);
  const [sms] = await core.templates.list({ channel: 'sms' });
  const preview = await core.templates.preview(sms.id, { name: 'Ana', order: 'A-1' });
  assert.equal(preview.preview, 'Hallo Ana, Bestellung A-1 ist unterwegs.');
  assert.deepEqual(preview.sms, { encoding: 'GSM-7', characters: 40, segments: 1 });
  await assert.rejects(
    core.templates.create({
      key: 'order_shipped',
      channel: 'sms',
      language: 'de',
      name: 'dup',
      content: { text: 'x' },
    }),
    { code: 'CONFIG_INVALID' }
  );
  assert.equal(fake.count('seven.send'), 0);
});

test('contacts: phone numbers are hashed and sealed; search works by number', async () => {
  const core = await scenario(fake);
  const raw = await core.knex('mg_contacts').first();
  assert.ok(!JSON.stringify(raw).includes('15123456789'));
  const found = await core.contacts.list({ phone: '0151 23456789' });
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0].phone, PHONE);
  assert.equal((await core.contacts.list({ phone: PHONE2 })).results.length, 0);
});

test('contacts: GDPR export and erasure', async () => {
  const core = await scenario(fake);
  const res = await core.sender.send({
    to: PHONE,
    channel: 'sms',
    template: 'order_shipped',
    language: 'de',
    variables: core.vars,
  });
  await core.drain();
  const exported = await core.contacts.exportData(core.contact.document_id);
  assert.equal(exported.contact.phone, PHONE);
  assert.equal(exported.messages.length, 1);
  await core.contacts.erase(core.contact.document_id);
  assert.equal(await core.contacts.getRow(core.contact.document_id), null);
  const msg = await core.outbox.getRow(res.id);
  assert.equal(msg.contact_id, null);
  assert.equal(msg.payload_sealed, null);
  assert.equal(msg.status, 'sent', 'statistics stay');
});

test('settings: validated, optimistic concurrency', async () => {
  const core = await scenario(fake);
  const first = await core.settings.getWithRevision();
  assert.equal(first.revision, 0);
  assert.deepEqual(first.value, DEFAULTS);
  const saved = await core.settings.save({ ...DEFAULTS, requireConsent: false }, 0);
  assert.equal(saved.revision, 1);
  await assert.rejects(core.settings.save({ ...DEFAULTS }, 0), { code: 'STATE_CHANGED' });
  await assert.rejects(core.settings.save({ ...DEFAULTS, defaultCountry: 'de' }, 1), { code: 'CONFIG_INVALID' });
  await assert.rejects(core.settings.save({ ...DEFAULTS, routing: { defaultChain: ['fax'], rules: [] } }, 1), {
    code: 'CONFIG_INVALID',
  });
  assert.equal((await core.settings.get()).requireConsent, false);
});

test('lookup: local check, learned WhatsApp state, cached remote lookup with budget', async () => {
  const core = await scenario(fake);
  const local = await core.lookup.check('0151 23456789');
  assert.equal(local.valid, true);
  assert.equal(local.e164, PHONE);
  assert.equal(local.mobile, true);
  assert.equal(local.whatsapp, 'unknown');
  assert.equal(local.remote, null);
  assert.equal((await core.lookup.check('123')).valid, false);
  await core.contacts.setWhatsappReachability(core.contact.id, 'unreachable');
  assert.equal((await core.lookup.check(PHONE)).whatsapp, 'unreachable');

  const twilio = await addAccount(core, 'twilio');
  const { revision } = await core.settings.getWithRevision();
  await core.settings.save(
    { ...DEFAULTS, lookup: { enabled: true, accountId: twilio.id, cacheDays: 30, monthlyBudget: 2 } },
    revision
  );
  const remote = await core.lookup.check(PHONE);
  assert.equal(remote.remote.lineType, 'mobile');
  const cached = await core.lookup.check(PHONE);
  assert.equal(cached.remote.cached, true);
  assert.equal(fake.count('twilio.lookup'), 1);
  await core.lookup.check(PHONE2);
  await assert.rejects(core.lookup.check('+4917699999999'), { code: 'LOOKUP_BUDGET_EXCEEDED' });
  assert.equal(fake.count('twilio.lookup'), 2);
  assert.equal((await core.lookup.check(PHONE2, { remote: false })).remote, null);
});

test('analytics: totals, delivery and read rates, failures, queue', async () => {
  const core = await scenario(fake);
  for (let i = 0; i < 4; i += 1)
    await core.sender.send({
      to: PHONE,
      channel: 'whatsapp',
      template: 'order_shipped',
      language: 'de',
      variables: core.vars,
    });
  fake.queue('meta.send', { status: 400, json: { error: { code: 131026, message: 'x' } } });
  await core.drain();
  const rows = await core.knex('mg_messages').where({ status: 'sent' });
  await core.outbox.applyProviderStatus({ providerMessageId: rows[0].provider_message_id, status: 'read' });
  await core.outbox.applyProviderStatus({ providerMessageId: rows[1].provider_message_id, status: 'delivered' });
  const summary = await core.analytics.summary({});
  assert.equal(summary.totals.total, 4);
  assert.equal(summary.totals.sent, 3);
  assert.equal(summary.totals.delivered, 2);
  assert.equal(summary.totals.read, 1);
  assert.equal(summary.totals.failed, 1);
  assert.equal(summary.totals.deliveryRate, 66.7);
  assert.equal(summary.totals.readRate, 50);
  assert.deepEqual(summary.failures, [{ code: 'META_131026', total: 1 }]);
  assert.equal(summary.byTemplate[0].template_key, 'order_shipped');
  assert.equal(summary.byChannel[0].channel, 'whatsapp');
});
