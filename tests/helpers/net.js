'use strict';

/** Shared test constants without a node:test dependency (safe for child processes). */
const TEST_KEY = 'synthetic-test-key-0123456789abcdef';

/** Fetch that only allows 127.0.0.1 (guards against accidental real calls). */
async function loopbackFetch(url, init) {
  const { hostname } = new URL(url);
  if (hostname !== '127.0.0.1') {
    throw Object.assign(new Error(`blocked non-loopback fetch to ${hostname}`), { code: 'ENOTFOUND' });
  }
  return fetch(url, init);
}

module.exports = { TEST_KEY, loopbackFetch };
