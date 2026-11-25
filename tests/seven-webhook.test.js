'use strict';

/**
 * Issue #17: "Test connection" on a seven.io account registers the status
 * report (`dlr`) and inbound SMS (`sms_mo`) webhooks through seven.io's hooks
 * API with request method JSON. Idempotent, never touches hooks MessageGate
 * did not create, and "Remove webhook" deletes only its own hooks.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { startFakeProviders } = require('./helpers/fake-providers');
const { makeCore, addAccount, CREDS } = require('./helpers/core');

let fake;
test.before(async () => {
  fake = await startFakeProviders();
});
test.after(() => fake.close());
test.beforeEach(() => fake.reset());

/**
 * @param {object} [config] - Extra plugin config.
 * @param {string} [publicUrl] - Public URL as Strapi passes it (`server.url`, not validated).
 * @returns {Promise<{core: object, account: object, logs: string[]}>}
 */
async function setup(config = {}, publicUrl) {
  const logs = [];
  const core = await makeCore({ providers: fake.providers, config });
  if (publicUrl !== undefined) {
    core.ctx.publicUrl = publicUrl;
    core.ctx.apiBase = `${publicUrl}/api/magic-messagegate`;
  }
  core.ctx.log = {
    debug() {},
    info() {},
    warn: (m) => logs.push(String(m)),
    error: (m) => logs.push(String(m)),
  };
  const account = await addAccount(core, 'seven');
  return { core, account, logs };
}

/** @param {object} hook - Fields of the fake account's hook list. */
const foreign = (hook) =>
  fake.sevenHooks.push({
    id: String(500 + fake.sevenHooks.length),
    headers: '',
    event_filter: null,
    enabled: true,
    created: '2026-01-01 00:00:00',
    ...hook,
  });

