'use strict';

/**
 * Webhooks end to end through the controller: real signatures (computed here
 * with node:crypto, independent of the plugin's own signer), dedupe, replay
 * protection, status timelines, opt-out and linking.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { startFakeProviders } = require('./helpers/fake-providers');
const { fakeStrapi, makeCtx } = require('./helpers/strapi');
const { CREDS, PHONE } = require('./helpers/core');
const webhookController = require('../server/src/controllers/webhooks');

let fake;
test.before(async () => {
  fake = await startFakeProviders();
});
test.after(() => fake.close());
test.beforeEach(() => fake.reset());

/** Builds a strapi with all four accounts, consent and one sent message per provider. */
async function setup(config = {}) {
  const strapi = await fakeStrapi({ providers: fake.providers, ...config });
  const core = strapi.core;
  const accounts = {};
  for (const [provider, channel] of [
    ['meta', 'whatsapp'],
    ['telegram', 'telegram'],
    ['seven', 'sms'],
    ['twilio', 'sms'],
  ]) {
    const dto = await core.accounts.create({
      channel,
      provider,
      name: provider,
      config: CREDS[provider],
      priority: provider === 'twilio' ? 500 : 100,
    });
    const row = await core.accounts.getRow(dto.id);
    accounts[provider] = { dto, row, config: core.accounts.configOf(row), path: dto.webhookUrl.split('/').pop() };
  }
  await core.templates.create({
    key: 'hello',
    channel: 'whatsapp',
    language: 'de',
    name: 'Hello',
    content: { body: 'Hallo {{name}}' },
  });
  await core.templates.applyProviderStatus({ name: 'hello', language: 'de', status: 'APPROVED' });
  await core.templates.create({
    key: 'hello',
    channel: 'sms',
    language: 'de',
    name: 'Hello',
    content: { text: 'Hallo {{name}}' },
  });
  const { row: contact } = await core.contacts.upsertByPhone(PHONE);
  for (const channel of ['whatsapp', 'sms']) await core.contacts.setConsent(contact.id, channel, 'granted', 'test');
  const controller = webhookController({ strapi });
  /** POST/GET a webhook through the controller. */
  const call = async (provider, { method = 'POST', raw = '', headers = {}, query = {}, path } = {}) => {
    const p = path ?? accounts[provider].path;
    const ctx = makeCtx({
      method,
      params: { provider, path: p },
      query,
      headers,
      raw: method === 'POST' ? raw : undefined,
      path: `/api/magic-messagegate/webhooks/${provider}/${p}`,
    });
    await controller.receive(ctx);
    return ctx;
  };
  const sendVia = async (channel) => {
    const res = await core.sender.send({
      to: PHONE,
      channel,
      template: 'hello',
      language: 'de',
      variables: { name: 'Ana' },
    });
    await core.outbox.tick();
    return core.outbox.getRow(res.id);
  };
  return { strapi, core, accounts, contact, call, sendVia };
}

const metaSign = (raw, secret) => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
const metaBody = (value, field = 'messages') =>
  JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: '9876543210', time: 1800000000, changes: [{ field, value }] }],
  });

test('meta: GET verification answers the challenge only with the right verify token', async () => {
  const { accounts, call } = await setup();
  const good = await call('meta', {
    method: 'GET',
    query: {
      'hub.mode': 'subscribe',
      'hub.verify_token': accounts.meta.config.verifyToken,
      'hub.challenge': '1158201444',
    },
  });
  assert.equal(good.status, 200);
  assert.equal(good.body, '1158201444');
  const bad = await call('meta', {
    method: 'GET',
    query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' },
  });
  assert.equal(bad.status, 403);
  const unknown = await call('meta', { method: 'GET', path: 'x'.repeat(32), query: {} });
  assert.equal(unknown.status, 401);
  const badProvider = await call('meta', { method: 'GET', query: {} });
  assert.equal(badProvider.status, 403);
});

