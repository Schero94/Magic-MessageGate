'use strict';

/**
 * PostgreSQL: 1.1 schema (composite key, column migration from 1.0), inbound
 * dedupe and the media job claim with several cores on one database.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { startFakeProviders } = require('../helpers/fake-providers');
const { pgKnex, makeCore, CREDS, PHONE } = require('../helpers/core');
const { memoryFiles } = require('../helpers/files');
const { dropSchema, ensureSchema } = require('../../server/src/store/schema');

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

test('schema: 1.0 tables gain the 1.1 columns; ensureSchema is safe in parallel', async () => {
  await ensureSchema(knex);
  await knex.schema.alterTable('mg_contacts', (t) => t.dropColumn('rcs_capability'));
  await Promise.all([ensureSchema(knex), ensureSchema(pgKnex()), ensureSchema(pgKnex())]);
  assert.ok(await knex.schema.hasColumn('mg_contacts', 'rcs_capability'));
  assert.ok(await knex.schema.hasTable('mg_inbound'));
  const version = await knex('mg_meta').where('meta_key', 'schema_version').first();
  assert.equal(version.meta_value, '2');
});

test('inbound: 6 cores record the same webhook once and download the media once', async () => {
  const files = memoryFiles();
  const cores = [];
  for (let i = 0; i < 6; i += 1) {
    cores.push(await makeCore({ knex: i === 0 ? knex : pgKnex(), providers: fake.providers, files, nodeId: `n${i}` }));
  }
  const [a] = cores;
  await a.accounts.create({ channel: 'whatsapp', provider: 'meta', name: 'WA', config: CREDS.meta });
  const contact = (await a.contacts.upsertByPhone(PHONE)).row;
  const account = (await a.accounts.forChannel('whatsapp'))[0];
  const input = (n) => ({
    provider: 'meta',
    providerMessageId: `wamid.PG${n}`,
    channel: 'whatsapp',
    contact,
    account,
    kind: 'media',
    media: { ref: { id: `900${String(n).padStart(4, '0')}` }, mime: 'image/jpeg' },
    at: Date.now(),
  });
  for (let n = 0; n < 20; n += 1) {
    const rows = await Promise.all(cores.map((c) => c.inbound.record(input(n))));
    assert.equal(rows.filter(Boolean).length, 1);
  }
  const events = cores.flatMap((c) => c.events.filter((e) => e.name === 'messagegate.message.received'));
  assert.equal(events.length, 20, 'one event per message across processes');
  for (let round = 0; round < 5; round += 1) await Promise.all(cores.map((c) => c.inbound.mediaTick()));
  assert.equal(fake.count('meta.mediaFile'), 20, 'each file downloaded once');
  const ready = cores.flatMap((c) => c.events.filter((e) => e.name === 'messagegate.media.ready'));
  assert.equal(ready.length, 20);
  assert.equal(files.rows.size, 20);
});
