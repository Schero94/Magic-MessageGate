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

const SCHEMA_VERSION = 2;

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
  numberChecks: 'mg_number_checks',
  attachmentLinks: 'mg_attachment_links',
  inbound: 'mg_inbound',
  hooksOut: 'mg_webhook_out',
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
  // 1.1: cached paid number checks (HLR) per number hash and kind.
  [
    T.numberChecks,
    (t) => {
      t.string('phone_hash', 64).notNullable();
      t.string('kind', 16).notNullable();
      t.text('result').notNullable();
      t.bigInteger('checked_at').notNullable();
      t.primary(['phone_hash', 'kind'], 'mg_number_checks_pk');
    },
  ],
  // 1.1: signed download links for attachments (reference only, never content).
  [
    T.attachmentLinks,
    (t) => {
      t.string('link_id', 32).primary();
      t.text('ref_sealed').notNullable();
      t.bigInteger('expires_at').notNullable();
      t.bigInteger('created_at').notNullable();
      t.index(['expires_at'], 'mg_attachment_links_exp_idx');
    },
  ],
  // 1.1: inbound messages. Text, captions, locations and media references
  // are sealed like phone numbers; `provider_key` deduplicates webhooks.
  [
    T.inbound,
    (t) => {
      t.increments('id').primary();
      t.string('document_id', 32).notNullable().unique();
      t.string('provider_key', 191).notNullable().unique();
      t.integer('contact_id');
      t.integer('account_id');
      t.string('channel', 16).notNullable();
      t.string('kind', 16).notNullable();
      t.text('content_sealed');
      t.string('button_payload', 256);
      t.integer('reply_to_message_id');
      t.string('media_status', 16).notNullable().defaultTo('none');
      t.string('media_code', 64);
      t.text('media_ref_sealed');
      t.string('media_mime', 120);
      t.bigInteger('media_size');
      t.integer('media_file_id');
      t.integer('media_attempts').notNullable().defaultTo(0);
      t.bigInteger('media_next_at');
      t.bigInteger('media_deadline');
      t.string('media_lease', 40);
      t.bigInteger('media_lease_until');
      t.bigInteger('received_at').notNullable();
      t.bigInteger('processed_at');
      t.bigInteger('seen_at');
      t.bigInteger('created_at').notNullable();
      t.index(['contact_id', 'received_at'], 'mg_inbound_contact_idx');
      t.index(['media_status', 'media_next_at'], 'mg_inbound_media_idx');
      t.index(['received_at'], 'mg_inbound_received_idx');
    },
  ],
  // 1.1: outgoing webhook deliveries (owner's URL), claimed like the outbox.
  [
    T.hooksOut,
    (t) => {
      t.increments('id').primary();
      t.string('document_id', 32).notNullable().unique();
      t.string('event', 48).notNullable();
      t.text('payload').notNullable();
      t.string('status', 16).notNullable();
      t.integer('attempts').notNullable().defaultTo(0);
      t.bigInteger('next_attempt_at').notNullable();
      t.string('lease_token', 40);
      t.bigInteger('lease_until');
      t.string('last_code', 64);
      t.bigInteger('delivered_at');
      t.bigInteger('created_at').notNullable();
      t.index(['status', 'next_attempt_at'], 'mg_webhook_out_due_idx');
    },
  ],
];

/**
 * Columns added after 1.0 to existing tables: [table, column, define].
 *
 * @type {Array<[string, string, (t: any) => void]>}
 */
const COLUMNS = [
  [T.contacts, 'rcs_capability', (t) => t.string('rcs_capability', 16)],
  [T.contacts, 'rcs_capability_at', (t) => t.bigInteger('rcs_capability_at')],
  [T.contacts, 'line_active', (t) => t.string('line_active', 16)],
  [T.contacts, 'line_checked_at', (t) => t.bigInteger('line_checked_at')],
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
  for (const [table, column, define] of COLUMNS) {
    if (await knex.schema.hasColumn(table, column)) continue;
    try {
      await knex.schema.alterTable(table, define);
    } catch (error) {
      // A parallel process added it first.
      if (!(await knex.schema.hasColumn(table, column))) throw error;
    }
  }
  const now = Date.now();
  await knex(T.meta)
    .where('meta_key', 'schema_version')
    .andWhere('meta_value', '<', String(SCHEMA_VERSION))
    .update({ meta_value: String(SCHEMA_VERSION), updated_at: now });
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

module.exports = { T, SCHEMA_VERSION, COLUMNS, ensureSchema, dropSchema };
