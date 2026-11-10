'use strict';

/**
 * Aggregates for the analytics page: volume, delivery rate and read rate per
 * channel and template, failures by code. Rates are computed from messages
 * created in the range; read rates are a lower bound on WhatsApp (recipients
 * can switch read receipts off).
 */
const { T } = require('../store/schema');

/**
 * @param {import('./context').CoreContext} ctx
 */
function createAnalytics(ctx) {
  /**
   * @param {object} group
   * @returns {object}
   */
  function rates(group) {
    const sent = Number(group.sent || 0);
    const delivered = Number(group.delivered || 0);
    const read = Number(group.read || 0);
    return {
      ...group,
      deliveryRate: sent ? Math.round((delivered / sent) * 1000) / 10 : null,
      readRate: delivered ? Math.round((read / delivered) * 1000) / 10 : null,
    };
  }

  return {
    /**
     * @param {{from?: number, to?: number}} range
     * @returns {Promise<object>}
     */
    async summary({ from, to } = {}) {
      const end = Number(to) || ctx.now() + 1;
      const start = Number(from) || end - 30 * 86_400_000;
      const base = () => ctx.knex(T.messages).where('created_at', '>=', start).andWhere('created_at', '<', end);
      const sums = (q) =>
        q
          .count({ total: '*' })
          .select(
            ctx.knex.raw('SUM(CASE WHEN sent_at IS NOT NULL THEN 1 ELSE 0 END) as sent_count'),
            ctx.knex.raw('SUM(CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END) as delivered_count'),
            ctx.knex.raw('SUM(CASE WHEN read_at IS NOT NULL THEN 1 ELSE 0 END) as read_count'),
            ctx.knex.raw("SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count"),
            ctx.knex.raw("SUM(CASE WHEN status = 'uncertain' THEN 1 ELSE 0 END) as uncertain_count")
          );
      // Aliases avoid reserved words (READ is reserved in MySQL).
      const num = (row) =>
        Object.fromEntries(
          Object.entries(row).map(([k, v]) => [
            k.replace(/_count$/, ''),
            typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v === null ? 0 : v,
          ])
        );
      const [totals] = await sums(base());
      const byChannel = await sums(base().select('channel')).groupBy('channel');
      const byTemplate = await sums(base().select('template_key').whereNotNull('template_key'))
        .groupBy('template_key')
        .limit(100);
      const failures = await base()
        .where('status', 'failed')
        .select('error_code')
        .count({ total: '*' })
        .groupBy('error_code')
        .orderBy('total', 'desc')
        .limit(10);
      const queue = await ctx
        .knex(T.messages)
        .whereIn('status', ['queued', 'uncertain'])
        .select('status')
        .count({ total: '*' })
        .groupBy('status');
      return {
        range: { from: start, to: end },
        totals: rates(num(totals)),
        byChannel: byChannel.map((r) => rates(num(r))),
        byTemplate: byTemplate.map((r) => rates(num(r))),
        failures: failures.map((r) => ({ code: r.error_code || 'UNKNOWN', total: Number(r.total) })),
        queue: Object.fromEntries(queue.map((r) => [r.status, Number(r.total)])),
      };
    },
  };
}

module.exports = { createAnalytics };
