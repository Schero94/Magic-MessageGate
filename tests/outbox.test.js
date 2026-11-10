'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startFakeProviders } = require('./helpers/fake-providers');
const { scenario } = require('./helpers/scenario');
const { PHONE } = require('./helpers/core');

let fake;
test.before(async () => {
  fake = await startFakeProviders();
});
test.after(() => fake.close());
test.beforeEach(() => fake.reset());

const send = (core, extra = {}) =>
  core.sender.send({ to: PHONE, template: 'order_shipped', language: 'de', variables: core.vars, ...extra });

test('send → queued → sent, with timeline, events and no PII in events', async () => {
  const core = await scenario(fake);
  const queued = await send(core, { idempotencyKey: 'order-A-1' });
  assert.equal(queued.status, 'queued');
  assert.equal(queued.channel, 'whatsapp');
  assert.deepEqual(await core.drain(), ['sent']);
  const detail = await core.outbox.detail(queued.id);
  assert.equal(detail.status, 'sent');
  assert.match(detail.providerMessageId, /^wamid\./);
  assert.deepEqual(
    detail.timeline.map((e) => e.type),
    ['queued', 'sent']
  );
  const body = fake.of('meta.send')[0].json;
  assert.equal(body.to, PHONE);
  assert.deepEqual(body.template.components[0].parameters, [
    { type: 'text', parameter_name: 'name', text: 'Ana' },
    { type: 'text', parameter_name: 'order', text: 'A-1' },
  ]);
  const names = core.events.map((e) => e.name);
  assert.ok(names.includes('messagegate.message.queued') && names.includes('messagegate.message.sent'));
  assert.ok(!JSON.stringify(core.events).includes('4915123456789'), 'events must not contain the phone number');
  assert.ok(!JSON.stringify(detail).includes('4915123456789'), 'the admin DTO must not contain the phone number');
});

test('idempotency key returns the first message and sends once', async () => {
  const core = await scenario(fake);
  const a = await send(core, { idempotencyKey: 'k1' });
  const b = await send(core, { idempotencyKey: 'k1' });
  assert.equal(b.id, a.id);
  assert.equal(b.duplicate, true);
  await core.drain();
  const c = await send(core, { idempotencyKey: 'k1' });
  assert.equal(c.id, a.id);
  assert.equal(c.status, 'sent');
  assert.equal(fake.count('meta.send'), 1);
  const other = await core.sender.send(
    { to: PHONE, template: 'order_shipped', language: 'de', variables: core.vars, idempotencyKey: 'k1' },
    { keyScope: 'other-token' }
  );
  assert.notEqual(other.id, a.id, 'keys are scoped per caller');
});

test('transient errors back off 1/5/15 minutes, then fail (no chain → no fallback)', async () => {
  const core = await scenario(fake);
  for (let i = 0; i < 4; i += 1)
    fake.queue('meta.send', { status: 429, json: { error: { code: 130429, message: 'rate' } } });
  const { id } = await send(core, { channel: 'whatsapp' });
  assert.deepEqual(await core.drain(), ['queued']);
  let row = await core.outbox.getRow(id);
  assert.equal(Number(row.next_attempt_at) - core.clock.t, 60_000);
  assert.deepEqual(await core.drain(), [], 'not due yet');
  for (const wait of [60_000, 300_000, 900_000]) {
    core.advance(wait);
    await core.drain();
  }
  row = await core.outbox.getRow(id);
  assert.equal(row.status, 'failed');
  assert.equal(row.error_code, 'META_130429');
  assert.equal(Number(row.attempts), 4);
  assert.equal(fake.count('meta.send'), 4);
  assert.equal(JSON.parse(row.error_history).length, 4);
});

