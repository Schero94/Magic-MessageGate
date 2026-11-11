'use strict';

/**
 * Outgoing webhook: forwards selected MessageGate events to an https URL of
 * the owner. Deliveries are rows in `mg_webhook_out`, claimed with a lease
 * like the outbox (one process delivers each row) and retried with backoff.
 *
 * Request: POST, JSON body `{ id, event, data, at }`, headers
 *   X-MessageGate-Event, X-MessageGate-Delivery (id), X-MessageGate-Timestamp
 *   (unix seconds), X-MessageGate-Signature: `v1=<hex HMAC-SHA256(secret,
 *   "<timestamp>.<raw body>")>`.
 * Payloads are the event payloads: ids, channel, status, codes, never phone
 * numbers or message text. The URL must be public https (SSRF policy in
 * utils/url-guard.js, checked again before every delivery); redirects are
 * not followed.
 */
const crypto = require('node:crypto');
const { T } = require('../store/schema');
const { affected } = require('../store/coordination');
const { seal, tryOpen, randomToken } = require('../utils/crypto');
const { checkUrl, resolvesPublic } = require('../utils/url-guard');
const { newId, parseJson } = require('./context');

const SECRET = 'webhook-secret';
const RETRY_MS = [60_000, 300_000, 900_000, 3_600_000, 6 * 3_600_000];
const MAX_ATTEMPTS = RETRY_MS.length + 1;

/** Internal event name → outgoing event name. */
const EVENT_MAP = Object.freeze({
  'messagegate.message.received': 'message.received',
  'messagegate.media.ready': 'media.ready',
  'messagegate.media.failed': 'media.failed',
  'messagegate.message.sent': 'message.status',
  'messagegate.message.delivered': 'message.status',
  'messagegate.message.read': 'message.status',
  'messagegate.message.failed': 'message.status',
  'messagegate.message.uncertain': 'message.status',
  'messagegate.message.expired': 'message.status',
});

/**
 * Signature of a delivery body (also used by receivers in tests/docs).
 *
 * @param {string} secret
 * @param {number|string} timestamp - Unix seconds.
 * @param {string} body - Raw JSON body.
 * @returns {string} `v1=<hex>`
 */
function signDelivery(secret, timestamp, body) {
  return `v1=${crypto.createHmac('sha256', String(secret)).update(`${timestamp}.${body}`).digest('hex')}`;
}

/**
 * @param {import('./context').CoreContext} ctx
 * @param {{settings: object}} deps
 */