test('test connection registers one JSON hook per event for the account webhook URL', async () => {
  const { core, account } = await setup();
  const result = await core.accounts.testConnection(account.id);
  assert.equal(result.ok, true);
  assert.equal(result.info.webhook, 'registered');
  assert.equal(result.info.webhookCode, undefined);

  const created = fake.of('seven.hooksCreate');
  assert.equal(created.length, 2);
  assert.deepEqual(
    created.map((r) => r.form),
    [
      { target_url: account.webhookUrl, event_type: 'dlr', request_method: 'JSON' },
      { target_url: account.webhookUrl, event_type: 'sms_mo', request_method: 'JSON' },
    ]
  );
  for (const r of created) assert.equal(r.headers['x-api-key'], CREDS.seven.apiKey);
  assert.match(account.webhookUrl, /^https:\/\/cms\.example\.test\/api\/magic-messagegate\/webhooks\/seven\//);

  const [dto] = await core.accounts.list();
  assert.equal(dto.webhookRegistration.status, 'registered');
  assert.deepEqual(dto.webhookRegistration.events, ['dlr', 'sms_mo']);
  assert.equal(dto.webhookRegistration.managed, 2);
  assert.equal(dto.webhookRegistration.conflict, false);
  // No hook ids, URLs or secrets in the DTO.
  const text = JSON.stringify(dto.webhookRegistration);
  assert.ok(!text.includes('http'));
  assert.ok(!text.includes(fake.sevenHooks[0].id));
  assert.ok(!JSON.stringify(dto).includes(CREDS.seven.apiKey));
  assert.ok(!JSON.stringify(dto).includes(CREDS.seven.signingKey));
});

test('a second test connection creates nothing (idempotent)', async () => {
  const { core, account } = await setup();
  await core.accounts.testConnection(account.id);
  await core.accounts.testConnection(account.id);
  const again = await core.accounts.testConnection(account.id);
  assert.equal(again.info.webhook, 'registered');
  assert.equal(fake.count('seven.hooksCreate'), 2);
  assert.equal(fake.count('seven.hooksList'), 3, 'existing hooks are read every time');
  assert.equal(fake.sevenHooks.length, 2);
  const [dto] = await core.accounts.list();
  assert.equal(dto.webhookRegistration.managed, 2);
});

test('hooks created elsewhere are reused, reported and never changed', async () => {
  const { core, account } = await setup();
  // The owner's own JSON hook for all events already delivers to this URL.
  foreign({ target_url: account.webhookUrl, event_type: 'all', request_method: 'JSON' });
  // A form hook for the same URL: MessageGate cannot read it (audit finding 1).
  foreign({ target_url: account.webhookUrl, event_type: 'dlr', request_method: 'POST' });
  // Someone else's hook.
  foreign({ target_url: 'https://other.example.test/hook', event_type: 'sms_mo', request_method: 'JSON' });
  const before = structuredClone(fake.sevenHooks);

  const result = await core.accounts.testConnection(account.id);
  assert.equal(result.info.webhook, 'registered');
  assert.equal(fake.count('seven.hooksCreate'), 0, '`all` with JSON already covers dlr and sms_mo');
  assert.equal(fake.count('seven.hooksDelete'), 0);
  assert.deepEqual(fake.sevenHooks, before);
  const [dto] = await core.accounts.list();
  assert.deepEqual(dto.webhookRegistration, {
    status: 'registered',
    code: null,
    at: dto.webhookRegistration.at,
    events: ['dlr', 'sms_mo'],
    managed: 0,
    conflict: true,
  });

  // Remove deletes nothing that MessageGate did not create.
  const removed = await core.accounts.removeWebhook(account.id);
  assert.equal(removed.removed, 0);
  assert.equal(fake.count('seven.hooksDelete'), 0);
  assert.deepEqual(fake.sevenHooks, before);
  assert.equal(removed.account.webhookRegistration.status, 'registered');
});

test('a disabled or form hook for the URL does not count; the missing JSON hooks are added', async () => {
  const { core, account } = await setup();
  foreign({ target_url: account.webhookUrl, event_type: 'dlr', request_method: 'JSON', enabled: false });
  foreign({ target_url: account.webhookUrl, event_type: 'sms_mo', request_method: 'POST' });
  await core.accounts.testConnection(account.id);
  assert.deepEqual(
    fake.of('seven.hooksCreate').map((r) => r.form.event_type),
    ['dlr', 'sms_mo']
  );
  const [dto] = await core.accounts.list();
  assert.equal(dto.webhookRegistration.conflict, true);
  assert.equal(dto.webhookRegistration.managed, 2);
  assert.equal(fake.sevenHooks.length, 4);
});

test('remove webhook deletes only the hooks MessageGate created; test connection adds them again', async () => {
  const { core, account } = await setup();
  foreign({ target_url: 'https://other.example.test/hook', event_type: 'dlr', request_method: 'JSON' });
  await core.accounts.testConnection(account.id);
  assert.equal(fake.sevenHooks.length, 3);
  const mine = fake.sevenHooks.filter((h) => h.target_url === account.webhookUrl).map((h) => ({ id: h.id }));

  const result = await core.accounts.removeWebhook(account.id);
  assert.equal(result.removed, 2);
  assert.equal(result.failed, 0);
  assert.deepEqual(
    fake.of('seven.hooksDelete').map((r) => r.form),
    mine
  );
  assert.deepEqual(
    fake.sevenHooks.map((h) => h.target_url),
    ['https://other.example.test/hook']
  );
  assert.equal(result.account.webhookRegistration.status, 'removed');
  assert.equal(result.account.webhookRegistration.managed, 0);
  assert.deepEqual(result.account.webhookRegistration.events, []);

  // Removing twice is harmless.
  const twice = await core.accounts.removeWebhook(account.id);
  assert.equal(twice.removed, 0);

  await core.accounts.testConnection(account.id);
  assert.equal(fake.sevenHooks.length, 3);
});

test('a hook deleted in the dashboard, or whose id now points elsewhere, is not deleted again', async () => {
  const { core, account } = await setup();
  await core.accounts.testConnection(account.id);
  const [dlr, smsMo] = fake.sevenHooks;
  fake.sevenHooks.splice(0, 1); // owner deleted the dlr hook at seven.io
  smsMo.target_url = 'https://other.example.test/hook'; // id reused for another URL
  const result = await core.accounts.removeWebhook(account.id);
  assert.equal(result.removed, 0);
  assert.equal(fake.count('seven.hooksDelete'), 0);
  assert.ok(dlr);
  assert.equal(fake.sevenHooks.length, 1);
});

test('without a public https URL nothing is registered', async () => {
  for (const [publicUrl, code] of [
    ['', 'PUBLIC_URL_MISSING'],
    ['http://localhost:1337', 'PUBLIC_URL_NOT_PUBLIC'],
    ['http://cms.example.test', 'PUBLIC_URL_NOT_PUBLIC'],
    ['https://127.0.0.1', 'PUBLIC_URL_NOT_PUBLIC'],
  ]) {
    fake.reset();
    const { core, account } = await setup({}, publicUrl);
    const result = await core.accounts.testConnection(account.id);
    assert.equal(result.ok, true, 'the credentials still work');
    assert.equal(result.info.webhook, 'skipped', publicUrl);
    assert.equal(result.info.webhookCode, code, publicUrl);
    assert.equal(fake.count('seven.hooksList'), 0);
    assert.equal(fake.count('seven.hooksCreate'), 0);
    const [dto] = await core.accounts.list();
    assert.equal(dto.webhookRegistration.status, 'skipped');
    assert.equal(dto.webhookRegistration.code, code);
  }
});

test('provider errors are reported with a code; nothing is created blindly; logs hold no URL or key', async () => {
  const { core, account, logs } = await setup();
  // Auth failures answer a bare return code.
  fake.queue('seven.hooksList', { status: 200, json: 900 });
  let result = await core.accounts.testConnection(account.id);
  assert.equal(result.ok, true);
  assert.equal(result.info.webhook, 'failed');
  assert.equal(result.info.webhookCode, 'SEVEN_900');
  assert.equal(fake.count('seven.hooksCreate'), 0, 'without the list, a create could duplicate a hook');

  fake.queue('seven.hooksCreate', {
    status: 200,
    json: { success: false, code: 'invalid_url', id: null, error_message: 'Invalid target URL' },
  });
  result = await core.accounts.testConnection(account.id);
  assert.equal(result.info.webhook, 'failed');
  assert.equal(result.info.webhookCode, 'SEVEN_invalid_url');
  const [dto] = await core.accounts.list();
  assert.deepEqual(dto.webhookRegistration.events, ['sms_mo'], 'the hook that worked is kept');
  assert.equal(dto.webhookRegistration.managed, 1);

  fake.queue('seven.hooksCreate', { status: 503, json: {} });
  fake.queue('seven.hooksList', { status: 200, json: { success: true, hooks: fake.sevenHooks } });
  result = await core.accounts.testConnection(account.id);
  assert.equal(result.info.webhookCode, 'HTTP_503');

  assert.ok(logs.length >= 1);
  for (const line of logs) {
    assert.ok(!line.includes('http'), 'no URL in the log');
    assert.ok(!line.includes(CREDS.seven.apiKey));
    assert.ok(!line.includes(CREDS.seven.signingKey));
  }
  const raw = await core.knex('mg_accounts').where('document_id', account.id).first();
  assert.ok(!raw.webhook_state.includes(CREDS.seven.apiKey));
});

test('remove webhook: list failure is a 502 PROVIDER_ERROR; other providers are refused', async () => {
  const { core, account } = await setup();
  await core.accounts.testConnection(account.id);
  fake.queue('seven.hooksList', { status: 401, json: { success: false, code: '900' } });
  await assert.rejects(core.accounts.removeWebhook(account.id), (e) => {
    assert.equal(e.code, 'PROVIDER_ERROR');
    assert.equal(e.status, 502);
    assert.deepEqual(e.details, { reason: 'HTTP_401' });
    return true;
  });
  assert.equal(fake.sevenHooks.length, 2);

  const tg = await addAccount(core, 'telegram');
  await assert.rejects(core.accounts.removeWebhook(tg.id), { code: 'INVALID_REQUEST' });
  await assert.rejects(core.accounts.removeWebhook('doesnotexist0'), { code: 'NOT_FOUND' });
  const tgDto = (await core.accounts.list()).find((a) => a.id === tg.id);
  assert.equal(tgDto.webhookRegistration, null);
});

test('deleting the account removes the hooks MessageGate created, and nothing else', async () => {
  const { core, account } = await setup();
  foreign({ target_url: 'https://other.example.test/hook', event_type: 'dlr', request_method: 'JSON' });
  await core.accounts.testConnection(account.id);
  await core.accounts.remove(account.id);
  assert.deepEqual(
    fake.sevenHooks.map((h) => h.target_url),
    ['https://other.example.test/hook']
  );
  assert.equal(await core.accounts.getRow(account.id), null);

  // A seven.io outage does not block the delete.
  const second = await addAccount(core, 'seven');
  await core.accounts.testConnection(second.id);
  fake.queue('seven.hooksList', { status: 503, json: {} });
  await core.accounts.remove(second.id);
  assert.equal(await core.accounts.getRow(second.id), null);
});

test('two concurrent test connections register each hook once', async () => {
  const { core, account } = await setup();
  fake.setDelay(30);
  const results = await Promise.all([
    core.accounts.testConnection(account.id),
    core.accounts.testConnection(account.id),
  ]);
  fake.setDelay(0);
  assert.equal(fake.count('seven.hooksCreate'), 2);
  assert.deepEqual(results.map((r) => r.info.webhook).sort(), ['failed', 'registered']);
  assert.ok(results.some((r) => r.info.webhookCode === 'WEBHOOK_BUSY'));
});

test('sandbox mode registers and removes hooks without network', async () => {
  const { core, account } = await setup({ providers: { mode: 'sandbox' } });
  const result = await core.accounts.testConnection(account.id);
  assert.equal(result.info.webhook, 'registered');
  assert.equal(fake.requests.length, 0);
  const again = await core.accounts.testConnection(account.id);
  assert.equal(again.info.webhook, 'registered');
  const removed = await core.accounts.removeWebhook(account.id);
  assert.equal(removed.removed, 2);
});