test('ambiguous result → uncertain, never re-sent automatically; admin retry needs confirmation', async () => {
  const core = await scenario(fake);
  fake.queue('meta.send', { status: 500, json: { error: { code: 131000, message: 'unknown' } } });
  const { id } = await send(core, { channel: 'whatsapp' });
  assert.deepEqual(await core.drain(), ['uncertain']);
  core.advance(3_600_000);
  await core.outbox.maintain();
  await core.drain();
  assert.equal(fake.count('meta.send'), 1, 'uncertain must not be retried by the worker');
  await assert.rejects(core.outbox.retry(id), { code: 'CONFIRMATION_REQUIRED' });
  const retried = await core.outbox.retry(id, { confirmDuplicateRisk: true });
  assert.equal(retried.status, 'queued');
  assert.deepEqual(await core.drain(), ['sent']);
  const detail = await core.outbox.detail(id);
  assert.deepEqual(
    detail.timeline.map((e) => e.type),
    ['queued', 'uncertain', 'retry-requested', 'sent']
  );
});

test('uncertain can be resolved as sent or discarded by an admin', async () => {
  const core = await scenario(fake);
  fake.queue('meta.send', { hang: true });
  fake.queue('meta.send', { status: 502, json: {} });
  const a = await send(core, { channel: 'whatsapp' });
  const b = await send(core, { channel: 'whatsapp' });
  await core.drain();
  assert.equal((await core.outbox.getRow(a.id)).error_code, 'TIMEOUT');
  assert.equal((await core.outbox.markSent(a.id)).status, 'sent');
  const discarded = await core.outbox.discard(b.id);
  assert.equal(discarded.status, 'discarded');
  assert.equal(discarded.hasPayload, false);
  await assert.rejects(core.outbox.discard(b.id), { code: 'STATE_CHANGED' });
});

test('131026 marks the number as not on WhatsApp and falls back to SMS once', async () => {
  const core = await scenario(fake);
  fake.queue('meta.send', { status: 400, json: { error: { code: 131026, message: 'Message undeliverable' } } });
  const first = await send(core, { idempotencyKey: 'fb-1' });
  assert.equal(first.channel, 'whatsapp');
  await core.drain();
  const wa = await core.outbox.detail(first.id);
  assert.equal(wa.status, 'failed');
  assert.equal(wa.errorCode, 'META_131026');
  assert.equal(wa.fallbacks.length, 1);
  assert.equal(wa.fallbacks[0].channel, 'sms');
  assert.equal(wa.fallbacks[0].status, 'sent');
  assert.equal(fake.count('seven.send'), 1);
  assert.equal(fake.of('seven.send')[0].form.text, 'Hallo Ana, Bestellung A-1 ist unterwegs.');
  const contact = await core.contacts.getRowById(core.contact.id);
  assert.equal(contact.wa_reachability, 'unreachable');
  assert.ok(core.events.some((e) => e.name === 'messagegate.message.fallback'));

  const next = await send(core);
  assert.equal(next.channel, 'sms', 'the next auto send skips WhatsApp for this contact');
});

test('a successful WhatsApp delivery marks the contact reachable again', async () => {
  const core = await scenario(fake);
  await core.contacts.setWhatsappReachability(core.contact.id, 'unreachable');
  const { id } = await send(core, { channel: 'sms' });
  await core.drain();
  assert.equal((await core.outbox.getRow(id)).channel, 'sms');
  await core.contacts.setWhatsappReachability(core.contact.id, 'unknown');
  const wa = await send(core, { channel: 'whatsapp' });
  await core.drain();
  const row = await core.outbox.getRow(wa.id);
  await core.outbox.applyProviderStatus({ providerMessageId: row.provider_message_id, status: 'delivered' });
  assert.equal((await core.contacts.getRowById(core.contact.id)).wa_reachability, 'ok');
});