test('meta: signed statuses build the delivered → read timeline; duplicates are ignored', async () => {
  const { core, accounts, call, sendVia, contact } = await setup();
  const row = await sendVia('whatsapp');
  const statuses = (status, ts) =>
    metaBody({
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: '1234567890' },
      statuses: [{ id: row.provider_message_id, status, timestamp: String(ts), recipient_id: '4915123456789' }],
    });
  for (const [status, ts] of [
    ['delivered', 1800000100],
    ['read', 1800000200],
    ['delivered', 1800000100],
  ]) {
    const raw = statuses(status, ts);
    const ctx = await call('meta', {
      raw,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': metaSign(raw, CREDS.meta.appSecret) },
    });
    assert.equal(ctx.status, 200);
  }
  const detail = await core.outbox.detail(row.document_id);
  assert.equal(detail.status, 'read');
  assert.equal(detail.readAt, 1800000200 * 1000);
  assert.deepEqual(
    detail.timeline.map((e) => e.type),
    ['queued', 'sent', 'delivered', 'read']
  );
  const c = await core.contacts.getRowById(contact.id);
  assert.equal(Number(c.last_read_at), 1800000200 * 1000);
  assert.equal(c.wa_reachability, 'ok');
  const raw = statuses('read', 1);
  const forged = await call('meta', { raw, headers: { 'x-hub-signature-256': metaSign(raw, 'not-the-secret') } });
  assert.equal(forged.status, 401);
  assert.ok(accounts.meta);
});

test('meta: failed status 131026 marks the contact unreachable and falls back', async () => {
  const { core, call, sendVia, contact } = await setup();
  const row = await sendVia('auto');
  assert.equal(row.channel, 'whatsapp');
  const raw = metaBody({
    statuses: [
      {
        id: row.provider_message_id,
        status: 'failed',
        timestamp: '1800000300',
        errors: [{ code: 131026, title: 'Message undeliverable' }],
      },
    ],
  });
  const ctx = await call('meta', { raw, headers: { 'x-hub-signature-256': metaSign(raw, CREDS.meta.appSecret) } });
  assert.equal(ctx.status, 200);
  const detail = await core.outbox.detail(row.document_id);
  assert.equal(detail.status, 'failed');
  assert.equal(detail.errorCode, 'META_131026');
  assert.equal(detail.fallbacks.length, 1);
  assert.equal((await core.contacts.getRowById(contact.id)).wa_reachability, 'unreachable');
});

test('meta: template status updates and inbound STOP', async () => {
  const { core, call, contact } = await setup();
  await core.templates.create({
    key: 'promo',
    channel: 'whatsapp',
    language: 'de',
    name: 'Promo',
    category: 'MARKETING',
    content: { body: 'Angebot' },
  });
  let raw = metaBody(
    {
      event: 'REJECTED',
      message_template_id: 555,
      message_template_name: 'promo',
      message_template_language: 'de',
      reason: 'INVALID_FORMAT',
    },
    'message_template_status_update'
  );
  assert.equal(
    (await call('meta', { raw, headers: { 'x-hub-signature-256': metaSign(raw, CREDS.meta.appSecret) } })).status,
    200
  );
  const promo = (await core.templates.list({ channel: 'whatsapp' })).find((t) => t.key === 'promo');
  assert.equal(promo.approvalStatus, 'REJECTED');
  assert.equal(promo.rejectionReason, 'INVALID_FORMAT');
  assert.equal(promo.providerTemplateId, '555');

  raw = metaBody({
    contacts: [{ wa_id: '4915123456789' }],
    messages: [
      { id: 'wamid.IN1', from: '4915123456789', timestamp: '1800000400', type: 'text', text: { body: 'stop' } },
    ],
  });
  assert.equal(
    (await call('meta', { raw, headers: { 'x-hub-signature-256': metaSign(raw, CREDS.meta.appSecret) } })).status,
    200
  );
  assert.equal(await core.contacts.consentStatus(contact.id, 'whatsapp'), 'revoked');
  const c = await core.contacts.getRowById(contact.id);
  assert.equal(Number(c.last_inbound_at), 1800000400 * 1000);
  assert.equal(c.last_inbound_channel, 'whatsapp');
});

