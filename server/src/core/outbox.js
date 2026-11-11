'use strict';

/**
 * Durable outbox with exactly-once dispatch across processes.
 *
 * Life of a message (status / phase):
 *   queued/queued ──claim──> queued/claimed ──dispatch──> queued/dispatching
 *     ├─ accepted  → sent/done ─webhook→ delivered → read      (failed possible after sent)
 *     ├─ transient → queued/queued with next_attempt_at (backoff) or failed when attempts/deadline are used up
 *     ├─ rejected  → failed/done (fallback to the next channel when eligible)
 *     └─ ambiguous → uncertain/done (never re-sent automatically; an admin decides)
 *   queued past not_after → expired;  discarded by an admin → discarded
 *
 * Claiming (same design as Magic Mail's outbox):
 * - PostgreSQL: UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING
 *   https://www.postgresql.org/docs/16/sql-select.html#SQL-FOR-UPDATE-SHARE
 * - MySQL 8: transaction + SELECT … FOR UPDATE SKIP LOCKED, then UPDATE.
 * - SQLite: one conditional UPDATE per candidate; the affected-row count
 *   decides the winner (SQLite serialises writers).
 * Every later state change is fenced by the lease token, so a process that
 * lost its lease can never overwrite the result of another one.
 */
const crypto = require('crypto');
const { T } = require('../store/schema');
const { affected, acquireLease, hit } = require('../store/coordination');
const { seal, tryOpen, logRef } = require('../utils/crypto');
const { MessageGateError } = require('../utils/errors');
const { newId, parseJson } = require('./context');

const PAYLOAD = 'message-payload';
const TERMINAL = new Set(['delivered', 'read', 'failed', 'expired', 'discarded']);
const RANK = { queued: 0, uncertain: 1, sent: 2, delivered: 3, read: 4 };

/**
 * @param {import('./context').CoreContext} ctx
 * @param {{accounts: object, contacts: object}} deps
 */
