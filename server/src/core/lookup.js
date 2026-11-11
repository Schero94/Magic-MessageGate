'use strict';

/**
 * Number checks.
 *
 * 1. Always: local parsing to E.164 with the number type (free).
 * 2. Optional: Twilio Lookup v2 line type intelligence (paid per request).
 * 3. Optional: seven.io HLR lookup, "is the number assigned and registered
 *    in a mobile network" (paid per request).
 *    Paid results are cached per number hash for `cacheDays` in the database
 *    (shared by all processes) and capped by one monthly budget.
 * 4. Learned: WhatsApp reachability (error 131026 marks a number as not on
 *    WhatsApp) and RCS capability (Twilio error 63036 marks it as not RCS
 *    capable, an RCS delivery as capable).
 *
 * No official API tells whether a number uses WhatsApp before a message is
 * sent, or whether the person is online, and Twilio offers no RCS
 * capability lookup; MessageGate does not pretend otherwise.
 */
const { T } = require('../store/schema');
const { hit, peek } = require('../store/coordination');
const { parsePhone } = require('../utils/phone');
const { hashValue } = require('../utils/crypto');
const { MessageGateError } = require('../utils/errors');
const { parseJson } = require('./context');

/**
 * Maps seven.io HLR fields to `active`: true (assigned, in a network,
 * possibly switched off), false (not assigned / does not exist), null (unknown).
 *
 * @param {{valid: string|null, reachable: string|null}} hlr
 * @returns {boolean|null}
 */
function activeFromHlr(hlr) {
  if (hlr.valid === 'not_valid' || hlr.reachable === 'bad_number') return false;
  if (hlr.reachable === 'reachable' || hlr.reachable === 'absent') return true;
  if (hlr.valid === 'valid') return true;
  return null;
}

/**
 * @param {import('./context').CoreContext} ctx
 * @param {{settings: object, accounts: object, contacts: object}} deps
 */
