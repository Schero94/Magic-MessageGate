'use strict';

/**
 * One worker process for the multi-process outbox tests. It runs the real
 * claim/dispatch loop against the shared database until no queued message
 * is left, then prints a JSON summary.
 *
 * argv: dialect (sqlite|pg), target (file or connection URL), fake URL, node id, lease ms
 */
const knexFactory = require('knex');
const { createCore } = require('../../server/src/core');
const { loopbackFetch, TEST_KEY } = require('./net');

async function main() {
  const [dialect, target, fakeUrl, nodeId, leaseMs] = process.argv.slice(2);
  const knex =
    dialect === 'pg'
      ? knexFactory({ client: 'pg', connection: target, pool: { min: 0, max: 3 } })
      : knexFactory({
          client: 'better-sqlite3',
          connection: { filename: target },
          useNullAsDefault: true,
          pool: {
            min: 1,
            max: 1,
            afterCreate: (conn, done) => {
              conn.pragma('busy_timeout = 20000');
              done();
            },
          },
        });
  const core = createCore({
    knex,
    config: {
      encryptionKey: TEST_KEY,
      providers: { seven: { baseUrl: `${fakeUrl}/seven`, timeoutMs: 60_000 } },
      worker: { batchSize: 5, concurrency: 2, leaseMs: Number(leaseMs) || 120_000 },
    },
    nodeId,
    fetchImpl: loopbackFetch,
  });
  const results = {};
  const deadline = Date.now() + 120_000;
  process.send?.({ ready: true });
  while (Date.now() < deadline) {
    const { claimed, results: r } = await core.outbox.tick();
    for (const x of r) results[x] = (results[x] || 0) + 1;
    await core.outbox.maintain();
    if (!claimed) {
      const [{ n }] = await knex('mg_messages').where('status', 'queued').count({ n: '*' });
      if (Number(n) === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  process.stdout.write(`${JSON.stringify({ nodeId, results })}\n`);
  await knex.destroy();
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});
