'use strict';

/**
 * Test core factory: a real knex database (SQLite file by default, or the
 * PostgreSQL test database), synthetic data only, and a fetch that refuses
 * anything but loopback so no test can reach a real provider.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { after } = require('node:test');
const knexFactory = require('knex');
const { createCore } = require('../../server/src/core');
const { resetKeyCache } = require('../../server/src/utils/crypto');

const { TEST_KEY, loopbackFetch } = require('./net');

/** Every knex created by a test file is destroyed when the file ends. */
const open = new Set();
after(async () => {
  await Promise.all([...open].map((k) => k.destroy()));
  open.clear();
});

/**
 * @param {string} [file]
 * @returns {import('knex').Knex}
 */
function sqliteKnex(file) {
  return track(
    knexFactory({
      client: 'better-sqlite3',
      connection: { filename: file || path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mg-test-')), 'db.sqlite') },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 },
    })
  );
}

/**
 * @param {import('knex').Knex} knex
 * @returns {import('knex').Knex}
 */
function track(knex) {
  open.add(knex);
  return knex;
}

/**
/** @returns {import('knex').Knex} PostgreSQL test database (MG_TEST_PG_URL). */
function pgKnex() {
  return track(
    knexFactory({
      client: 'pg',
      connection: process.env.MG_TEST_PG_URL || 'postgres://strapi@127.0.0.1:5440/mg_test',
      pool: { min: 0, max: 4 },
    })
  );
}

/**
 * @param {object} [options]
 * @param {import('knex').Knex} [options.knex]
 * @param {object} [options.providers] - Fake provider base URLs.
 * @param {object} [options.config] - Extra plugin config.
 * @param {Function} [options.now]
 * @param {object} [options.magicMail]
 * @returns {Promise<object>} Core plus `events` and `knex`.
 */
async function makeCore(options = {}) {
  resetKeyCache();
  const knex = options.knex || sqliteKnex();
  const events = [];
  const core = createCore({
    knex,
    config: {
      encryptionKey: TEST_KEY,
      publicUrl: 'https://cms.example.test',
      providers: options.providers || {},
      retry: { delaysMs: [60_000, 300_000, 900_000], jitter: 0 },
      ...(options.config || {}),
    },
    emit: (name, payload) => events.push({ name, payload }),
    now: options.now,
    random: () => 0.5,
    fetchImpl: loopbackFetch,
    magicMail: options.magicMail,
    nodeId: options.nodeId,
  });
  await core.init();
  core.events = events;
  core.knex = knex;
  return core;
}

/** Synthetic provider credentials (format-valid, never real). */
const CREDS = {
  meta: {
    accessToken: 'EAAsynthetic-token-1234567890',
    phoneNumberId: '1234567890',
    wabaId: '9876543210',
    appSecret: 'synthetic-app-secret-123',
  },
  telegram: { botToken: '123456789:AAsyntheticTokenValue_1234567890abc' },
  seven: { apiKey: 'synthetic-seven-api-key', signingKey: 'synthetic-seven-signing-key', senderId: 'Shop' },
  twilio: { accountSid: `AC${'a'.repeat(32)}`, authToken: 'b'.repeat(32), from: '+15005550006' },
};
const CHANNEL = { meta: 'whatsapp', telegram: 'telegram', seven: 'sms', twilio: 'sms' };

/**
 * @param {object} core
 * @param {'meta'|'telegram'|'seven'|'twilio'} provider
 * @param {object} [extra]
 * @returns {Promise<object>} Account DTO.
 */
function addAccount(core, provider, extra = {}) {
  return core.accounts.create({
    channel: CHANNEL[provider],
    provider,
    name: `${provider} synthetic`,
    config: { ...CREDS[provider], ...(extra.config || {}) },
    ...(extra.fields || {}),
  });
}

/** Synthetic German mobile numbers (reserved-looking test values). */
const PHONE = '+4915123456789';
const PHONE2 = '+4917612345678';

module.exports = { makeCore, sqliteKnex, pgKnex, loopbackFetch, addAccount, CREDS, PHONE, PHONE2, TEST_KEY };
