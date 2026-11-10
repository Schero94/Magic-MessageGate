'use strict';

/** Meta Embedded Signup completion, masked recipients in message lists, lookup budget status. */
const test = require('node:test');
const assert = require('node:assert/strict');

const { startFakeProviders } = require('./helpers/fake-providers');
const { makeCore, PHONE } = require('./helpers/core');
const { scenario } = require('./helpers/scenario');
const { DEFAULTS } = require('../server/src/core/settings');

const SIGNUP = { appId: '1000000001', configId: '2000000002', appSecret: 'synthetic-app-secret-0123456789' };

let fake;
test.before(async () => {
  fake = await startFakeProviders();
});
test.after(() => fake.close());
test.beforeEach(() => fake.reset());

const providersWithSignup = () => ({ ...fake.providers, meta: { ...fake.providers.meta, embeddedSignup: SIGNUP } });

test('embedded signup: disabled without app ID, configuration ID and app secret', async () => {
  const core = await makeCore({ providers: fake.providers });
  await assert.rejects(
    core.accounts.completeEmbeddedSignup({
      code: 'synthetic-code-123',
      event: 'FINISH',
      wabaId: '3000000003',
      phoneNumberId: '4000000004',
      name: 'Shop',
    }),
    { code: 'EMBEDDED_SIGNUP_DISABLED' }
  );
  assert.equal(fake.count('meta.oauth'), 0);
});

test('embedded signup: a new number is exchanged, subscribed and registered with a stored PIN', async () => {
  const core = await makeCore({ providers: providersWithSignup() });
  const { account, steps } = await core.accounts.completeEmbeddedSignup({
    code: 'synthetic-code-123',
    event: 'FINISH',
    wabaId: '3000000003',
    phoneNumberId: '4000000004',
    name: 'Shop WhatsApp',
    isDefault: true,
  });
  assert.deepEqual(steps, { exchange: 'ok', subscribe: 'ok', register: 'ok', contactsSync: null, historySync: null });
  const [oauth] = fake.of('meta.oauth');
  const query = new URL(oauth.url, 'http://x').searchParams;
  assert.equal(query.get('client_id'), SIGNUP.appId);
  assert.equal(query.get('client_secret'), SIGNUP.appSecret);
  assert.equal(query.get('code'), 'synthetic-code-123');
  assert.equal(fake.of('meta.subscribe')[0].match[1], '3000000003');
  assert.match(fake.of('meta.subscribe')[0].headers.authorization, /^Bearer EAAsynthetic-business-token-0001$/);
  const register = fake.of('meta.register')[0];
  assert.equal(register.match[1], '4000000004');
  assert.equal(register.json.messaging_product, 'whatsapp');
  assert.match(register.json.pin, /^\d{6}$/);
  assert.equal(fake.count('meta.smbSync'), 0);
  assert.equal(account.config.coexistence, false);
  assert.equal(account.config.onboarding, 'embedded');
  assert.equal(account.isDefault, true);
  assert.deepEqual(account.secretsSet, { accessToken: true, appSecret: true, verifyToken: true, twoStepPin: true });
  const stored = core.accounts.configOf(await core.accounts.getRow(account.id));
  assert.equal(stored.twoStepPin, register.json.pin);
  assert.ok(!JSON.stringify(account).includes(SIGNUP.appSecret));
  assert.ok(!JSON.stringify(account).includes('EAAsynthetic-business-token-0001'));
});

test('embedded signup: a Business App number (Coexistence) skips register and starts both syncs', async () => {
  const core = await makeCore({ providers: providersWithSignup() });
  const { account, steps } = await core.accounts.completeEmbeddedSignup({
    code: 'synthetic-code-456',
    event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
    wabaId: '3000000005',
    phoneNumberId: '4000000006',
    businessId: '5000000007',
    name: 'Shop Business App',
  });
  assert.equal(steps.register, null);
  assert.equal(steps.contactsSync, 'started');
  assert.equal(steps.historySync, 'started');
  assert.equal(fake.count('meta.register'), 0);
  assert.deepEqual(
    fake.of('meta.smbSync').map((r) => r.json.sync_type),
    ['smb_app_state_sync', 'history']
  );
  assert.equal(account.config.coexistence, true);
  assert.equal(account.config.businessId, '5000000007');
  assert.equal(account.secretsSet.twoStepPin, undefined);
});

test('embedded signup: a failed exchange creates no account and reports only the step and code', async () => {
  const core = await makeCore({ providers: providersWithSignup() });
  fake.queue('meta.oauth', { status: 400, json: { error: { code: 100, message: 'Invalid code synthetic' } } });
  await assert.rejects(
    core.accounts.completeEmbeddedSignup({
      code: 'expired-code-000',
      event: 'FINISH',
      wabaId: '3000000003',
      phoneNumberId: '4000000004',
      name: 'Shop',
    }),
    (error) => {
      assert.equal(error.code, 'PROVIDER_ERROR');
      assert.deepEqual(error.details, { step: 'exchange', reason: 'META_100' });
      return true;
    }
  );
  assert.equal((await core.accounts.list()).length, 0);
  await assert.rejects(
    core.accounts.completeEmbeddedSignup({ code: 'x', event: 'CANCEL', wabaId: '1', phoneNumberId: '1', name: '' }),
    { code: 'CONFIG_INVALID' }
  );
});

test('messages: lists show a masked recipient and filter by phone number', async () => {
  const core = await scenario(fake);
  await core.sender.send({ to: PHONE, template: 'order_shipped', language: 'de', variables: core.vars });
  const list = await core.outbox.list({});
  assert.equal(list.results.length, 1);
  assert.equal(list.results[0].recipient.phoneMasked, `${PHONE.slice(0, 4)}•••${PHONE.slice(-2)}`);
  assert.ok(!JSON.stringify(list).includes(PHONE));
  const filtered = await core.outbox.list({ phone: PHONE });
  assert.equal(filtered.pagination.total, 1);
  const none = await core.outbox.list({ phone: '+4917000000000' });
  assert.equal(none.pagination.total, 0);
  const detail = await core.outbox.detail(list.results[0].id);
  assert.equal(detail.recipient.id, list.results[0].recipient.id);
});

test('lookup: budget status reports the month, usage and limit', async () => {
  const core = await scenario(fake, { settings: { lookup: { ...DEFAULTS.lookup, enabled: false } } });
  const status = await core.lookup.budgetStatus();
  assert.equal(status.enabled, false);
  assert.equal(status.used, 0);
  assert.equal(status.budget, DEFAULTS.lookup.monthlyBudget);
  assert.match(status.month, /^\d{4}-\d{2}$/);
});
