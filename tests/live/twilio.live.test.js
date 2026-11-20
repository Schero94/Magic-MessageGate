'use strict';

/**
 * Live: Twilio with TEST credentials (free, nothing is delivered) through the
 * whole MessageGate send path (sender → outbox → adapter → api.twilio.com).
 * Magic numbers: https://www.twilio.com/docs/iam/test-credentials
 *   From +15005550006 valid; +15005550001 → 21212; +15005550008 → 21611
 *   To   +15005550001 → 21211; +15005550002 → 21612; +15005550003 → 21408;
 *        +15005550004 → 21610 (unsubscribed); +15005550009 → 21614
 *
 * Opt-in, paid: with LIVE_ALLOW_PAID=1 and LIVE_WEBHOOKS=1 plus the live keys
 * (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, TWILIO_LIVE_TO), one
 * real SMS goes to TWILIO_LIVE_TO (the owner's own phone) with a status
 * callback through a cloudflared tunnel; no Twilio configuration is changed.
 *
 * Run: LIVE_PROVIDERS=twilio npm run test:live (keys: docs/live-tests.md).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadLiveConfig, installLiveFetch, withTunnel, waitFor } = require('../helpers/live-env');

const { env, skipReason, optIn } = loadLiveConfig();
const skip = skipReason('twilio');
if (skip) console.log(`twilio live suite skipped: ${skip}`);

const DOC_RECIPIENT = '+14108675310'; // the recipient in Twilio's own test-credential examples
let live;

/**
 * MessageGate core with one Twilio SMS account.
 *
 * @param {{accountSid: string, authToken: string, from: string}} credentials
 * @param {string} [publicUrl]
 * @returns {Promise<{strapi: object, core: object, account: object}>}
 */
async function setup(credentials, publicUrl = 'https://cms.example.test') {
  const { fakeStrapi } = require('../helpers/strapi');
  const s = await fakeStrapi({ publicUrl });
  const dto = await s.core.accounts.create({
    channel: 'sms',
    provider: 'twilio',
    name: 'Twilio live',
    config: credentials,
  });
  return { strapi: s, core: s.core, account: dto };
}

/**
 * Sends one SMS through the full send path and runs the worker once.
 *
 * @param {object} core
 * @param {string} to
 * @returns {Promise<object>} Outbox row.
 */
async function sendOne(core, to) {
  const { row: contact } = await core.contacts.upsertByPhone(to);
  await core.contacts.setConsent(contact.id, 'sms', 'granted', 'live-test');
  const res = await core.sender.send({ to, channel: 'sms', text: 'MessageGate live test (Twilio test credentials)' });
  await core.outbox.tick();
  return { row: await core.outbox.getRow(res.id), contact };
}

test.before(() => {
  if (skip) return;
  live = installLiveFetch();
});

test.after(async () => {
  if (skip) return;
  live.restore();
  console.log(JSON.stringify({ liveRequests: live.results }, null, 1));
});

const testCreds = () => ({
  accountSid: env.TWILIO_TEST_ACCOUNT_SID,
  authToken: env.TWILIO_TEST_AUTH_TOKEN,
  from: '+15005550006',
});

test('twilio live: a valid send is accepted with a Message SID', { skip }, async () => {
  const { core } = await setup(testCreds());
  const { row } = await sendOne(core, DOC_RECIPIENT);
  assert.equal(row.status, 'sent');
  assert.match(row.provider_message_id, /^SM[0-9a-f]{32}$/);
});

test('twilio live: magic recipients map to the documented error codes', { skip }, async () => {
  const { core } = await setup(testCreds());
  const cases = [
    ['+15005550001', 'TWILIO_21211'],
    ['+15005550002', 'TWILIO_21612'],
    ['+15005550003', 'TWILIO_21408'],
    ['+15005550009', 'TWILIO_21614'],
  ];
  for (const [to, code] of cases) {
    const { row } = await sendOne(core, to);
    assert.equal(row.status, 'failed', to);
    assert.equal(row.error_code, code, to);
  }
});

test('twilio live: 21610 (unsubscribed recipient) revokes SMS consent', { skip }, async () => {
  const { core } = await setup(testCreds());
  const { row, contact } = await sendOne(core, '+15005550004');
  assert.equal(row.error_code, 'TWILIO_21610');
  assert.equal(await core.contacts.consentStatus(contact.id, 'sms'), 'revoked');
});

test('twilio live: sender problems — 21212 flags the account, 21611 is retried', { skip }, async () => {
  const bad = await setup({ ...testCreds(), from: '+15005550001' });
  const { row } = await sendOne(bad.core, DOC_RECIPIENT);
  assert.equal(row.error_code, 'TWILIO_21212');
  const health = await bad.core.accounts.getRow(bad.account.id);
  assert.equal(health.health_status, 'error', 'account marked unhealthy');

  const full = await setup({ ...testCreds(), from: '+15005550008' });
  const queued = await sendOne(full.core, DOC_RECIPIENT);
  assert.equal(queued.row.status, 'queued', 'queue full: retried later');
  assert.equal(queued.row.error_code, 'TWILIO_21611');
});

test('twilio live: wrong auth token is an account problem (20003)', { skip }, async () => {
  const { core } = await setup({ ...testCreds(), authToken: '0'.repeat(32) });
  const { row } = await sendOne(core, DOC_RECIPIENT);
  assert.equal(row.status, 'failed');
  assert.equal(row.error_code, 'TWILIO_20003');
});

test('twilio live: test credentials cannot read the account (documented 403)', { skip }, async () => {
  const twilio = require('../../server/src/adapters/twilio');
  const res = await twilio.testConnection({ config: testCreds() });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'HTTP_403');
});

test('twilio live: Lookup v2 line type with test credentials', { skip }, async () => {
  const twilio = require('../../server/src/adapters/twilio');
  const res = await twilio.lookup({ config: testCreds(), e164: DOC_RECIPIENT });
  assert.equal(res.ok, true, `lookup answered ${res.code}`);
  assert.equal(typeof res.valid, 'boolean');
});

const paidSkip = optIn('twilio', {
  flags: { LIVE_ALLOW_PAID: 'sends one real, billed SMS', LIVE_WEBHOOKS: 'needs a cloudflared tunnel' },
  keys: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM', 'TWILIO_LIVE_TO'],
});

test(
  'twilio live (paid): real SMS with a signed status callback through a tunnel',
  { skip: paidSkip, timeout: 240_000 },
  async () => {
    await withTunnel(async ({ url, hits, use }) => {
      const credentials = {
        accountSid: env.TWILIO_ACCOUNT_SID,
        authToken: env.TWILIO_AUTH_TOKEN,
        from: env.TWILIO_FROM,
      };
      const { strapi, core } = await setup(credentials, url);
      use(strapi);
      const { row } = await sendOne(core, env.TWILIO_LIVE_TO);
      assert.equal(row.status, 'sent');
      const final = await waitFor(async () => {
        const current = await core.outbox.getRow(row.document_id);
        return ['delivered', 'failed'].includes(current.status) ? current : null;
      }, 180_000);
      console.log(JSON.stringify({ twilioPaid: { finalStatus: final?.status || null, callbacks: hits } }, null, 1));
      assert.ok(
        hits.some((h) => h.provider === 'twilio' && h.status === 200),
        'a signed status callback was accepted'
      );
      assert.ok(final, 'a final status arrived by webhook');
    });
  }
);
