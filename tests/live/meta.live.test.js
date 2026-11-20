'use strict';

/**
 * Live: WhatsApp Cloud API with a Meta test number (App Dashboard →
 * WhatsApp → API Setup) to a recipient on its allowed list
 * (META_TEST_RECIPIENT, the owner's own phone). Template sends use
 * META_TEMPLATE (default hello_world, en_US), which Meta creates on new
 * WhatsApp Business Accounts.
 *
 * Opt-in webhooks (LIVE_WEBHOOKS=1 and META_APP_SECRET): the phone number's
 * webhook override (POST /{phone-number-id} webhook_configuration, documented
 * at developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/override)
 * is pointed at a cloudflared tunnel and removed afterwards. The test refuses
 * to run when the number already has an override, because its verify token
 * cannot be read back to restore it. The app's own callback URL is never changed.
 *
 * Run: LIVE_PROVIDERS=meta npm run test:live (keys: docs/live-tests.md).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadLiveConfig, installLiveFetch, withTunnel, waitFor } = require('../helpers/live-env');

const { env, skipReason, optIn } = loadLiveConfig();
const skip = skipReason('meta');
if (skip) console.log(`meta live suite skipped: ${skip}`);
const meta = require('../../server/src/adapters/meta');

const TEMPLATE = env.META_TEMPLATE || 'hello_world';
const LANGUAGE = env.META_TEMPLATE_LANGUAGE || 'en_US';
const MEDIA_HOSTS = [/(^|\.)fbsbx\.com$/, /(^|\.)fbcdn\.net$/, /(^|\.)whatsapp\.net$/];
const config = () => ({
  accessToken: env.META_ACCESS_TOKEN,
  phoneNumberId: env.META_PHONE_NUMBER_ID,
  wabaId: env.META_WABA_ID,
  appSecret: env.META_APP_SECRET || 'unused-app-secret',
});

let live;
test.before(() => {
  if (!skip) live = installLiveFetch({ extraHosts: MEDIA_HOSTS });
});
test.after(() => {
  if (skip) return;
  live.restore();
  console.log(JSON.stringify({ liveRequests: live.results }, null, 1));
});

/**
 * Core with the live WhatsApp account and the approved test template.
 *
 * @param {string} [publicUrl]
 * @returns {Promise<{strapi: object, core: object, account: object}>}
 */
async function setup(publicUrl = 'https://cms.example.test') {
  const { fakeStrapi } = require('../helpers/strapi');
  const strapi = await fakeStrapi({ publicUrl });
  const core = strapi.core;
  const account = await core.accounts.create({
    channel: 'whatsapp',
    provider: 'meta',
    name: 'Meta live',
    config: config(),
  });
  await core.templates.create({
    key: TEMPLATE,
    channel: 'whatsapp',
    language: LANGUAGE,
    name: 'Live test template',
    content: { body: 'Hello World' },
  });
  await core.templates.applyProviderStatus({ name: TEMPLATE, language: LANGUAGE, status: 'APPROVED' });
  const { row: contact } = await core.contacts.upsertByPhone(env.META_TEST_RECIPIENT);
  await core.contacts.setConsent(contact.id, 'whatsapp', 'granted', 'live-test');
  return { strapi, core, account };
}

test('meta live: the token reads the phone number', { skip }, async () => {
  const res = await meta.testConnection({ config: config() });
  assert.equal(res.ok, true, `phone number check answered ${res.code}`);
  assert.equal(typeof res.info.displayPhoneNumber, 'string');
});

test('meta live: the template list contains the test template, approved', { skip }, async () => {
  const items = await meta.listTemplates({ config: config() });
  const found = items.find((t) => t.name === TEMPLATE && t.language === LANGUAGE);
  assert.ok(found, `${TEMPLATE} (${LANGUAGE}) exists`);
  assert.equal(found.status, 'APPROVED');
  for (const item of items) assert.ok(meta.TEMPLATE_STATUSES.includes(item.status));
});

