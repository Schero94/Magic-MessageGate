'use strict';

/**
 * PostgreSQL multi-process tests (npm run test:pg). Needs a local server;
 * MG_TEST_PG_URL defaults to postgres://strapi@127.0.0.1:5440/mg_test.
 * Claiming uses UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { startFakeProviders } = require('../helpers/fake-providers');
const { pgKnex } = require('../helpers/core');
const { seed, startWorkers, assertExactlyOnce } = require('../helpers/multiprocess');
const { dropSchema } = require('../../server/src/store/schema');

const URL = process.env.MG_TEST_PG_URL || 'postgres://strapi@127.0.0.1:5440/mg_test';

let fake;
let knex;
test.beforeEach(async () => {
  fake = await startFakeProviders();
  knex = pgKnex();
  await dropSchema(knex);
});
test.afterEach(async () => {
  await fake.close();
});

test('claim SQL uses FOR UPDATE SKIP LOCKED on PostgreSQL', async () => {
  const { core } = await seed(knex, fake, 3);
  const queries = [];
  knex.on('query', (q) => queries.push(q.sql));
  await core.outbox.claim(2);
  knex.removeAllListeners('query');
  const claim = queries.find((q) => /update "mg_messages"/i.test(q));
  assert.match(claim, /for update skip locked/i);
  assert.match(claim, /returning \*/i);
});

test('8 processes on PostgreSQL send 300 messages exactly once', { timeout: 240_000 }, async () => {
  fake.setDelay(5);
  const { ids } = await seed(knex, fake, 300);
  const workers = startWorkers(8, ['pg', URL, fake.url]);
  const exits = await Promise.all(workers.map((w) => w.done));
  for (const e of exits) assert.equal(e.code, 0, e.err);
  const counts = await assertExactlyOnce(fake, knex, ids);
  assert.deepEqual(counts, { sent: 300 });
  assert.equal(fake.count('seven.send'), 300);
  const busy = exits.map((e) => JSON.parse(e.out.trim().split('\n').pop())).filter((s) => s.results.sent > 0);
  assert.ok(busy.length >= 4, `work was shared (${busy.length} processes sent)`);
});

test(
  'SIGKILL during a provider call: the message becomes uncertain, nothing is sent twice',
  { timeout: 240_000 },
  async () => {
    fake.setDelay(20);
    fake.queue('seven.send', { hang: true });
    const { ids } = await seed(knex, fake, 60);
    const workers = startWorkers(8, ['pg', URL, fake.url], 10_000);

    // Wait until the hung request is in flight, then kill its process.
    let victim = null;
    for (let i = 0; i < 300 && !victim; i += 1) {
      const row = await knex('mg_messages')
        .where({ status: 'queued', phase: 'dispatching' })
        .whereIn('document_id', [fake.of('seven.send')[0]?.form?.foreign_id || ''])
        .first();
      if (row) victim = row;
      else await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(victim, 'the hung message is dispatching');
    const owner = workers.find((w) => w.nodeId === victim.claimed_by);
    owner.child.kill('SIGKILL');
    const exits = await Promise.all(workers.map((w) => w.done));
    assert.equal(exits.find((e) => e.nodeId === owner.nodeId).signal, 'SIGKILL');
    for (const e of exits.filter((x) => x.nodeId !== owner.nodeId)) assert.equal(e.code, 0, e.err);

    const counts = await assertExactlyOnce(fake, knex, ids);
    const killed = await knex('mg_messages').where('id', victim.id).first();
    assert.equal(killed.status, 'uncertain');
    assert.equal(killed.error_code, 'LEASE_EXPIRED_DURING_SEND');
    assert.equal((counts.sent || 0) + (counts.uncertain || 0), 60);
    for (const res of fake.hanging) res.destroy();
  }
);

test('analytics aggregates (rates, fallbacks, pricing categories) run on PostgreSQL', async () => {
  const { core } = await seed(knex, fake, 5);
  await core.drain?.();
  const two = (await knex('mg_messages').orderBy('id').limit(2).select('id')).map((r) => r.id);
  await knex('mg_messages').whereIn('id', two).update({ cost_category: 'utility' });
  const summary = await core.analytics.summary({});
  assert.equal(summary.totals.total, 5);
  assert.equal(typeof summary.fallbacks.total, 'number');
  assert.equal(summary.costCategories.utility, 2);
  assert.ok(Array.isArray(summary.byChannel));
});
