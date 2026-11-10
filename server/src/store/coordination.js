'use strict';

/**
 * Cross-process coordination on the shared database (several replicas or
 * pm2 workers on one PostgreSQL/MySQL/SQLite database). Every helper uses a
 * single portable statement whose affected-row count decides the winner, so
 * no Redis or advisory locks are needed.
 */
const { T } = require('./schema');

/**
 * @param {import('knex').Knex} knex
 * @returns {'postgres'|'mysql'|'sqlite'}
 */
function dialectOf(knex) {
  const raw = String(knex?.client?.config?.client || knex?.client?.dialect || '').toLowerCase();
  if (raw.includes('pg') || raw.includes('postgres')) return 'postgres';
  if (raw.includes('mysql')) return 'mysql';
  return 'sqlite';
}

/**
 * Affected rows of an update/delete across drivers.
 *
 * @param {*} result
 * @returns {number}
 */
function affected(result) {
  if (typeof result === 'number') return result;
  if (Array.isArray(result)) return result.length;
  if (result && typeof result.rowCount === 'number') return result.rowCount;
  return 0;
}

/**
 * Acquires (or renews) a named lease. Only one holder owns a lease at a time;
 * an expired lease can be taken over.
 *
 * @param {import('knex').Knex} knex
 * @param {string} key
 * @param {string} holder
 * @param {number} ttlMs
 * @param {number} [now]
 * @returns {Promise<boolean>} Whether `holder` owns the lease now.
 */
async function acquireLease(knex, key, holder, ttlMs, now = Date.now()) {
  const expiresAt = now + ttlMs;
  try {
    await knex(T.claims).insert({ claim_key: key, holder, expires_at: expiresAt });
    return true;
  } catch {
    // Row exists: take it over when expired or renew our own lease.
  }
  const updated = await knex(T.claims)
    .where('claim_key', key)
    .andWhere((q) => q.where('holder', holder).orWhere('expires_at', '<', now))
    .update({ holder, expires_at: expiresAt });
  return affected(updated) === 1;
}

/**
 * Releases a lease if `holder` still owns it.
 *
 * @param {import('knex').Knex} knex
 * @param {string} key
 * @param {string} holder
 * @returns {Promise<void>}
 */
async function releaseLease(knex, key, holder) {
  await knex(T.claims).where({ claim_key: key, holder }).del();
}

/**
 * Records a one-time key (webhook event, nonce). Returns false when the key
 * was already seen.
 *
 * @param {import('knex').Knex} knex
 * @param {string} provider
 * @param {string} eventKey
 * @param {number} [now]
 * @returns {Promise<boolean>}
 */
async function claimOnce(knex, provider, eventKey, now = Date.now()) {
  const key = `${provider}:${eventKey}`.slice(0, 191);
  try {
    await knex(T.receipts).insert({ event_key: key, provider, received_at: now });
    return true;
  } catch {
    return false;
  }
}

/**
 * Releases a one-time key after the handler failed, so a provider retry is
 * processed again.
 *
 * @param {import('knex').Knex} knex
 * @param {string} provider
 * @param {string} eventKey
 * @returns {Promise<void>}
 */
async function unclaim(knex, provider, eventKey) {
  await knex(T.receipts).where('event_key', `${provider}:${eventKey}`.slice(0, 191)).del();
}

/**
 * Fixed-window counter shared by all processes.
 *
 * @param {import('knex').Knex} knex
 * @param {string} key
 * @param {number} windowMs
 * @param {number} [amount]
 * @param {number} [now]
 * @returns {Promise<number>} Hits in the current window after this hit.
 */
async function hit(knex, key, windowMs, amount = 1, now = Date.now()) {
  const counterKey = String(key).slice(0, 191);
  // Reset an expired window first (a no-op for live windows).
  await knex(T.counters).where('counter_key', counterKey).andWhere('expires_at', '<=', now).del();
  try {
    await knex(T.counters).insert({ counter_key: counterKey, hits: amount, expires_at: now + windowMs });
    return amount;
  } catch {
    await knex(T.counters)
      .where('counter_key', counterKey)
      .update({ hits: knex.raw('hits + ?', [amount]) });
    const row = await knex(T.counters).where('counter_key', counterKey).first('hits');
    return Number(row?.hits || amount);
  }
}

/**
 * Reads a counter without changing it.
 *
 * @param {import('knex').Knex} knex
 * @param {string} key
 * @param {number} [now]
 * @returns {Promise<number>}
 */
async function peek(knex, key, now = Date.now()) {
  const row = await knex(T.counters).where('counter_key', String(key).slice(0, 191)).first('hits', 'expires_at');
  if (!row || Number(row.expires_at) <= now) return 0;
  return Number(row.hits || 0);
}

module.exports = { dialectOf, affected, acquireLease, releaseLease, claimOnce, unclaim, hit, peek };