function createLookup(ctx, deps) {
  const month = () => new Date(ctx.now()).toISOString().slice(0, 7);

  /**
   * Counts one paid lookup against the shared monthly budget.
   *
   * @param {object} settings
   * @returns {Promise<void>}
   * @throws {MessageGateError} LOOKUP_BUDGET_EXCEEDED
   */
  async function spend(settings) {
    // Count first, then compare: the atomic increment keeps parallel
    // processes from overshooting the paid budget.
    const used = await hit(ctx.knex, `lookup-budget:${month()}`, 32 * 86_400_000, 1, ctx.now());
    if (used > settings.lookup.monthlyBudget) throw new MessageGateError('LOOKUP_BUDGET_EXCEEDED');
  }

  /**
   * @param {string} phoneHash
   * @param {object} settings
   * @returns {Promise<object|null>} Fresh cached HLR result.
   */
  async function cachedHlr(phoneHash, settings) {
    const row = await ctx.knex(T.numberChecks).where({ phone_hash: phoneHash, kind: 'hlr' }).first();
    if (!row || Number(row.checked_at) <= ctx.now() - settings.lookup.cacheDays * 86_400_000) return null;
    return { ...parseJson(row.result, {}), cached: true };
  }

  /**
   * Runs (or reads from cache) the seven.io HLR lookup.
   *
   * @param {string} e164
   * @param {string} phoneHash
   * @param {object} settings
   * @param {{spendBudget?: boolean}} [options] - false: cache only, never paid.
   * @returns {Promise<object|null>}
   */
  async function hlr(e164, phoneHash, settings, { spendBudget = true } = {}) {
    if (!settings.lookup.hlrEnabled || !settings.lookup.hlrAccountId) {
      if (spendBudget) throw new MessageGateError('LOOKUP_DISABLED');
      return null;
    }
    const cached = await cachedHlr(phoneHash, settings);
    if (cached || !spendBudget) return cached;
    const account = await deps.accounts.getRow(settings.lookup.hlrAccountId);
    if (!account || account.provider !== 'seven') throw new MessageGateError('LOOKUP_DISABLED');
    await spend(settings);
    const answer = await ctx.adapter('seven').hlr({
      config: deps.accounts.configOf(account),
      e164,
      settings: ctx.config.providers.seven,
      fetchImpl: ctx.fetchImpl,
    });
    if (!answer.ok) return { ok: false, code: answer.code, active: null };
    const result = {
      ok: true,
      active: activeFromHlr(answer),
      valid: answer.valid,
      reachable: answer.reachable,
      ported: answer.ported,
      roaming: answer.roaming,
      network: answer.network,
      networkType: answer.networkType,
      checkedAt: ctx.now(),
    };
    const row = { phone_hash: phoneHash, kind: 'hlr', result: JSON.stringify(result), checked_at: ctx.now() };
    const updated = await ctx.knex(T.numberChecks).where({ phone_hash: phoneHash, kind: 'hlr' }).update(row);
    if (!updated) {
      try {
        await ctx.knex(T.numberChecks).insert(row);
      } catch {
        // parallel lookup stored it
      }
    }
    await deps.contacts.setLineActive(phoneHash, result.active, result.checkedAt);
    return result;
  }

  /**
   * Twilio line type intelligence (cached in mg_lookups).
   *
   * @param {string} e164
   * @param {string} phoneHash
   * @param {object} settings
   * @returns {Promise<object>}
   */
  async function lineType(e164, phoneHash, settings) {
    const cached = await ctx.knex(T.lookups).where('phone_hash', phoneHash).first();
    if (cached && Number(cached.checked_at) > ctx.now() - settings.lookup.cacheDays * 86_400_000) {
      return { ...parseJson(cached.result, {}), cached: true };
    }
    const account = await deps.accounts.getRow(settings.lookup.accountId);
    if (!account || account.provider !== 'twilio') throw new MessageGateError('LOOKUP_DISABLED');
    await spend(settings);
    const answer = await ctx.adapter('twilio').lookup({
      config: deps.accounts.configOf(account),
      e164,
      settings: ctx.config.providers.twilio,
      fetchImpl: ctx.fetchImpl,
    });
    if (!answer.ok) return { ok: false, code: answer.code };
    const remoteResult = {
      ok: true,
      valid: answer.valid,
      lineType: answer.lineType,
      code: answer.code,
      checkedAt: ctx.now(),
    };
    const row = { phone_hash: phoneHash, result: JSON.stringify(remoteResult), checked_at: ctx.now() };
    const updated = await ctx.knex(T.lookups).where('phone_hash', phoneHash).update(row);
    if (!updated) {
      try {
        await ctx.knex(T.lookups).insert(row);
      } catch {
        // parallel lookup stored it
      }
    }
    if (answer.lineType)
      await ctx
        .knex(T.contacts)
        .where('phone_hash', phoneHash)
        .update({ line_type: answer.lineType.slice(0, 24) });
    return remoteResult;
  }

  /**
   * @param {object} contact - contact row or undefined
   * @returns {'capable'|'not_capable'|'unknown'}
   */
  const rcsOf = (contact) => {
    if (!contact?.rcs_capability || contact.rcs_capability === 'unknown') return 'unknown';
    if (contact.rcs_capability === 'not_capable') {
      return deps.contacts.rcsKnownNotCapable(contact) ? 'not_capable' : 'unknown';
    }
    return 'capable';
  };

  const api = {
    activeFromHlr,

    /**
     * Number check. The free part always runs; paid parts only when asked
     * for and configured.
     *
     * @param {string} phone
     * @param {{remote?: boolean, hlr?: boolean, rcs?: boolean}} [options]
     *   remote: Twilio line type (default true, as in 1.0); hlr: seven.io HLR;
     *   rcs: include the learned RCS capability.
     * @returns {Promise<object>}
     * @throws {MessageGateError} LOOKUP_DISABLED (hlr requested but not configured), LOOKUP_BUDGET_EXCEEDED
     */
    async check(phone, { remote = true, hlr: wantHlr = false, rcs = false } = {}) {
      const settings = await deps.settings.get();
      const parsed = parsePhone(String(phone || ''), settings.defaultCountry);
      if (!parsed.valid)
        return {
          valid: false,
          e164: null,
          country: null,
          type: null,
          mobile: false,
          remote: null,
          whatsapp: 'unknown',
          ...(wantHlr ? { hlr: null } : {}),
          ...(rcs ? { rcs: 'unknown' } : {}),
        };
      const phoneHash = hashValue(parsed.e164, 'contact-phone', ctx.encryptionKey);
      const contact = await ctx.knex(T.contacts).where('phone_hash', phoneHash).first();
      const result = {
        valid: true,
        e164: parsed.e164,
        country: parsed.country,
        type: parsed.type,
        mobile: parsed.mobile,
        whatsapp: contact?.wa_reachability || 'unknown',
        remote: null,
      };
      if (rcs) result.rcs = rcsOf(contact);
      if (remote && settings.lookup.enabled && settings.lookup.accountId) {
        result.remote = await lineType(parsed.e164, phoneHash, settings);
      }
      if (wantHlr) result.hlr = await hlr(parsed.e164, phoneHash, settings);
      return result;
    },

    /**
     * What MessageGate knows about a number without any paid call: format,
     * number type, cached HLR, learned WhatsApp and RCS reachability and the
     * Telegram link.
     *
     * @param {string} phone
     * @returns {Promise<{valid: boolean, e164: string|null, type: string|null, active: boolean|null, whatsapp: string, rcs: string, telegramLinked: boolean, checkedAt: number|null}>}
     */
    async capabilities(phone) {
      const settings = await deps.settings.get();
      const parsed = parsePhone(String(phone || ''), settings.defaultCountry);
      if (!parsed.valid) {
        return {
          valid: false,
          e164: null,
          type: null,
          active: null,
          whatsapp: 'unknown',
          rcs: 'unknown',
          telegramLinked: false,
          checkedAt: null,
        };
      }
      const phoneHash = hashValue(parsed.e164, 'contact-phone', ctx.encryptionKey);
      const contact = await ctx.knex(T.contacts).where('phone_hash', phoneHash).first();
      const check = await cachedHlr(phoneHash, settings);
      const times = [check?.checkedAt, contact?.wa_reachability_at, contact?.rcs_capability_at]
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0);
      return {
        valid: true,
        e164: parsed.e164,
        type: parsed.type,
        active: check && typeof check.active === 'boolean' ? check.active : null,
        whatsapp: contact?.wa_reachability || 'unknown',
        rcs: rcsOf(contact),
        telegramLinked: Boolean(contact?.telegram_hash),
        checkedAt: times.length ? Math.max(...times) : null,
      };
    },

    /**
     * Whether sending should stop because the number is not assigned
     * (setting `lookup.blockInactiveNumbers`). Lookup problems never block.
     *
     * @param {string} e164
     * @param {{spendBudget?: boolean}} [options]
     * @returns {Promise<boolean>} true when HLR says the number is inactive.
     */
    async isInactive(e164, { spendBudget = true } = {}) {
      const settings = await deps.settings.get();
      if (!settings.lookup.blockInactiveNumbers) return false;
      const phoneHash = hashValue(e164, 'contact-phone', ctx.encryptionKey);
      try {
        const result = await hlr(e164, phoneHash, settings, { spendBudget });
        return result?.active === false;
      } catch (error) {
        ctx.log.warn(`[magic-messagegate] number check skipped: ${error?.code || error?.name || 'Error'}`);
        return false;
      }
    },

    /**
     * Lookup budget of the current month (for the admin).
     *
     * @returns {Promise<{enabled: boolean, hlrEnabled: boolean, month: string, used: number, budget: number, cacheDays: number}>}
     */
    async budgetStatus() {
      const settings = await deps.settings.get();
      const used = await peek(ctx.knex, `lookup-budget:${month()}`, ctx.now());
      return {
        enabled: Boolean(settings.lookup.enabled && settings.lookup.accountId),
        hlrEnabled: Boolean(settings.lookup.hlrEnabled && settings.lookup.hlrAccountId),
        month: month(),
        used: Math.min(used, settings.lookup.monthlyBudget),
        budget: settings.lookup.monthlyBudget,
        cacheDays: settings.lookup.cacheDays,
      };
    },
  };
  return api;
}

module.exports = { createLookup, activeFromHlr };
