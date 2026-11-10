'use strict';

/**
 * MessageGate stores its data in plugin-owned tables created with knex
 * instead of Strapi content types (decision D9 in CONCEPT.md):
 *
 * - The outbox needs claiming statements (`FOR UPDATE SKIP LOCKED`,
 *   conditional updates) that the Document Service does not offer.
 * - Strapi's schema sync is not coordinated when several processes boot at
 *   once; these tables are created with `CREATE TABLE IF NOT EXISTS`
 *   semantics and tolerate concurrent creation.
 * - Nothing is exposed through the Content Manager, the Content API or
 *   GraphQL Shadow CRUD by accident.
 * - Tests run the same code against SQLite and PostgreSQL with plain knex.
 *
 * Strapi leaves tables it never tracked alone during its schema sync.
 * All times are epoch milliseconds (bigint) so comparisons are portable.
 *
 * @see https://knexjs.org/guide/schema-builder.html
 */

const SCHEMA_VERSION = 1;

const T = Object.freeze({
  accounts: 'mg_accounts',
  templates: 'mg_templates',
  contacts: 'mg_contacts',
  consents: 'mg_consents',
  messages: 'mg_messages',
  events: 'mg_message_events',
  receipts: 'mg_webhook_receipts',
  suppressions: 'mg_suppressions',
  lookups: 'mg_lookups',
  claims: 'mg_claims',
  counters: 'mg_counters',
  linkTokens: 'mg_link_tokens',
  meta: 'mg_meta',
});

