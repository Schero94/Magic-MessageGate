'use strict';

/**
 * Exactly-once across 8 OS processes sharing one SQLite file. SQLite
 * serialises writers; claiming uses conditional updates whose affected-row
 * count decides the winner.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startFakeProviders } = require('./helpers/fake-providers');
const { sqliteKnex } = require('./helpers/core');
const { seed, startWorkers, assertExactlyOnce } = require('./helpers/multiprocess');

test('8 processes on SQLite send 120 messages exactly once', { timeout: 180_000 }, async () => {
  const fake = await startFakeProviders();
  try {
    fake.setDelay(5);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mg-mp-')), 'db.sqlite');
    const knex = sqliteKnex(file);
    const { ids } = await seed(knex, fake, 120);
    const workers = startWorkers(8, ['sqlite', file, fake.url]);
    const exits = await Promise.all(workers.map((w) => w.done));
    for (const e of exits) assert.equal(e.code, 0, e.err);
    const counts = await assertExactlyOnce(fake, knex, ids);
    assert.deepEqual(counts, { sent: 120 });
    assert.equal(fake.count('seven.send'), 120);
    const summaries = exits.map((e) => JSON.parse(e.out.trim().split('\n').pop()));
    if (process.env.MG_DEBUG) console.log(exits.map((e) => e.out));
    const busy = summaries.filter((s) => Object.values(s.results).length > 0);
    assert.ok(busy.length >= 2, 'work was shared between processes');
  } finally {
    await fake.close();
  }
});
