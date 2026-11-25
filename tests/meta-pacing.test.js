'use strict';

/**
 * Issue #18: Meta answers 200 with `messages[].message_status`
 * `held_for_quality_assessment` or `paused` when a template is paced. Such a
 * message is neither sent nor failed: it is `held`, with a reason code, and
 * the later status webhook (sent / delivered / read / failed 132015) decides.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { startFakeProviders } = require('./helpers/fake-providers');
const { scenario } = require('./helpers/scenario');
const { PHONE, CREDS } = require('./helpers/core');
const { signMeta } = require('../server/src/utils/signatures');
const { EVENT_MAP } = require('../server/src/core/hooks-out');
const { SANDBOX_NUMBERS } = require('../server/src/testing/numbers');
const { makeCore, addAccount } = require('./helpers/core');

let fake;
test.before(async () => {
  fake = await startFakeProviders();
});
test.after(() => fake.close());
test.beforeEach(() => fake.reset());

/**
 * Queues a send answer like the one in issue #18 (synthetic wamid).
 *
 * @param {string} status - message_status
 * @param {string} id - wamid
 */
const queueSend = (status, id) =>
  fake.queue('meta.send', {
    status: 200,
    json: {
      messaging_product: 'whatsapp',
      contacts: [{ input: PHONE.slice(1), wa_id: PHONE.slice(1) }],
      messages: [{ id, message_status: status }],
    },
  });

/**
 * Posts a signed Meta status webhook.
 *
 * @param {object} core
 * @param {object} status - Statuses item.
 * @returns {Promise<{status: number}>}
 */
async function statusHook(core, status) {
  const [account] = await core.accounts.forChannel('whatsapp');
  const body = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: CREDS.meta.wabaId,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: CREDS.meta.phoneNumberId },
              statuses: [{ recipient_id: PHONE.slice(1), timestamp: '1800000100', ...status }],
            },
          },
        ],
      },
    ],
  };
  const rawBody = Buffer.from(JSON.stringify(body));
  return core.webhooks.meta(account, {
    headers: { 'x-hub-signature-256': signMeta(rawBody, CREDS.meta.appSecret) },
    rawBody,
    body,
  });
}

/**
 * @param {object} core
 * @param {object} [extra]
 * @returns {Promise<object>} Message detail after one worker round.
 */
async function sendTemplate(core, extra = {}) {
  const res = await core.sender.send({
    to: PHONE,
    channel: 'whatsapp',
    template: 'order_shipped',
    language: 'de',
    variables: core.vars,
    ...extra,
  });
  await core.drain();
  return core.outbox.detail(res.id);
}

const types = (detail) => detail.timeline.map((e) => e.type);

test('held_for_quality_assessment: status held with a reason, not sent, not failed', async () => {
  const core = await scenario(fake);
  queueSend('held_for_quality_assessment', 'wamid.SYNTHETIC1');
  const m = await sendTemplate(core);
  assert.equal(m.status, 'held');
  assert.equal(m.errorCode, 'META_HELD_FOR_QUALITY_ASSESSMENT');
  assert.equal(m.providerMessageId, 'wamid.SYNTHETIC1');
  assert.equal(m.sentAt, null, 'not reported as sent');
  assert.equal(m.failedAt, null, 'not reported as failed');
  assert.equal(m.hasPayload, true, 'the content stays for a fallback if Meta drops it');
  assert.deepEqual(types(m), ['queued', 'held']);
  assert.equal(m.timeline[1].code, 'META_HELD_FOR_QUALITY_ASSESSMENT');
  const held = core.events.find((e) => e.name === 'messagegate.message.held');
  assert.deepEqual(
    { status: held.payload.status, code: held.payload.code, messageId: held.payload.messageId },
    { status: 'held', code: 'META_HELD_FOR_QUALITY_ASSESSMENT', messageId: m.id }
  );
  assert.ok(!core.events.some((e) => e.name === 'messagegate.message.sent'));
  assert.equal(fake.count('seven.send'), 0, 'no fallback while Meta decides');

  // Analytics: not counted as sent; waiting in the queue figure.
  const summary = await core.analytics.summary({ from: 0, to: core.clock.t + 1 });
  assert.equal(summary.totals.sent, 0);
  assert.equal(summary.queue.held, 1);
  // Admin filter.
  const list = await core.outbox.list({ status: 'held' });
  assert.deepEqual(
    list.results.map((r) => r.id),
    [m.id]
  );
  // Nothing an admin could do safely while Meta holds it.
  await assert.rejects(core.outbox.retry(m.id, { confirmDuplicateRisk: true }), { code: 'STATE_CHANGED' });
  await assert.rejects(core.outbox.markSent(m.id), { code: 'STATE_CHANGED' });
  await assert.rejects(core.outbox.discard(m.id), { code: 'STATE_CHANGED' });
});