test('meta: a handler error answers 500 and releases the event key for the retry', async () => {
  const { core, call, sendVia } = await setup();
  const row = await sendVia('whatsapp');
  const raw = metaBody({ statuses: [{ id: row.provider_message_id, status: 'delivered', timestamp: '1800000100' }] });
  const headers = { 'x-hub-signature-256': metaSign(raw, CREDS.meta.appSecret) };
  const original = core.outbox.applyProviderStatus;
  core.outbox.applyProviderStatus = async () => {
    throw new Error('database unavailable');
  };
  assert.equal((await call('meta', { raw, headers })).status, 500);
  core.outbox.applyProviderStatus = original;
  assert.equal((await call('meta', { raw, headers })).status, 200);
  assert.equal((await core.outbox.getRow(row.document_id)).status, 'delivered');
});

test('telegram: secret token, /start linking, /stop opt-out, update dedupe', async () => {
  const { core, accounts, call, contact } = await setup();
  const secret = accounts.telegram.config.secretToken;
  assert.match(secret, /^[A-Za-z0-9_-]{16,}$/);
  const token = await core.contacts.createLinkToken(contact.id);
  const update = (id, text, type = 'private') =>
    JSON.stringify({
      update_id: id,
      message: {
        message_id: id,
        date: 1800000500,
        chat: { id: 4242, type },
        from: { id: 4242, is_bot: false, first_name: 'Ana' },
        text,
      },
    });
  assert.equal(
    (
      await call('telegram', {
        raw: update(1, `/start ${token}`),
        headers: { 'x-telegram-bot-api-secret-token': 'wrong-secret-value' },
      })
    ).status,
    401
  );
  assert.equal(
    (
      await call('telegram', {
        raw: update(1, `/start ${token}`),
        headers: { 'x-telegram-bot-api-secret-token': secret },
      })
    ).status,
    200
  );
  let row = await core.contacts.getRowById(contact.id);
  assert.equal(core.contacts.chatIdOf(row), '4242');
  assert.equal(await core.contacts.consentStatus(contact.id, 'telegram'), 'granted');
  await call('telegram', { raw: update(2, '/stop'), headers: { 'x-telegram-bot-api-secret-token': secret } });
  assert.equal(await core.contacts.consentStatus(contact.id, 'telegram'), 'revoked');
  await core.contacts.setConsent(contact.id, 'telegram', 'granted', 'test');
  await call('telegram', { raw: update(2, '/stop'), headers: { 'x-telegram-bot-api-secret-token': secret } });
  assert.equal(await core.contacts.consentStatus(contact.id, 'telegram'), 'granted', 'a repeated update_id is ignored');
  await call('telegram', { raw: update(3, '/stop', 'group'), headers: { 'x-telegram-bot-api-secret-token': secret } });
  assert.equal(await core.contacts.consentStatus(contact.id, 'telegram'), 'granted', 'group chats are ignored');
  row = await core.contacts.getRowById(contact.id);
  assert.equal(row.last_inbound_channel, 'telegram');
});

/** seven.io signature headers for a body and URL. */
function sevenHeaders(
  raw,
  url,
  {
    nonce = crypto.randomBytes(16).toString('hex'),
    ts = Math.floor(Date.now() / 1000),
    key = CREDS.seven.signingKey,
  } = {}
) {
  const md5 = crypto.createHash('md5').update(raw).digest('hex');
  const signature = crypto.createHmac('sha256', key).update([ts, nonce, 'POST', url, md5].join('\n')).digest('hex');
  return { 'content-type': 'application/json', 'x-signature': signature, 'x-timestamp': String(ts), 'x-nonce': nonce };
}