function createOutbox(ctx, deps) {
  /** Called with the failed row when a terminal failure may trigger a fallback. */
  let onFailure = async () => {};

  const token = () => crypto.randomBytes(16).toString('hex');

  /**
   * @param {number} messageId
   * @param {string} type
   * @param {string|null} [code]
   * @param {number} [at]
   * @param {*} [trx]
   */
  async function event(messageId, type, code = null, at = ctx.now(), trx = ctx.knex) {
    await trx(T.events).insert({ message_id: messageId, type, code: code ? String(code).slice(0, 64) : null, at });
  }

  /**
   * @param {object} row
   * @param {string} status
   * @param {string|null} [code]
   */
  function emit(row, status, code = null) {
    ctx.emit(`messagegate.message.${status}`, {
      messageId: row.document_id,
      channel: row.channel,
      templateKey: row.template_key || null,
      status,
      code: code || undefined,
      at: ctx.now(),
    });
  }

  /**
   * @param {object} row
   * @returns {object} Admin DTO (no payload, no phone number).
   */
  function toDto(row) {
    return {
      id: row.document_id,
      status: row.status,
      phase: row.phase,
      channel: row.channel,
      accountId: row.account_id ?? null,
      templateKey: row.template_key || null,
      contactId: row.contact_id ?? null,
      attempts: Number(row.attempts),
      maxAttempts: Number(row.max_attempts),
      nextAttemptAt: Number(row.next_attempt_at),
      notAfter: Number(row.not_after),
      providerMessageId: row.provider_message_id || null,
      errorCode: row.error_code || null,
      errorHistory: parseJson(row.error_history, []),
      fallbackOf: row.fallback_of ?? null,
      source: row.source,
      transactional: Boolean(row.transactional),
      costCategory: row.cost_category || null,
      metadata: parseJson(row.metadata, null),
      hasPayload: Boolean(row.payload_sealed),
      sentAt: row.sent_at ? Number(row.sent_at) : null,
      deliveredAt: row.delivered_at ? Number(row.delivered_at) : null,
      readAt: row.read_at ? Number(row.read_at) : null,
      failedAt: row.failed_at ? Number(row.failed_at) : null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  /**
   * Backoff with jitter for retry number `n` (1-based).
   *
   * @param {number} n
   * @param {number|null} retryAfterMs
   * @returns {number}
   */
  function delayFor(n, retryAfterMs) {
    const delays = ctx.config.retry.delaysMs;
    const base = delays[Math.min(n - 1, delays.length - 1)];
    const jitter = ctx.config.retry.jitter;
    const value = Math.round(base * (1 - jitter + ctx.random() * 2 * jitter));
    return Math.max(value, retryAfterMs || 0);
  }

  /**
   * Claims due messages for this process.
   *
   * @param {number} limit
   * @returns {Promise<object[]>} Claimed rows (with lease_token set).
   */
  async function claim(limit) {
    const now = ctx.now();
    const leaseToken = token();
    const leaseUntil = now + ctx.config.worker.leaseMs;
    const values = {
      phase: 'claimed',
      lease_token: leaseToken,
      lease_until: leaseUntil,
      claimed_by: ctx.nodeId.slice(0, 64),
      updated_at: now,
    };
    const due = (q) =>
      q
        .from(T.messages)
        .where({ status: 'queued', phase: 'queued' })
        .andWhere('next_attempt_at', '<=', now)
        .orderBy([{ column: 'priority' }, { column: 'next_attempt_at' }, { column: 'id' }])
        .limit(limit);

    if (ctx.dialect === 'postgres') {
      return ctx
        .knex(T.messages)
        .whereIn('id', (sub) => due(sub.select('id')).forUpdate().skipLocked())
        .update(values)
        .returning('*');
    }
    if (ctx.dialect === 'mysql') {
      return ctx.knex.transaction(async (trx) => {
        const ids = (await due(trx.select('id')).forUpdate().skipLocked()).map((r) => r.id);
        if (!ids.length) return [];
        await trx(T.messages).whereIn('id', ids).update(values);
        return trx(T.messages).whereIn('id', ids).andWhere('lease_token', leaseToken);
      });
    }
    const candidates = (await due(ctx.knex.select('id'))).map((r) => r.id);
    const won = [];
    for (const id of candidates) {
      const result = await ctx.knex(T.messages).where({ id, status: 'queued', phase: 'queued' }).update(values);
      if (affected(result) === 1) won.push(id);
    }
    if (!won.length) return [];
    return ctx.knex(T.messages).whereIn('id', won).andWhere('lease_token', leaseToken);
  }

  /**
   * Fenced update: only applies while this process still holds the lease.
   *
   * @param {object} row
   * @param {object} values
   * @returns {Promise<boolean>}
   */
  async function fenced(row, values) {
    const result = await ctx
      .knex(T.messages)
      .where({ id: row.id, lease_token: row.lease_token })
      .update({ ...values, updated_at: ctx.now() });
    return affected(result) === 1;
  }

  /**
   * @param {object} row
   * @param {string} code
   * @returns {string}
   */
  function pushHistory(row, code) {
    const history = parseJson(row.error_history, []);
    history.push({ at: ctx.now(), code: String(code).slice(0, 64), attempt: Number(row.attempts) });
    return JSON.stringify(history.slice(-10));
  }

  /**
   * Picks the accounts to try for a message.
   *
   * @param {object} row
   * @returns {Promise<object[]>}
   */
  async function accountsFor(row) {
    if (row.account_id) {
      const pinned = await deps.accounts.getRowById(row.account_id);
      return pinned && pinned.is_active ? [pinned] : [];
    }
    return deps.accounts.forChannel(row.channel);
  }

  /**
   * Ends a message as failed and runs the failure hook (fallback, suppression).
   *
   * @param {object} row
   * @param {string} code
   * @param {object} [extra]
   * @returns {Promise<void>}
   */
  async function fail(row, code, extra = {}) {
    const now = ctx.now();
    const ok = await fenced(row, {
      status: 'failed',
      phase: 'done',
      failed_at: now,
      error_code: String(code).slice(0, 64),
      error_history: pushHistory(row, code),
      lease_token: null,
      lease_until: null,
      ...extra,
    });
    if (!ok) return;
    await event(row.id, 'failed', code, now);
    emit(row, 'failed', code);
    await onFailure({ ...row, status: 'failed', error_code: code }, code);
  }

  /**
   * Sends one claimed message.
   *
   * @param {object} row - A row returned by `claim` (lease held).
   * @returns {Promise<string>} The resulting status.
   */
  async function dispatch(row) {
    const now = ctx.now();
    if (Number(row.not_after) <= now) {
      if (
        await fenced(row, {
          status: 'expired',
          phase: 'done',
          error_code: 'DEADLINE_PASSED',
          lease_token: null,
          lease_until: null,
        })
      ) {
        await event(row.id, 'expired', 'DEADLINE_PASSED', now);
        emit(row, 'expired', 'DEADLINE_PASSED');
      }
      return 'expired';
    }
    const accounts = await accountsFor(row);
    if (!accounts.length) {
      await fail(row, 'NO_ACCOUNT');
      return 'failed';
    }
    const sealed = tryOpen(row.payload_sealed, PAYLOAD, ctx.encryptionKey);
    if (!sealed) {
      await fail(row, row.payload_sealed ? 'PAYLOAD_UNREADABLE' : 'PAYLOAD_PURGED');
      return 'failed';
    }

    // Per-account rate limit (shared by all processes): defer without
    // spending an attempt when the account is at its limit.
    const first = accounts[0];
    const limits = parseJson(first.limits, {});
    if (limits.perSecond) {
      const second = Math.floor(now / 1000);
      const hits = await hit(ctx.knex, `rate:${first.id}:${second}`, 2_000, 1, now);
      if (hits > limits.perSecond) {
        await fenced(row, { phase: 'queued', next_attempt_at: now + 1_000, lease_token: null, lease_until: null });
        return 'queued';
      }
    }

    const attempt = Number(row.attempts) + 1;
    if (!(await fenced(row, { phase: 'dispatching', attempts: attempt }))) return 'lost';
    row.attempts = attempt;

    let result = null;
    let usedAccount = null;
    for (const account of accounts) {
      const adapter = ctx.adapter(account.provider);
      const config = deps.accounts.configOf(account);
      const settings = ctx.config.providers[account.provider] || {};
      const statusCallbackUrl =
        account.provider === 'twilio' && ctx.publicUrl
          ? `${ctx.publicUrl}/api/magic-messagegate/webhooks/twilio/${account.webhook_path}`
          : undefined;
      try {
        result = await adapter.send({
          config,
          to: sealed.to,
          payload: sealed.payload,
          channel: row.channel,
          messageId: row.document_id,
          statusCallbackUrl,
          settings,
          fetchImpl: ctx.fetchImpl,
        });
      } catch (error) {
        result = {
          outcome: 'ambiguous',
          code: String(error?.code || 'ADAPTER_ERROR').slice(0, 64),
          providerMessageId: null,
        };
      }
      usedAccount = account;
      if (result.outcome === 'accepted') {
        await deps.accounts.setHealth(account.id, true, null);
        break;
      }
      if (result.accountProblem) await deps.accounts.setHealth(account.id, false, result.code);
      // Only move on to the next account when the provider certainly did not
      // take the message (throttled/unreachable) or the account itself is broken.
      const tryNext = result.outcome === 'transient' || (result.outcome === 'rejected' && result.accountProblem);
      if (!tryNext) break;
    }

    const done = ctx.now();
    if (result.outcome === 'accepted') {
      const ok = await fenced(row, {
        status: 'sent',
        phase: 'done',
        sent_at: done,
        account_id: usedAccount.id,
        provider_message_id: result.providerMessageId ? String(result.providerMessageId).slice(0, 128) : null,
        error_code: null,
        lease_token: null,
        lease_until: null,
      });
      if (ok) {
        await event(row.id, 'sent', null, done);
        emit(row, 'sent');
        ctx.log.debug(`[magic-messagegate] sent ${row.document_id} via ${usedAccount.provider}`);
        // Sandbox mode: apply the simulated provider statuses through the
        // same path as real webhooks.
        for (const update of Array.isArray(result.simulated) ? result.simulated : []) {
          await api.applyProviderStatus({
            providerMessageId: result.providerMessageId,
            status: update.status,
            code: update.code || null,
            at: ctx.now(),
          });
        }
      }
      return 'sent';
    }

    if (result.outcome === 'transient') {
      const nextAt = done + delayFor(attempt, result.retryAfterMs);
      if (attempt < Number(row.max_attempts) && nextAt < Number(row.not_after)) {
        const ok = await fenced(row, {
          status: 'queued',
          phase: 'queued',
          next_attempt_at: nextAt,
          error_code: result.code,
          error_history: pushHistory(row, result.code),
          lease_token: null,
          lease_until: null,
        });
        if (ok) await event(row.id, 'retry-scheduled', result.code, done);
        return 'queued';
      }
      await fail(row, result.code || 'RETRIES_EXHAUSTED', { account_id: usedAccount.id });
      return 'failed';
    }

    if (result.outcome === 'rejected') {
      if (result.blocked && row.contact_id) await deps.contacts.suppress(row.contact_id, 'telegram', 'blocked_bot');
      await fail(row, result.code || 'REJECTED', { account_id: usedAccount.id });
      return 'failed';
    }

    const ok = await fenced(row, {
      status: 'uncertain',
      phase: 'done',
      account_id: usedAccount.id,
      error_code: result.code || 'AMBIGUOUS',
      error_history: pushHistory(row, result.code || 'AMBIGUOUS'),
      lease_token: null,
      lease_until: null,
    });
    if (ok) {
      await event(row.id, 'uncertain', result.code, done);
      emit(row, 'uncertain', result.code);
      ctx.log.warn(
        `[magic-messagegate] message ${row.document_id} uncertain (${result.code}); not retried automatically`
      );
    }
    return 'uncertain';
  }

  const api = {
    toDto,
    TERMINAL,

    /** @param {(row: object, code: string) => Promise<void>} fn */
    setFailureHandler(fn) {
      onFailure = fn;
    },

    /**
     * Inserts a message. A repeated idempotency key returns the first row.
     *
     * @param {object} input
     * @returns {Promise<{row: object, duplicate: boolean}>}
     */
    async enqueue(input) {
      const now = ctx.now();
      const row = {
        document_id: newId(),
        status: 'queued',
        phase: 'queued',
        channel: input.channel,
        account_id: input.accountId ?? null,
        template_id: input.templateId ?? null,
        template_key: input.templateKey ?? null,
        contact_id: input.contactId ?? null,
        payload_sealed: seal(
          { to: input.to, payload: input.payload, seed: input.seed || null },
          PAYLOAD,
          ctx.encryptionKey
        ),
        attempts: 0,
        max_attempts: input.maxAttempts ?? ctx.config.retry.delaysMs.length + 1,
        next_attempt_at: now,
        not_after: input.notAfter,
        not_after_fixed: Boolean(input.notAfterFixed),
        idempotency_hash: input.idempotencyHash ?? null,
        chain: JSON.stringify(input.chain || []),
        fallback_of: input.fallbackOf ?? null,
        source: input.source || 'api',
        cost_category: input.costCategory ?? null,
        transactional: Boolean(input.transactional),
        metadata: input.metadata ? JSON.stringify(input.metadata).slice(0, 4000) : null,
        priority: input.priority ?? 100,
        created_at: now,
        updated_at: now,
      };
      try {
        await ctx.knex(T.messages).insert(row);
      } catch (error) {
        if (row.idempotency_hash) {
          const existing = await ctx.knex(T.messages).where('idempotency_hash', row.idempotency_hash).first();
          if (existing) return { row: existing, duplicate: true };
        }
        throw error;
      }
      const saved = await ctx.knex(T.messages).where('document_id', row.document_id).first();
      await event(saved.id, 'queued', null, now);
      emit(saved, 'queued');
      return { row: saved, duplicate: false };
    },

    /** Decrypted payload (server side only). */
    payloadOf: (row) => tryOpen(row.payload_sealed, PAYLOAD, ctx.encryptionKey),

    claim,
    dispatch,

    /**
     * One worker round: claim a batch and dispatch with bounded concurrency.
     *
     * @returns {Promise<{claimed: number, results: string[]}>}
     */
    async tick() {
      const rows = await claim(ctx.config.worker.batchSize);
      const results = [];
      let index = 0;
      const lanes = Array.from({ length: Math.min(ctx.config.worker.concurrency, rows.length) }, async () => {
        while (index < rows.length) {
          const row = rows[index];
          index += 1;
          try {
            results.push(await dispatch(row));
          } catch (error) {
            ctx.log.error(`[magic-messagegate] dispatch failed for ${row.document_id}: ${error?.name || 'Error'}`);
            results.push('error');
          }
        }
      });
      await Promise.all(lanes);
      return { claimed: rows.length, results };
    },

    /**
     * Recovers expired leases and expires overdue queued messages. Runs under
     * a database lease so only one process does it per interval.
     *
     * @returns {Promise<{released: number, uncertain: number, expired: number}|null>}
     */
    async maintain() {
      const now = ctx.now();
      if (!(await acquireLease(ctx.knex, 'outbox-maintenance', ctx.nodeId.slice(0, 64), 30_000, now))) return null;
      const released = affected(
        await ctx
          .knex(T.messages)
          .where({ status: 'queued', phase: 'claimed' })
          .andWhere('lease_until', '<', now)
          .update({ phase: 'queued', lease_token: null, lease_until: null, updated_at: now })
      );
      const stuck = await ctx
        .knex(T.messages)
        .where({ status: 'queued', phase: 'dispatching' })
        .andWhere('lease_until', '<', now)
        .limit(500);
      let uncertain = 0;
      for (const row of stuck) {
        const ok = affected(
          await ctx.knex(T.messages).where({ id: row.id, lease_token: row.lease_token, phase: 'dispatching' }).update({
            status: 'uncertain',
            phase: 'done',
            error_code: 'LEASE_EXPIRED_DURING_SEND',
            lease_token: null,
            lease_until: null,
            updated_at: now,
          })
        );
        if (ok) {
          uncertain += 1;
          await event(row.id, 'uncertain', 'LEASE_EXPIRED_DURING_SEND', now);
          emit(row, 'uncertain', 'LEASE_EXPIRED_DURING_SEND');
        }
      }
      const overdue = await ctx
        .knex(T.messages)
        .where({ status: 'queued', phase: 'queued' })
        .andWhere('not_after', '<=', now)
        .limit(500);
      let expired = 0;
      for (const row of overdue) {
        const ok = affected(
          await ctx.knex(T.messages).where({ id: row.id, status: 'queued', phase: 'queued' }).update({
            status: 'expired',
            phase: 'done',
            error_code: 'DEADLINE_PASSED',
            updated_at: now,
          })
        );
        if (ok) {
          expired += 1;
          await event(row.id, 'expired', 'DEADLINE_PASSED', now);
          emit(row, 'expired', 'DEADLINE_PASSED');
        }
      }
      return { released, uncertain, expired };
    },

    /**
     * Applies a provider status (webhook). Statuses only move forward;
     * `failed` after `sent` is accepted, `failed` after delivery is ignored.
     *
     * @param {{providerMessageId: string, status: 'sent'|'delivered'|'read'|'failed', at?: number, code?: string|null}} update
     * @returns {Promise<object|null>} The updated row or null.
     */
    async applyProviderStatus(update) {
      if (!update.providerMessageId) return null;
      const row = await ctx
        .knex(T.messages)
        .where('provider_message_id', String(update.providerMessageId).slice(0, 128))
        .first();
      if (!row) return null;
      const at = Number(update.at) || ctx.now();
      const current = row.status;
      if (update.status === 'failed') {
        if (!['sent', 'uncertain', 'queued'].includes(current)) return row;
        const ok = affected(
          await ctx
            .knex(T.messages)
            .where({ id: row.id, status: current })
            .update({
              status: 'failed',
              phase: 'done',
              failed_at: at,
              error_code: String(update.code || 'PROVIDER_FAILED').slice(0, 64),
              error_history: pushHistory(row, update.code || 'PROVIDER_FAILED'),
              updated_at: ctx.now(),
            })
        );
        if (!ok) return row;
        await event(row.id, 'failed', update.code, at);
        emit(row, 'failed', update.code);
        const failed = await ctx.knex(T.messages).where('id', row.id).first();
        await onFailure(failed, update.code || 'PROVIDER_FAILED');
        return failed;
      }
      const target = update.status;
      if (!(target in RANK) || current === 'failed' || current === 'discarded' || current === 'expired') return row;
      if (RANK[target] <= (RANK[current] ?? 0)) return row;
      const values = { status: target, updated_at: ctx.now() };
      if (target === 'sent' && !row.sent_at) values.sent_at = at;
      if (target === 'delivered' || target === 'read') {
        values.delivered_at = row.delivered_at || at;
        values.payload_sealed = null;
        if (!row.sent_at) values.sent_at = at;
      }
      if (target === 'read') values.read_at = at;
      const ok = affected(await ctx.knex(T.messages).where({ id: row.id, status: current }).update(values));
      if (!ok) return row;
      await event(row.id, target, null, at);
      emit(row, target);
      if (row.contact_id && (target === 'delivered' || target === 'read')) {
        await deps.contacts.touch(row.contact_id, target === 'read' ? 'read' : 'delivered', at);
        if (target === 'read') await deps.contacts.touch(row.contact_id, 'delivered', at);
        if (row.channel === 'whatsapp') await deps.contacts.setWhatsappReachability(row.contact_id, 'ok');
        if (row.channel === 'rcs') await deps.contacts.setRcsCapability(row.contact_id, 'capable');
      }
      return ctx.knex(T.messages).where('id', row.id).first();
    },

    /**
     * @param {string} documentId
     * @returns {Promise<object|null>}
     */
    async getRow(documentId) {
      return (await ctx.knex(T.messages).where('document_id', String(documentId).slice(0, 32)).first()) || null;
    },

    /**
     * Message with its status timeline.
     *
     * @param {string} documentId
     * @returns {Promise<object>}
     */
    async detail(documentId) {
      const row = await api.getRow(documentId);
      if (!row) throw new MessageGateError('NOT_FOUND');
      const events = await ctx
        .knex(T.events)
        .where('message_id', row.id)
        .orderBy([{ column: 'at' }, { column: 'id' }]);
      const fallbacks = await ctx
        .knex(T.messages)
        .where('fallback_of', row.id)
        .select('document_id', 'channel', 'status');
      const recipients = await deps.contacts.recipientsByIds([row.contact_id]);
      return {
        ...toDto(row),
        recipient: recipients.get(row.contact_id) || null,
        timeline: events.map((e) => ({ type: e.type, code: e.code || null, at: Number(e.at) })),
        fallbacks: fallbacks.map((f) => ({ id: f.document_id, channel: f.channel, status: f.status })),
      };
    },

    /**
     * Paginated, filtered list.
     *
     * @param {{page?: number, pageSize?: number, status?: string, channel?: string, templateKey?: string, accountId?: number, from?: number, to?: number}} query
     * @returns {Promise<{results: object[], pagination: object}>}
     */
    async list(query = {}) {
      const page = Math.max(1, Math.min(Number(query.page) || 1, 2000));
      const pageSize = Math.max(1, Math.min(Number(query.pageSize) || 25, 100));
      const q = ctx.knex(T.messages);
      if (query.status) q.where('status', query.status);
      if (query.channel) q.where('channel', query.channel);
      if (query.templateKey) q.where('template_key', query.templateKey);
      if (query.accountId) q.where('account_id', query.accountId);
      if (query.from) q.where('created_at', '>=', Number(query.from));
      if (query.to) q.where('created_at', '<', Number(query.to));
      if (query.phone) {
        const contactId = await deps.contacts.idByPhone(query.phone, query.country || ctx.config.defaultCountry);
        q.where('contact_id', contactId ?? -1);
      }
      const [{ total }] = await q.clone().count({ total: '*' });
      const rows = await q
        .orderBy('id', 'desc')
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      const recipients = await deps.contacts.recipientsByIds(rows.map((r) => r.contact_id));
      return {
        results: rows.map((r) => ({ ...toDto(r), recipient: recipients.get(r.contact_id) || null })),
        pagination: { page, pageSize, total: Number(total), pageCount: Math.ceil(Number(total) / pageSize) },
      };
    },

    /**
     * Admin: schedules a failed, uncertain or expired message again.
     *
     * @param {string} documentId
     * @param {{confirmDuplicateRisk?: boolean}} [options]
     * @returns {Promise<object>} DTO
     */
    async retry(documentId, { confirmDuplicateRisk = false } = {}) {
      const row = await api.getRow(documentId);
      if (!row) throw new MessageGateError('NOT_FOUND');
      if (!['failed', 'uncertain', 'expired'].includes(row.status)) throw new MessageGateError('STATE_CHANGED');
      if (row.status === 'uncertain' && !confirmDuplicateRisk) throw new MessageGateError('CONFIRMATION_REQUIRED');
      if (!row.payload_sealed) throw new MessageGateError('PAYLOAD_PURGED');
      const now = ctx.now();
      if (row.not_after_fixed && Number(row.not_after) <= now) throw new MessageGateError('DEADLINE_PASSED');
      const notAfter = row.not_after_fixed
        ? Number(row.not_after)
        : Math.max(Number(row.not_after), now + ctx.config.defaultNotAfterHours * 3_600_000);
      const ok = affected(
        await ctx
          .knex(T.messages)
          .where({ id: row.id, status: row.status })
          .update({
            status: 'queued',
            phase: 'queued',
            next_attempt_at: now,
            not_after: notAfter,
            max_attempts: Number(row.attempts) + 1,
            lease_token: null,
            lease_until: null,
            updated_at: now,
          })
      );
      if (!ok) throw new MessageGateError('STATE_CHANGED');
      await event(row.id, 'retry-requested', null, now);
      return toDto(await api.getRow(documentId));
    },

    /**
     * Admin: discards a queued, failed, uncertain or expired message.
     *
     * @param {string} documentId
     * @returns {Promise<object>}
     */
    async discard(documentId) {
      const row = await api.getRow(documentId);
      if (!row) throw new MessageGateError('NOT_FOUND');
      if (
        !['queued', 'failed', 'uncertain', 'expired'].includes(row.status) ||
        (row.status === 'queued' && row.phase !== 'queued')
      ) {
        throw new MessageGateError('STATE_CHANGED');
      }
      const now = ctx.now();
      const ok = affected(
        await ctx
          .knex(T.messages)
          .where({ id: row.id, status: row.status, phase: row.phase })
          .update({ status: 'discarded', phase: 'done', payload_sealed: null, updated_at: now })
      );
      if (!ok) throw new MessageGateError('STATE_CHANGED');
      await event(row.id, 'discarded', null, now);
      emit(row, 'discarded');
      return toDto(await api.getRow(documentId));
    },

    /**
     * Admin: resolves an uncertain message as sent (the recipient confirmed it).
     *
     * @param {string} documentId
     * @returns {Promise<object>}
     */
    async markSent(documentId) {
      const row = await api.getRow(documentId);
      if (!row) throw new MessageGateError('NOT_FOUND');
      if (row.status !== 'uncertain') throw new MessageGateError('STATE_CHANGED');
      const now = ctx.now();
      const ok = affected(
        await ctx
          .knex(T.messages)
          .where({ id: row.id, status: 'uncertain' })
          .update({ status: 'sent', sent_at: now, payload_sealed: null, updated_at: now })
      );
      if (!ok) throw new MessageGateError('STATE_CHANGED');
      await event(row.id, 'marked-sent', null, now);
      return toDto(await api.getRow(documentId));
    },

    /**
     * Retention: removes old messages, events and webhook receipts.
     *
     * @param {{messageDays: number, receiptDays: number}} retention
     * @returns {Promise<{messages: number, receipts: number}|null>}
     */
    async purge(retention) {
      const now = ctx.now();
      if (!(await acquireLease(ctx.knex, 'retention', ctx.nodeId.slice(0, 64), 10 * 60_000, now))) return null;
      const cutoff = now - retention.messageDays * 86_400_000;
      // Ids are read first: MySQL rejects LIMIT inside IN subqueries and
      // deleting from a table that the subquery reads.
      const ids = (
        await ctx
          .knex(T.messages)
          .select('id')
          .where('created_at', '<', cutoff)
          .whereIn('status', [...TERMINAL, 'uncertain', 'sent'])
          .limit(5000)
      ).map((r) => r.id);
      let messages = 0;
      if (ids.length) {
        await ctx.knex(T.events).whereIn('message_id', ids).del();
        messages = affected(await ctx.knex(T.messages).whereIn('id', ids).del());
      }
      const receipts = affected(
        await ctx
          .knex(T.receipts)
          .where('received_at', '<', now - retention.receiptDays * 86_400_000)
          .del()
      );
      await ctx
        .knex(T.linkTokens)
        .where('expires_at', '<', now - 86_400_000)
        .del();
      await ctx.knex(T.counters).where('expires_at', '<', now).del();
      await ctx.knex(T.attachmentLinks).where('expires_at', '<', now).del();
      await ctx
        .knex(T.numberChecks)
        .where('checked_at', '<', now - 365 * 86_400_000)
        .del();
      return { messages, receipts };
    },

    /** Log helper without PII. */
    ref: (row) => logRef(row?.document_id),
  };
  return api;
}

module.exports = { createOutbox, TERMINAL };
