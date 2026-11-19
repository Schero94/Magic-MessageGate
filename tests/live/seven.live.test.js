'use strict';

/**
 * Live: seven.io. seven.io has no sandbox or debug switch for SMS (checked
 * 2026-11-20, docs.seven.io/en/rest-api/endpoints/sms), so only free calls
 * run by default: the balance check and a refused key.
 *
 * Opt-in, paid (LIVE_ALLOW_PAID=1, SEVEN_LIVE_TO = the owner's own phone):
 * one HLR check (0.01 EUR) and one SMS through the full send path.
 * With LIVE_WEBHOOKS=1 and SEVEN_SIGNING_KEY as well, two webhooks for
 * `dlr` are created on the account (request method JSON, and the default
 * form POST to record its shape), pointed at a cloudflared tunnel, and
 * deleted again afterwards; existing webhooks are not touched.
 *
 * Run: LIVE_PROVIDERS=seven npm run test:live (keys: docs/live-tests.md).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadLiveConfig, installLiveFetch, withTunnel, waitFor } = require('../helpers/live-env');

const { env, skipReason, optIn } = loadLiveConfig();
const skip = skipReason('seven');
if (skip) console.log(`seven live suite skipped: ${skip}`);
const seven = require('../../server/src/adapters/seven');

let live;
test.before(() => {
  if (!skip) live = installLiveFetch();
});
test.after(() => {
  if (skip) return;
  live.restore();
  console.log(JSON.stringify({ liveRequests: live.results }, null, 1));
});

/**
 * @param {string} [publicUrl]
 * @returns {Promise<{strapi: object, core: object, account: object}>}
 */
async function setup(publicUrl = 'https://cms.example.test') {
  const { fakeStrapi } = require('../helpers/strapi');
  const strapi = await fakeStrapi({ publicUrl });
  const config = { apiKey: env.SEVEN_API_KEY, signingKey: env.SEVEN_SIGNING_KEY || 'unused-signing-key' };
  if (env.SEVEN_SENDER) config.senderId = env.SEVEN_SENDER;
  const account = await strapi.core.accounts.create({ channel: 'sms', provider: 'seven', name: 'seven live', config });
  return { strapi, core: strapi.core, account };
}

test('seven live: the API key reads the balance', { skip }, async () => {
  const res = await seven.testConnection({ config: { apiKey: env.SEVEN_API_KEY } });
  assert.equal(res.ok, true, `balance check answered ${res.code}`);
  assert.equal(typeof res.info.balance, 'number');
});

test('seven live: a wrong key is refused as an account problem', { skip }, async () => {
  const conn = await seven.testConnection({ config: { apiKey: 'wrong-key-for-live-test' } });
  assert.equal(conn.ok, false);
  const res = await seven.send({
    config: { apiKey: 'wrong-key-for-live-test' },
    to: '+4915123456789',
    payload: { text: 'never sent' },
  });
  console.log(JSON.stringify({ sevenWrongKey: { connection: conn.code, send: res.code, outcome: res.outcome } }));
  assert.notEqual(res.outcome, 'accepted');
  assert.equal(res.accountProblem || res.code === 'HTTP_401', true, 'auth failure flags the account');
});

const paidSkip = optIn('seven', {
  flags: { LIVE_ALLOW_PAID: 'HLR 0.01 EUR plus one SMS' },
  keys: ['SEVEN_LIVE_TO'],
});

test('seven live (paid): HLR check and one SMS through the full send path', { skip: paidSkip }, async () => {
  const hlr = await seven.hlr({ config: { apiKey: env.SEVEN_API_KEY }, e164: env.SEVEN_LIVE_TO });
  assert.equal(hlr.ok, true, `HLR answered ${hlr.code}`);
  assert.ok(['valid', 'not_valid', 'unknown'].includes(hlr.valid));

  const { core } = await setup();
  const { row: contact } = await core.contacts.upsertByPhone(env.SEVEN_LIVE_TO);
  await core.contacts.setConsent(contact.id, 'sms', 'granted', 'live-test');
  const res = await core.sender.send({
    to: env.SEVEN_LIVE_TO,
    channel: 'sms',
    text: 'MessageGate live test (seven.io)',
  });
  await core.outbox.tick();
  const row = await core.outbox.getRow(res.id);
  assert.equal(row.status, 'sent', `send ended with ${row.error_code}`);
  assert.match(row.provider_message_id, /^\d+$/);
});

const hookSkip = optIn('seven', {
  flags: { LIVE_ALLOW_PAID: 'one SMS', LIVE_WEBHOOKS: 'cloudflared tunnel' },
  keys: ['SEVEN_LIVE_TO', 'SEVEN_SIGNING_KEY'],
});

/**
 * seven.io hooks API (official OpenAPI: POST/DELETE /hooks, form fields).
 *
 * @param {'POST'|'DELETE'|'GET'} method
 * @param {Record<string,string>} [fields]
 * @returns {Promise<any>}
 */
async function hooksApi(method, fields) {
  const res = await fetch('https://gateway.seven.io/api/hooks', {
    method,
    headers: {
      'x-api-key': env.SEVEN_API_KEY,
      accept: 'application/json',
      ...(fields ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: fields ? new URLSearchParams(fields).toString() : undefined,
  });
  return res.json().catch(() => null);
}

test(
  'seven live (paid): signed delivery reports through a tunnel, JSON and form hooks',
  { skip: hookSkip, timeout: 300_000 },
  async () => {
    await withTunnel(async ({ url, hits, use }) => {
      const { strapi, core, account } = await setup(url);
      use(strapi);
      const created = [];
      try {
        const before = await hooksApi('GET');
        for (const [method, suffix] of [
          ['JSON', ''],
          ['POST', '?shape=form'],
        ]) {
          const answer = await hooksApi('POST', {
            target_url: `${account.webhookUrl}${suffix}`,
            event_type: 'dlr',
            request_method: method,
          });
          assert.equal(answer?.success, true, `hook ${method} created`);
          created.push(answer.id);
        }
        const { row: contact } = await core.contacts.upsertByPhone(env.SEVEN_LIVE_TO);
        await core.contacts.setConsent(contact.id, 'sms', 'granted', 'live-test');
        const res = await core.sender.send({
          to: env.SEVEN_LIVE_TO,
          channel: 'sms',
          text: 'MessageGate live webhook test',
        });
        await core.outbox.tick();
        const final = await waitFor(async () => {
          const current = await core.outbox.getRow(res.id);
          return current.status === 'delivered' || current.status === 'failed' ? current : null;
        }, 240_000);
        console.log(
          JSON.stringify(
            {
              sevenHooks: {
                existingHooks: Array.isArray(before?.hooks)
                  ? before.hooks.length
                  : Array.isArray(before?.data)
                    ? before.data.length
                    : null,
                hits,
                final: final?.status,
              },
            },
            null,
            1
          )
        );
        assert.ok(
          hits.some((h) => h.contentType === 'application/json' && h.status === 200),
          'JSON hook verified'
        );
        assert.ok(final, 'a final DLR arrived');
      } finally {
        for (const id of created) await hooksApi('DELETE', { id: String(id) });
      }
    });
  }
);