test('provider statuses move forward only; delivered purges the payload', async () => {
  const core = await scenario(fake);
  const { id } = await send(core, { channel: 'whatsapp' });
  await core.drain();
  const pid = (await core.outbox.getRow(id)).provider_message_id;
  const t0 = core.clock.t;
  await core.outbox.applyProviderStatus({ providerMessageId: pid, status: 'read', at: t0 + 2000 });
  await core.outbox.applyProviderStatus({ providerMessageId: pid, status: 'delivered', at: t0 + 1000 });
  await core.outbox.applyProviderStatus({ providerMessageId: pid, status: 'failed', code: 'META_131047' });
  const detail = await core.outbox.detail(id);
  assert.equal(detail.status, 'read');
  assert.equal(detail.readAt, t0 + 2000);
  assert.equal(detail.deliveredAt, t0 + 2000);
  assert.equal(detail.hasPayload, false);
  assert.deepEqual(
    detail.timeline.map((e) => e.type),
    ['queued', 'sent', 'read']
  );
  const contact = await core.contacts.getRowById(core.contact.id);
  assert.equal(Number(contact.last_read_at), t0 + 2000);
  assert.equal(await core.outbox.applyProviderStatus({ providerMessageId: 'wamid.unknown', status: 'read' }), null);
});

test('failed after sent is accepted and triggers the fallback', async () => {
  const core = await scenario(fake);
  const { id } = await send(core);
  await core.drain();
  const pid = (await core.outbox.getRow(id)).provider_message_id;
  await core.outbox.applyProviderStatus({ providerMessageId: pid, status: 'failed', code: 'META_131049' });
  await core.drain();
  const detail = await core.outbox.detail(id);
  assert.equal(detail.status, 'failed');
  assert.equal(detail.fallbacks[0]?.status, 'sent');
});

test('deadline: overdue messages expire and are never sent', async () => {
  const core = await scenario(fake);
  fake.queue('meta.send', { status: 503, json: {} });
  const { id } = await send(core, { channel: 'whatsapp', notAfter: core.clock.t + 120_000 });
  await core.drain();
  core.advance(121_000);
  const result = await core.outbox.maintain();
  assert.equal(result.expired, 1);
  const row = await core.outbox.getRow(id);
  assert.equal(row.status, 'expired');
  await assert.rejects(core.outbox.retry(id), { code: 'DEADLINE_PASSED' }, 'a fixed deadline cannot be extended');
  assert.equal(fake.count('meta.send'), 1);
  await assert.rejects(send(core, { notAfter: core.clock.t - 1 }), { code: 'DEADLINE_PASSED' });
});

test('an expired message without a fixed deadline can be retried by an admin', async () => {
  const core = await scenario(fake, { config: { defaultNotAfterHours: 1 } });
  const { id } = await send(core, { channel: 'whatsapp' });
  core.advance(3_600_001);
  await core.outbox.maintain();
  assert.equal((await core.outbox.getRow(id)).status, 'expired');
  assert.equal((await core.outbox.retry(id)).status, 'queued');
  assert.deepEqual(await core.drain(), ['sent']);
});

test('retry backoff that would pass the deadline fails instead of waiting', async () => {
  const core = await scenario(fake);
  fake.queue('meta.send', { status: 503, json: {} });
  const { id } = await send(core, { channel: 'whatsapp', notAfter: core.clock.t + 30_000 });
  await core.drain();
  assert.equal((await core.outbox.getRow(id)).status, 'failed');
});

test('lease recovery: expired claims are released; a lost lease cannot write', async () => {
  const core = await scenario(fake);
  const { id } = await send(core, { channel: 'whatsapp' });
  const [claimed] = await core.outbox.claim(10);
  assert.equal(claimed.document_id, id);
  core.advance(core.ctx.config.worker.leaseMs + 1);
  const m = await core.outbox.maintain();
  assert.equal(m.released, 1);
  assert.deepEqual(await core.drain(), ['sent']);
  assert.equal(await core.outbox.dispatch(claimed), 'lost', 'the old lease holder must not send');
  assert.equal(fake.count('meta.send'), 1);
});

