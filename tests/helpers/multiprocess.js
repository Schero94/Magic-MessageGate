'use strict';

/** Shared driver for the 8-process exactly-once tests (SQLite and PostgreSQL). */
const assert = require('node:assert/strict');
const path = require('node:path');
const { fork } = require('node:child_process');
const { makeCore, CREDS, PHONE } = require('./core');

const WORKER = path.join(__dirname, 'worker-proc.js');

/**
 * Seeds `count` SMS messages and returns the seeding core.
 *
 * @param {import('knex').Knex} knex
 * @param {object} fake
 * @param {number} count
 * @returns {Promise<object>}
 */
async function seed(knex, fake, count) {
  const core = await makeCore({ knex, providers: fake.providers, config: { worker: { enabled: false } } });
  await core.accounts.create({ channel: 'sms', provider: 'seven', name: 'SMS', config: CREDS.seven });
  await core.templates.create({
    key: 'hello',
    channel: 'sms',
    language: 'de',
    name: 'Hello',
    content: { text: 'Hallo {{n}}' },
  });
  const { row } = await core.contacts.upsertByPhone(PHONE);
  await core.contacts.setConsent(row.id, 'sms', 'granted', 'test');
  const ids = [];
  for (let i = 0; i < count; i += 1) {
    const res = await core.sender.send({
      to: PHONE,
      channel: 'sms',
      template: 'hello',
      language: 'de',
      variables: { n: String(i) },
      idempotencyKey: `seed-${i}`,
    });
    ids.push(res.id);
  }
  return { core, ids };
}

/**
 * Starts worker processes.
 *
 * @param {number} n
 * @param {string[]} args - dialect, target, fake URL
 * @param {number} [leaseMs]
 * @returns {Array<{child: import('child_process').ChildProcess, nodeId: string, done: Promise<object>}>}
 */
function startWorkers(n, args, leaseMs = 120_000) {
  return Array.from({ length: n }, (_, i) => {
    const nodeId = `worker-${i}`;
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = fork(WORKER, [...args, nodeId, String(leaseMs)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const done = new Promise((resolve) => {
      child.on('exit', (code, signal) => resolve({ code, signal, out, err, nodeId }));
    });
    return { child, nodeId, done };
  });
}

/**
 * Asserts exactly-once: every message was requested from the provider at
 * most once, every sent message exactly once, nothing left queued.
 *
 * @param {object} fake
 * @param {import('knex').Knex} knex
 * @param {string[]} ids
 * @returns {Promise<Record<string, number>>} Status counts.
 */
async function assertExactlyOnce(fake, knex, ids) {
  const perMessage = new Map();
  for (const r of fake.of('seven.send'))
    perMessage.set(r.form.foreign_id, (perMessage.get(r.form.foreign_id) || 0) + 1);
  const duplicates = [...perMessage].filter(([, n]) => n > 1);
  assert.deepEqual(duplicates, [], 'no message may be sent twice');
  const rows = await knex('mg_messages').whereIn('document_id', ids).select('document_id', 'status');
  const counts = {};
  for (const row of rows) {
    counts[row.status] = (counts[row.status] || 0) + 1;
    if (row.status === 'sent') assert.equal(perMessage.get(row.document_id), 1, `sent ${row.document_id} once`);
  }
  assert.equal(counts.queued || 0, 0, 'nothing may stay queued');
  return counts;
}

module.exports = { seed, startWorkers, assertExactlyOnce };