function createHooksOut(ctx, deps) {
  const allowPrivate = Boolean(ctx.config.outgoingWebhooks?.allowPrivateHosts);

  /** @returns {Promise<string|null>} */
  async function secret() {
    const row = await ctx.knex(T.meta).where('meta_key', 'webhook_secret').first();
    return row ? tryOpen(row.meta_value, SECRET, ctx.encryptionKey) : null;
  }

  /**
   * @param {string} url
   * @returns {Promise<boolean>}
   */
  async function urlAllowed(url) {
    if (allowPrivate) return /^https?:\/\//.test(String(url));
    return checkUrl(url).ok && (await resolvesPublic(url));
  }

  const api = {
    EVENT_MAP,
    signDelivery,

    /**
     * Queues a delivery for an internal event when the owner selected it.
     *
     * @param {string} name - internal event name
     * @param {object} payload
     * @returns {Promise<boolean>} whether a delivery was queued
     */
    async enqueue(name, payload) {
      const event = EVENT_MAP[name];
      if (!event) return false;
      const settings = await deps.settings.get();
      const hook = settings.outgoingWebhook;
      if (!hook.enabled || !hook.url || !hook.events.includes(event)) return false;
      const now = ctx.now();
      const data = event === 'message.status' ? { ...payload } : payload;
      await ctx.knex(T.hooksOut).insert({
        document_id: newId(),
        event,
        payload: JSON.stringify(data).slice(0, 8000),
        status: 'pending',
        attempts: 0,
        next_attempt_at: now,
        created_at: now,
      });
      return true;
    },

    /**
     * Creates (or rotates) the signing secret and returns it once.
     *
     * @returns {Promise<{secret: string}>}
     */
    async rotateSecret() {
      const value = `whsec_${randomToken(32)}`;
      const now = ctx.now();
      const sealed = seal(value, SECRET, ctx.encryptionKey);
      const updated = await ctx
        .knex(T.meta)
        .where('meta_key', 'webhook_secret')
        .update({ meta_value: sealed, updated_at: now });
      if (!affected(updated)) {
        try {
          await ctx
            .knex(T.meta)
            .insert({ meta_key: 'webhook_secret', meta_value: sealed, revision: 1, updated_at: now });
        } catch {
          await ctx.knex(T.meta).where('meta_key', 'webhook_secret').update({ meta_value: sealed, updated_at: now });
        }
      }
      return { secret: value };
    },

    /** @returns {Promise<boolean>} */
    async hasSecret() {
      return Boolean(await secret());
    },

    /**
     * Delivers due rows (claimed per row, safe across processes).
     *
     * @param {number} [limit]
     * @returns {Promise<string[]>}
     */
    async tick(limit = 10) {
      const settings = await deps.settings.get();
      const hook = settings.outgoingWebhook;
      if (!hook.enabled || !hook.url) return [];
      const key = await secret();
      if (!key) return [];
      const now = ctx.now();
      const lease = crypto.randomBytes(16).toString('hex');
      const due = await ctx
        .knex(T.hooksOut)
        .where('status', 'pending')
        .andWhere('next_attempt_at', '<=', now)
        .andWhere((q) => q.whereNull('lease_until').orWhere('lease_until', '<', now))
        .orderBy('id')
        .limit(limit)
        .select('id', 'lease_token');
      const results = [];
      for (const candidate of due) {
        const q = ctx.knex(T.hooksOut).where({ id: candidate.id, status: 'pending' });
        if (candidate.lease_token) q.andWhere('lease_token', candidate.lease_token);
        else q.whereNull('lease_token');
        if (affected(await q.update({ lease_token: lease, lease_until: now + 60_000 })) !== 1) continue;
        const row = await ctx.knex(T.hooksOut).where('id', candidate.id).first();
        results.push(await deliver(row, hook.url, key));
      }
      return results;
    },

    /**
     * Removes delivered or failed rows older than `days`.
     *
     * @param {number} days
     * @returns {Promise<void>}
     */
    async purge(days) {
      await ctx
        .knex(T.hooksOut)
        .whereIn('status', ['delivered', 'failed'])
        .andWhere('created_at', '<', ctx.now() - days * 86_400_000)
        .del();
    },
  };

  /**
   * @param {object} row - claimed delivery
   * @param {string} url
   * @param {string} key
   * @returns {Promise<string>}
   */
  async function deliver(row, url, key) {
    const attempt = Number(row.attempts) + 1;
    const body = JSON.stringify({
      id: row.document_id,
      event: row.event,
      data: parseJson(row.payload, {}),
      at: Number(row.created_at),
    });
    let code;
    if (!(await urlAllowed(url))) code = 'URL_REFUSED';
    else {
      const timestamp = Math.floor(ctx.now() / 1000);
      try {
        const response = await (ctx.fetchImpl || globalThis.fetch)(url, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
          headers: {
            'content-type': 'application/json',
            'user-agent': 'magic-messagegate-webhook/1',
            'x-messagegate-event': row.event,
            'x-messagegate-delivery': row.document_id,
            'x-messagegate-timestamp': String(timestamp),
            'x-messagegate-signature': signDelivery(key, timestamp, body),
          },
          body,
        });
        await response.arrayBuffer().catch(() => null);
        if (response.status >= 200 && response.status < 300) code = null;
        else code = `HTTP_${response.status}`;
      } catch (error) {
        code = error?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK';
      }
    }
    const fence = ctx.knex(T.hooksOut).where({ id: row.id, lease_token: row.lease_token });
    if (!code) {
      await fence.update({
        status: 'delivered',
        attempts: attempt,
        delivered_at: ctx.now(),
        last_code: null,
        lease_token: null,
        lease_until: null,
      });
      return 'delivered';
    }
    if (attempt >= MAX_ATTEMPTS || code === 'URL_REFUSED') {
      await fence.update({
        status: 'failed',
        attempts: attempt,
        last_code: code,
        lease_token: null,
        lease_until: null,
      });
      ctx.log.warn(`[magic-messagegate] outgoing webhook ${row.document_id} failed: ${code}`);
      return 'failed';
    }
    await fence.update({
      attempts: attempt,
      last_code: code,
      next_attempt_at: ctx.now() + RETRY_MS[attempt - 1],
      lease_token: null,
      lease_until: null,
    });
    return 'retry';
  }

  return api;
}

module.exports = { createHooksOut, signDelivery, EVENT_MAP };