test('released by Meta: the status webhook moves held to sent, delivered and read', async () => {
  const core = await scenario(fake);
  queueSend('held_for_quality_assessment', 'wamid.SYNTHETIC2');
  const m = await sendTemplate(core);
  assert.equal((await statusHook(core, { id: 'wamid.SYNTHETIC2', status: 'sent' })).status, 200);
  let d = await core.outbox.detail(m.id);
  assert.equal(d.status, 'sent');
  assert.equal(d.errorCode, null, 'the hold code is cleared once Meta releases the message');
  assert.equal(d.sentAt, 1800000100 * 1000);
  assert.deepEqual(types(d), ['queued', 'held', 'released', 'sent']);
  assert.equal(d.timeline[2].code, 'META_HELD_FOR_QUALITY_ASSESSMENT');
  await statusHook(core, { id: 'wamid.SYNTHETIC2', status: 'delivered', timestamp: '1800000200' });
  await statusHook(core, { id: 'wamid.SYNTHETIC2', status: 'read', timestamp: '1800000300' });
  d = await core.outbox.detail(m.id);
  assert.equal(d.status, 'read');
  assert.deepEqual(types(d), ['queued', 'held', 'released', 'sent', 'delivered', 'read']);
});

test('a late delivered without sent also releases the message', async () => {
  const core = await scenario(fake);
  queueSend('paused', 'wamid.SYNTHETIC3');
  const m = await sendTemplate(core);
  assert.equal(m.status, 'held');
  assert.equal(m.errorCode, 'META_PAUSED');
  await statusHook(core, { id: 'wamid.SYNTHETIC3', status: 'delivered' });
  const d = await core.outbox.detail(m.id);
  assert.equal(d.status, 'delivered');
  assert.equal(d.errorCode, null);
  assert.ok(d.sentAt && d.deliveredAt);
  assert.deepEqual(types(d), ['queued', 'held', 'released', 'delivered']);
});

test('dropped by Meta (failed 132015): failed with the documented code, then the fallback chain runs', async () => {
  const core = await scenario(fake);
  queueSend('held_for_quality_assessment', 'wamid.SYNTHETIC4');
  const m = await sendTemplate(core, { channel: 'auto' });
  assert.equal(m.status, 'held');
  assert.equal(fake.count('seven.send'), 0);
  await statusHook(core, {
    id: 'wamid.SYNTHETIC4',
    status: 'failed',
    errors: [{ code: 132015, title: 'Template is paused' }],
  });
  const d = await core.outbox.detail(m.id);
  assert.equal(d.status, 'failed');
  assert.equal(d.errorCode, 'META_132015');
  assert.deepEqual(types(d), ['queued', 'held', 'failed']);
  assert.equal(d.fallbacks.length, 1, 'SMS fallback queued');
  assert.equal(d.fallbacks[0].channel, 'sms');
  await core.drain();
  assert.equal(fake.count('seven.send'), 1);
  // A repeated webhook (Meta retries) changes nothing.
  await statusHook(core, { id: 'wamid.SYNTHETIC4', status: 'failed', errors: [{ code: 132015 }] });
  assert.equal((await core.outbox.detail(m.id)).fallbacks.length, 1);
});

test('accepted (and a missing message_status) stay a normal send', async () => {
  const core = await scenario(fake);
  queueSend('accepted', 'wamid.SYNTHETIC5');
  let m = await sendTemplate(core);
  assert.equal(m.status, 'sent');
  assert.equal(m.errorCode, null);
  m = await sendTemplate(core, { idempotencyKey: 'second' });
  assert.equal(m.status, 'sent');
  assert.ok(!core.events.some((e) => e.name === 'messagegate.message.held'));
});

test('the held event reaches the outgoing webhook as message.status', () => {
  assert.equal(EVENT_MAP['messagegate.message.held'], 'message.status');
});

test('sandbox: the held test number ends held on WhatsApp', async () => {
  const core = await makeCore({ config: { providers: { mode: 'sandbox' } } });
  await addAccount(core, 'meta');
  await core.templates.create({
    key: 'promo',
    channel: 'whatsapp',
    language: 'de',
    name: 'Promo',
    content: { body: 'Hallo' },
  });
  await core.templates.applyProviderStatus({ name: 'promo', language: 'de', status: 'APPROVED' });
  const { row } = await core.contacts.upsertByPhone(SANDBOX_NUMBERS.held);
  await core.contacts.setConsent(row.id, 'whatsapp', 'granted', 'test');
  const res = await core.sender.send({ to: SANDBOX_NUMBERS.held, channel: 'whatsapp', template: 'promo' });
  await core.outbox.tick();
  const m = await core.outbox.detail(res.id);
  assert.equal(m.status, 'held');
  assert.equal(m.errorCode, 'META_HELD_FOR_QUALITY_ASSESSMENT');
});