test('a process that died during dispatch leaves the message uncertain (never resent)', async () => {
  const core = await scenario(fake);
  const { id } = await send(core, { channel: 'whatsapp' });
  const [claimed] = await core.outbox.claim(1);
  await core.knex('mg_messages').where({ id: claimed.id }).update({ phase: 'dispatching' });
  core.advance(core.ctx.config.worker.leaseMs + 1);
  const m = await core.outbox.maintain();
  assert.equal(m.uncertain, 1);
  const row = await core.outbox.getRow(id);
  assert.equal(row.status, 'uncertain');
  assert.equal(row.error_code, 'LEASE_EXPIRED_DURING_SEND');
  await core.drain();
  assert.equal(fake.count('meta.send'), 0);
});

test('maintenance and retention run under a DB lease (one process per interval)', async () => {
  const core = await scenario(fake);
  const other = require('../server/src/core').createCore({
    knex: core.knex,
    config: { encryptionKey: core.ctx.encryptionKey },
    now: () => core.clock.t,
    nodeId: 'other-node',
  });
  assert.ok(await core.outbox.maintain());
  assert.equal(await other.outbox.maintain(), null);
  core.advance(31_000);
  assert.ok(await other.outbox.maintain());
});

test('per-account rate limit defers without spending an attempt', async () => {
  const core = await scenario(fake);
  await core.accounts.update(core.wa.id, { limits: { perSecond: 1 } });
  const a = await send(core, { channel: 'whatsapp' });
  const b = await send(core, { channel: 'whatsapp' });
  const results = (await core.outbox.tick()).results.sort();
  assert.deepEqual(results, ['queued', 'sent']);
  const deferred = [a, b].map((m) => m.id);
  const rows = await Promise.all(deferred.map((d) => core.outbox.getRow(d)));
  const waiting = rows.find((r) => r.status === 'queued');
  assert.equal(Number(waiting.attempts), 0);
  core.advance(1_000);
  assert.deepEqual(await core.drain(), ['sent']);
});

test('telegram 403 (bot blocked) suppresses the channel for the contact', async () => {
  const core = await scenario(fake);
  const { addAccount } = require('./helpers/core');
  await addAccount(core, 'telegram');
  const token = await core.contacts.createLinkToken(core.contact.id);
  await core.contacts.consumeLinkToken(token, '555001');
  await core.templates.create({
    key: 'order_shipped',
    channel: 'telegram',
    language: 'de',
    name: 'TG',
    content: { text: 'Hallo {{name}} {{order}}' },
  });
  fake.queue('telegram.send', {
    status: 403,
    json: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
  });
  const { id } = await send(core, { channel: 'telegram' });
  await core.drain();
  assert.equal((await core.outbox.getRow(id)).error_code, 'TG_403');
  assert.ok(await core.contacts.suppression(core.contact.id, 'telegram'));
  await assert.rejects(send(core, { channel: 'telegram' }), { code: 'SUPPRESSED' });
});

test('retention purges old terminal messages, receipts and counters', async () => {
  const core = await scenario(fake);
  const { id } = await send(core, { channel: 'whatsapp' });
  await core.drain();
  core.advance(91 * 86_400_000);
  const result = await core.outbox.purge({ messageDays: 90, receiptDays: 7 });
  assert.equal(result.messages, 1);
  assert.equal(await core.outbox.getRow(id), null);
  assert.equal((await core.knex('mg_message_events').count({ n: '*' }))[0].n, 0);
});

test('list filters and paginates', async () => {
  const core = await scenario(fake);
  for (let i = 0; i < 3; i += 1) await send(core, { channel: 'whatsapp' });
  await send(core, { channel: 'sms' });
  const page = await core.outbox.list({ channel: 'whatsapp', pageSize: 2 });
  assert.equal(page.results.length, 2);
  assert.deepEqual(page.pagination, { page: 1, pageSize: 2, total: 3, pageCount: 2 });
});