/** @type {Array<[string, (t: any) => void]>} */
const DEFINITIONS = [
  [
    T.accounts,
    (t) => {
      t.increments('id').primary();
      t.string('document_id', 32).notNullable().unique();
      t.string('channel', 16).notNullable();
      t.string('provider', 16).notNullable();
      t.string('name', 120).notNullable();
      t.boolean('is_active').notNullable().defaultTo(true);
      t.boolean('is_default').notNullable().defaultTo(false);
      t.integer('priority').notNullable().defaultTo(100);
      t.text('config_sealed');
      t.string('webhook_path', 64).notNullable().unique();
      t.text('limits');
      t.string('health_status', 16);
      t.string('health_code', 64);
      t.bigInteger('health_at');
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.index(['channel', 'is_active'], 'mg_accounts_channel_idx');
    },
  ],
  [
    T.templates,
    (t) => {
      t.increments('id').primary();
      t.string('document_id', 32).notNullable().unique();
      t.string('key', 120).notNullable();
      t.string('channel', 16).notNullable();
      t.string('language', 16).notNullable();
      t.string('name', 160).notNullable();
      t.string('category', 24).notNullable().defaultTo('UTILITY');
      t.string('parameter_format', 16).notNullable().defaultTo('named');
      t.text('content').notNullable();
      t.text('variables').notNullable();
      t.integer('account_id');
      t.string('provider_template_id', 64);
      t.string('approval_status', 24).notNullable().defaultTo('LOCAL');
      t.string('rejection_reason', 120);
      t.integer('version').notNullable().defaultTo(1);
      t.boolean('is_active').notNullable().defaultTo(true);
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.unique(['channel', 'key', 'language'], { indexName: 'mg_templates_key_uq' });
    },
  ],
  [
    T.contacts,
    (t) => {
      t.increments('id').primary();
      t.string('document_id', 32).notNullable().unique();
      t.string('phone_hash', 64).unique();
      t.text('phone_sealed');
      t.string('telegram_hash', 64).unique();
      t.text('telegram_sealed');
      t.integer('user_id');
      t.string('locale', 16);
      t.string('country', 4);
      t.string('line_type', 24);
      t.string('wa_reachability', 16).notNullable().defaultTo('unknown');
      t.bigInteger('wa_reachability_at');
      t.bigInteger('last_inbound_at');
      t.string('last_inbound_channel', 16);
      t.bigInteger('last_delivered_at');
      t.bigInteger('last_read_at');
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.index(['user_id'], 'mg_contacts_user_idx');
    },
  ],
  [
    T.consents,
    (t) => {
      t.increments('id').primary();
      t.integer('contact_id').notNullable();
      t.string('channel', 16).notNullable();
      t.string('status', 16).notNullable();
      t.string('source', 24).notNullable();
      t.bigInteger('granted_at');
      t.bigInteger('revoked_at');
      t.bigInteger('updated_at').notNullable();
      t.unique(['contact_id', 'channel'], { indexName: 'mg_consents_uq' });
    },
  ],
  [
    T.messages,
    (t) => {
      t.increments('id').primary();
      t.string('document_id', 32).notNullable().unique();
      t.string('status', 16).notNullable();
      t.string('phase', 16).notNullable();
      t.string('channel', 16).notNullable();
      t.integer('account_id');
      t.integer('template_id');
      t.string('template_key', 120);
      t.integer('contact_id');
      t.text('payload_sealed');
      t.integer('attempts').notNullable().defaultTo(0);
      t.integer('max_attempts').notNullable().defaultTo(4);
      t.bigInteger('next_attempt_at').notNullable();
      t.bigInteger('not_after').notNullable();
      t.boolean('not_after_fixed').notNullable().defaultTo(false);
      t.string('lease_token', 40);
      t.bigInteger('lease_until');
      t.string('claimed_by', 64);
      t.string('idempotency_hash', 64).unique();
      t.string('provider_message_id', 128);
      t.string('error_code', 64);
      t.text('error_history');
      t.text('chain');
      t.integer('fallback_of');
      t.string('source', 16).notNullable().defaultTo('api');
      t.string('cost_category', 24);
      t.boolean('transactional').notNullable().defaultTo(false);
      t.text('metadata');
      t.integer('priority').notNullable().defaultTo(100);
      t.bigInteger('sent_at');
      t.bigInteger('delivered_at');
      t.bigInteger('read_at');
      t.bigInteger('failed_at');
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.index(['status', 'next_attempt_at'], 'mg_messages_due_idx');
      t.index(['provider_message_id'], 'mg_messages_provider_idx');
      t.index(['contact_id', 'created_at'], 'mg_messages_contact_idx');
      t.index(['created_at'], 'mg_messages_created_idx');
      t.index(['status', 'lease_until'], 'mg_messages_lease_idx');
    },
  ],
  [
    T.events,
    (t) => {
      t.increments('id').primary();
      t.integer('message_id').notNullable();
      t.string('type', 24).notNullable();
      t.string('code', 64);
      t.bigInteger('at').notNullable();
      t.index(['message_id', 'at'], 'mg_events_message_idx');
    },
  ],
  [
    T.receipts,
    (t) => {
      t.string('event_key', 191).primary();
      t.string('provider', 16).notNullable();
      t.bigInteger('received_at').notNullable();
      t.index(['received_at'], 'mg_receipts_received_idx');
    },
  ],
  [
    T.suppressions,
    (t) => {
      t.increments('id').primary();
      t.integer('contact_id').notNullable();
      t.string('channel', 16).notNullable();
      t.string('reason', 32).notNullable();
      t.bigInteger('until');
      t.bigInteger('created_at').notNullable();
      t.unique(['contact_id', 'channel'], { indexName: 'mg_suppressions_uq' });
    },
  ],
  [
    T.lookups,
    (t) => {
      t.string('phone_hash', 64).primary();
      t.text('result').notNullable();
      t.bigInteger('checked_at').notNullable();
    },
  ],
  [
    T.claims,
    (t) => {
      t.string('claim_key', 191).primary();
      t.string('holder', 64).notNullable();
      t.bigInteger('expires_at').notNullable();
    },
  ],
  [
    T.counters,
    (t) => {
      t.string('counter_key', 191).primary();
      t.integer('hits').notNullable().defaultTo(0);
      t.bigInteger('expires_at').notNullable();
    },
  ],
  [
    T.linkTokens,
    (t) => {
      t.string('token_hash', 64).primary();
      t.integer('contact_id').notNullable();
      t.bigInteger('expires_at').notNullable();
      t.bigInteger('used_at');
    },
  ],
  [
    T.meta,
    (t) => {
      t.string('meta_key', 64).primary();
      t.text('meta_value').notNullable();
      t.integer('revision').notNullable().defaultTo(1);
      t.bigInteger('updated_at').notNullable();
    },
  ],
];

/**
 * Creates every missing table. Safe to run from several processes at once:
 * a "table already exists" error from a parallel creator is ignored.
 *
 * @param {import('knex').Knex} knex
 * @returns {Promise<number>} Number of tables created by this call.
 */
async function ensureSchema(knex) {
  let created = 0;
  for (const [name, define] of DEFINITIONS) {
    if (await knex.schema.hasTable(name)) continue;
    try {
      await knex.schema.createTable(name, define);
      created += 1;
    } catch (error) {
      if (!(await knex.schema.hasTable(name))) throw error;
    }
  }
  const now = Date.now();
  try {
    await knex(T.meta)
      .insert({ meta_key: 'schema_version', meta_value: String(SCHEMA_VERSION), revision: 1, updated_at: now })
      .onConflict('meta_key')
      .ignore();
  } catch {
    // Older SQLite/MySQL drivers without onConflict support never reach here in Strapi 5.
  }
  return created;
}

/**
 * Drops every MessageGate table (tests and the "erase all data" admin action).
 *
 * @param {import('knex').Knex} knex
 * @returns {Promise<void>}
 */
async function dropSchema(knex) {
  for (const [name] of [...DEFINITIONS].reverse()) {
    await knex.schema.dropTableIfExists(name);
  }
}

module.exports = { T, SCHEMA_VERSION, ensureSchema, dropSchema };
