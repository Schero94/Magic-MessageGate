/**
 * Settings form model. Bounds mirror server/src/core/settings.js.
 */

export const BOUNDS = {
  cacheDays: [1, 365],
  monthlyBudget: [0, 1_000_000],
  messageDays: [1, 3650],
  receiptDays: [1, 90],
  linkTtlHours: [1, 720],
  retentionDays: [1, 3650],
  replyWindowHours: [1, 720],
  maxMb: [1, 100],
};

/** Outgoing webhook events (mirror server HOOK_EVENTS). */
export const HOOK_EVENTS = ['message.received', 'message.status', 'media.ready', 'media.failed'];

const inRange = (value, [min, max]) => Number.isInteger(value) && value >= min && value <= max;

/**
 * @param {object} s - Settings draft.
 * @returns {Record<string, 'required' | 'invalid' | 'range' | 'emptyChain' | 'duplicate' | 'https'>} Errors by path.
 */
export function validateSettings(s) {
  const errors = {};
  if (!/^[A-Z]{2}$/.test(String(s.defaultCountry || ''))) errors.defaultCountry = 'invalid';
  if (!s.routing?.defaultChain?.length) errors['routing.defaultChain'] = 'emptyChain';
  const ids = new Set();
  (s.routing?.rules || []).forEach((rule, i) => {
    if (!String(rule.name || '').trim()) errors[`routing.rules.${i}.name`] = 'required';
    if (!rule.chain?.length) errors[`routing.rules.${i}.chain`] = 'emptyChain';
    if (ids.has(rule.id)) errors[`routing.rules.${i}.name`] = 'duplicate';
    ids.add(rule.id);
  });
  if (s.fallback?.emailEnabled && !s.fallback.emailTemplateReferenceId)
    errors['fallback.emailTemplateReferenceId'] = 'required';
  if (!inRange(s.lookup?.cacheDays, BOUNDS.cacheDays)) errors['lookup.cacheDays'] = 'range';
  if (!inRange(s.lookup?.monthlyBudget, BOUNDS.monthlyBudget)) errors['lookup.monthlyBudget'] = 'range';
  if (s.lookup?.enabled && !s.lookup.accountId) errors['lookup.accountId'] = 'required';
  if (s.lookup?.hlrEnabled && !s.lookup.hlrAccountId) errors['lookup.hlrAccountId'] = 'required';
  if (!inRange(s.attachments?.linkTtlHours, BOUNDS.linkTtlHours)) errors['attachments.linkTtlHours'] = 'range';
  if (!inRange(s.inbound?.retentionDays, BOUNDS.retentionDays)) errors['inbound.retentionDays'] = 'range';
  if (!inRange(s.inbound?.replyWindowHours, BOUNDS.replyWindowHours)) errors['inbound.replyWindowHours'] = 'range';
  if (!inRange(s.inboundMedia?.maxMb, BOUNDS.maxMb)) errors['inboundMedia.maxMb'] = 'range';
  const hook = s.outgoingWebhook || {};
  if (hook.enabled && !hook.url) errors['outgoingWebhook.url'] = 'required';
  else if (hook.url && !/^https:\/\/[^\s/]+\.[^\s]+$/.test(hook.url)) errors['outgoingWebhook.url'] = 'https';
  if (!inRange(s.retention?.messageDays, BOUNDS.messageDays)) errors['retention.messageDays'] = 'range';
  if (!inRange(s.retention?.receiptDays, BOUNDS.receiptDays)) errors['retention.receiptDays'] = 'range';
  return errors;
}

/**
 * Moves an entry of a channel chain.
 *
 * @param {string[]} chain - Chain.
 * @param {number} index - Entry.
 * @param {-1 | 1} direction - Up or down.
 * @returns {string[]} New chain.
 */
export function moveInChain(chain, index, direction) {
  const target = index + direction;
  if (target < 0 || target >= chain.length) return chain;
  const next = [...chain];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/**
 * New routing rule with a unique id.
 *
 * @param {Array<{id: string}>} rules - Existing rules.
 * @returns {object} Rule.
 */
export function newRule(rules = []) {
  let n = rules.length + 1;
  while (rules.some((r) => r.id === `rule_${n}`)) n += 1;
  return { id: `rule_${n}`, name: '', templateKeys: [], countries: [], tags: [], chain: ['whatsapp', 'rcs', 'sms'] };
}