test('meta live: a template send through the full send path returns a wamid', { skip }, async () => {
  const { core } = await setup();
  const res = await core.sender.send({
    to: env.META_TEST_RECIPIENT,
    channel: 'whatsapp',
    template: TEMPLATE,
    language: LANGUAGE,
  });
  await core.outbox.tick();
  const row = await core.outbox.getRow(res.id);
  assert.equal(row.status, 'sent', `send ended with ${row.error_code}`);
  assert.match(row.provider_message_id, /^wamid\./);
});

test('meta live: free text is accepted inside the 24-hour window, 131047 outside', { skip }, async () => {
  const res = await meta.send({
    config: config(),
    to: env.META_TEST_RECIPIENT,
    payload: { kind: 'text', text: 'MessageGate live test' },
  });
  console.log(JSON.stringify({ metaFreeText: { outcome: res.outcome, code: res.code } }));
  assert.ok(res.outcome === 'accepted' || res.code === 'META_131047', `unexpected ${res.outcome} ${res.code}`);
});

test('meta live: a malformed recipient and a wrong token are refused', { skip }, async () => {
  const bad = await meta.send({ config: config(), to: '0', payload: { kind: 'text', text: 'never sent' } });
  assert.equal(bad.outcome, 'rejected', `malformed recipient: ${bad.code}`);
  const token = await meta.send({
    config: { ...config(), accessToken: 'EAAwrong-token-for-live-test' },
    to: env.META_TEST_RECIPIENT,
    payload: { kind: 'text', text: 'never sent' },
  });
  assert.equal(token.outcome, 'rejected');
  assert.equal(token.code, 'META_190');
  assert.equal(token.accountProblem, true);
  console.log(JSON.stringify({ metaRefused: { malformed: bad.code, token: token.code } }));
});

const hookSkip = optIn('meta', {
  flags: { LIVE_WEBHOOKS: 'cloudflared tunnel and a webhook override on the test number' },
  keys: ['META_APP_SECRET'],
});

/**
 * Graph call with the live token.
 *
 * @param {'GET'|'POST'} method
 * @param {string} path
 * @param {object} [body]
 * @returns {Promise<any>}
 */
async function graph(method, path, body) {
  const res = await fetch(`https://graph.facebook.com/v23.0/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.META_ACCESS_TOKEN}`,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test(
  'meta live: signed status webhooks through a tunnel (number-level override)',
  { skip: hookSkip, timeout: 300_000 },
  async (t) => {
    const current = await graph('GET', `${env.META_PHONE_NUMBER_ID}?fields=webhook_configuration`);
    if (current.json?.webhook_configuration?.phone_number) {
      t.skip('the number already has a webhook override; its verify token cannot be restored');
      return;
    }
    await withTunnel(async ({ url, hits, use }) => {
      const { strapi, core, account } = await setup(url);
      use(strapi);
      const row = await core.accounts.getRow(account.id);
      const verifyToken = core.accounts.configOf(row).verifyToken;
      try {
        const set = await graph('POST', env.META_PHONE_NUMBER_ID, {
          webhook_configuration: { override_callback_uri: account.webhookUrl, verify_token: verifyToken },
        });
        assert.equal(set.status, 200, `override set (${set.json?.error?.code || 'ok'})`);
        const res = await core.sender.send({
          to: env.META_TEST_RECIPIENT,
          channel: 'whatsapp',
          template: TEMPLATE,
          language: LANGUAGE,
        });
        await core.outbox.tick();
        const final = await waitFor(async () => {
          const message = await core.outbox.getRow(res.id);
          return ['delivered', 'read', 'failed'].includes(message.status) ? message : null;
        }, 240_000);
        console.log(JSON.stringify({ metaWebhook: { hits, final: final?.status || null } }, null, 1));
        assert.ok(
          hits.some((h) => h.method === 'GET' && h.status === 200),
          'Meta verified the callback (hub.challenge)'
        );
        assert.ok(
          hits.some((h) => h.method === 'POST' && h.status === 200),
          'a signed status webhook was accepted'
        );
        assert.ok(final, 'delivered or read arrived by webhook');
      } finally {
        await graph('POST', env.META_PHONE_NUMBER_ID, { webhook_configuration: { override_callback_uri: '' } });
      }
    });
  }
);
