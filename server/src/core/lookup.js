'use strict';

/**
 * Number pre-check.
 *
 * 1. Always: local parsing to E.164 with the number type (free).
 * 2. Optional: Twilio Lookup v2 line type intelligence (paid per request),
 *    cached per number hash for `cacheDays` and capped by a monthly budget
 *    shared by all processes.
 * 3. Learned: WhatsApp reachability from earlier sends (error 131026 marks a
 *    number as not on WhatsApp).
 *
 * No official API tells whether a number uses WhatsApp before a message is
 * sent, or whether the person is online; MessageGate does not pretend to.
 */
const { T } = require('../store/schema');
const { hit } = require('../store/coordination');
const { getAdapter } = require('../adapters');
const { parsePhone } = require('../utils/phone');
const { hashValue } = require('../utils/crypto');
const { MessageGateError } = require('../utils/errors');
const { parseJson } = require('./context');

/**
 * @param {import('./context').CoreContext} ctx
 * @param {{settings: object, accounts: object}} deps
 */
function createLookup(ctx, deps) {
  return {
    /**
     * @param {string} phone
     * @param {{remote?: boolean}} [options]
     * @returns {Promise<object>}
     */
    async check(phone, { remote = true } = {}) {
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
        };
      const phoneHash = hashValue(parsed.e164, 'contact-phone', ctx.encryptionKey);
      const contact = await ctx
        .knex(T.contacts)
        .where('phone_hash', phoneHash)
        .first('wa_reachability', 'wa_reachability_at');
      const result = {
        valid: true,
        e164: parsed.e164,
        country: parsed.country,
        type: parsed.type,
        mobile: parsed.mobile,
        whatsapp: contact?.wa_reachability || 'unknown',
        remote: null,
      };
      if (!remote || !settings.lookup.enabled || !settings.lookup.accountId) return result;

      const cached = await ctx.knex(T.lookups).where('phone_hash', phoneHash).first();
      if (cached && Number(cached.checked_at) > ctx.now() - settings.lookup.cacheDays * 86_400_000) {
        return { ...result, remote: { ...parseJson(cached.result, {}), cached: true } };
      }
      const account = await deps.accounts.getRow(settings.lookup.accountId);
      if (!account || account.provider !== 'twilio') throw new MessageGateError('LOOKUP_DISABLED');
      const month = new Date(ctx.now()).toISOString().slice(0, 7);
      const budgetKey = `lookup-budget:${month}`;
      // Count first, then compare: the atomic increment keeps parallel
      // processes from overshooting the paid budget.
      const used = await hit(ctx.knex, budgetKey, 32 * 86_400_000, 1, ctx.now());
      if (used > settings.lookup.monthlyBudget) throw new MessageGateError('LOOKUP_BUDGET_EXCEEDED');
      const answer = await getAdapter('twilio').lookup({
        config: deps.accounts.configOf(account),
        e164: parsed.e164,
        settings: ctx.config.providers.twilio,
        fetchImpl: ctx.fetchImpl,
      });
      if (!answer.ok) return { ...result, remote: { ok: false, code: answer.code } };
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
      return { ...result, remote: remoteResult };
    },
  };
}

module.exports = { createLookup };