test('seven: signed DLR updates the status; replayed nonce and stale timestamp are rejected', async () => {
  const { core, accounts, call, sendVia } = await setup();
  const row = await sendVia('sms');
  assert.match(row.provider_message_id, /^\d+$/);
  const url = `https://cms.example.test/api/magic-messagegate/webhooks/seven/${accounts.seven.path}`;
  const raw = JSON.stringify({
    webhook_event: 'dlr',
    webhook_timestamp: '2027-01-15 10:00:00',
    data: { msg_id: row.provider_message_id, status: 'DELIVERED', timestamp: '2027-01-15 10:00:00' },
  });
  const headers = sevenHeaders(raw, url);
  assert.equal((await call('seven', { raw, headers })).status, 200);
  assert.equal((await core.outbox.getRow(row.document_id)).status, 'delivered');
  assert.equal((await call('seven', { raw, headers })).status, 200, 'replay is acknowledged but ignored');
  const stale = sevenHeaders(raw, url, { ts: Math.floor(Date.now() / 1000) - 120 });
  assert.equal((await call('seven', { raw, headers: stale })).status, 401);
  const wrongKey = sevenHeaders(raw, url, { key: 'other-signing-key' });
  assert.equal((await call('seven', { raw, headers: wrongKey })).status, 401);
});

test('seven: inbound STOP revokes SMS consent', async () => {
  const { core, accounts, call, contact } = await setup();
  const url = `https://cms.example.test/api/magic-messagegate/webhooks/seven/${accounts.seven.path}`;
  const raw = JSON.stringify({
    webhook_event: 'sms_mo',
    data: { id: '991', sender: '4915123456789', system: '4930000000', text: 'STOPP', time: '1800000000' },
  });
  assert.equal((await call('seven', { raw, headers: sevenHeaders(raw, url) })).status, 200);
  assert.equal(await core.contacts.consentStatus(contact.id, 'sms'), 'revoked');
});

/** Twilio X-Twilio-Signature for a form body. */
function twilioRequest(url, params, token = CREDS.twilio.authToken) {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join('');
  const signature = crypto.createHmac('sha1', token).update(data).digest('base64');
  return {
    raw: new URLSearchParams(params).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature },
  };
}

test('twilio: signed status callback and inbound STOP; forged signature rejected', async () => {
  const { core, accounts, call, contact } = await setup();
  await core.accounts.update(accounts.seven.dto.id, { isActive: false });
  const row = await (async () => {
    const res = await core.sender.send({
      to: PHONE,
      channel: 'sms',
      template: 'hello',
      language: 'de',
      variables: { name: 'Ana' },
    });
    await core.outbox.tick();
    return core.outbox.getRow(res.id);
  })();
  assert.match(row.provider_message_id, /^SM/);
  const statusCallback = fake.of('twilio.send')[0].form.StatusCallback;
  assert.equal(
    statusCallback,
    `https://cms.example.test/api/magic-messagegate/webhooks/twilio/${accounts.twilio.path}`
  );
  const url = statusCallback;
  const params = {
    AccountSid: CREDS.twilio.accountSid,
    MessageSid: row.provider_message_id,
    MessageStatus: 'delivered',
    To: PHONE,
  };
  const signed = twilioRequest(url, params);
  assert.equal((await call('twilio', signed)).status, 200);
  assert.equal((await core.outbox.getRow(row.document_id)).status, 'delivered');
  const forged = twilioRequest(url, { ...params, MessageStatus: 'failed' }, 'c'.repeat(32));
  assert.equal((await call('twilio', forged)).status, 401);
  const inbound = twilioRequest(url, {
    AccountSid: CREDS.twilio.accountSid,
    MessageSid: `SM${'e'.repeat(32)}`,
    From: PHONE,
    To: '+15005550006',
    Body: 'STOP',
  });
  assert.equal((await call('twilio', inbound)).status, 200);
  assert.equal(await core.contacts.consentStatus(contact.id, 'sms'), 'revoked');
});

test('webhooks are rate limited per account', async () => {
  const { accounts, call } = await setup({ rateLimits: { webhookPerMinute: 10 } });
  const statuses = [];
  for (let i = 0; i < 11; i += 1) {
    statuses.push(
      (
        await call('meta', {
          method: 'GET',
          query: {
            'hub.mode': 'subscribe',
            'hub.verify_token': accounts.meta.config.verifyToken,
            'hub.challenge': '1',
          },
        })
      ).status
    );
  }
  assert.deepEqual(statuses.slice(-2), [200, 429]);
});
