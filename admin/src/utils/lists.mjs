/**
 * Validation of list entries edited with TagListField. Mirrors the server
 * settings schema (server/src/core/settings.js), so a value accepted here is
 * accepted on save.
 */

const RULES = {
  keyword: /^\S(.{0,22}\S)?$/,
  country: /^[A-Z]{2}$/,
  templateKey: /^[a-z][a-z0-9_]{0,119}$/,
  tag: /^[A-Za-z0-9_.:-]{1,40}$/,
};

/**
 * @param {'keyword' | 'country' | 'templateKey' | 'tag'} kind - Rule.
 * @param {string} value - Trimmed candidate.
 * @param {string[]} list - Existing entries.
 * @returns {null | 'required' | 'invalid' | 'duplicate'} Error code or null.
 */
export function validateListEntry(kind, value, list = []) {
  if (!value) return 'required';
  const rule = RULES[kind];
  if (!rule || !rule.test(value)) return 'invalid';
  const normalised = kind === 'keyword' ? value.toUpperCase() : value;
  if (list.some((entry) => (kind === 'keyword' ? entry.toUpperCase() : entry) === normalised)) return 'duplicate';
  return null;
}
