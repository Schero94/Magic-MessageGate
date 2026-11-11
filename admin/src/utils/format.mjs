/**
 * Number and rate formatting helpers (pure, testable).
 */

/**
 * @param {number | null | undefined} rate - Ratio between 0 and 1.
 * @returns {string} Percentage like "87.5 %" or an em dash.
 */
export function formatRate(rate, locale = 'en') {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return '–';
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(rate);
}

/**
 * Start of the current day in local time, as epoch milliseconds.
 *
 * @param {number} [now] - Epoch milliseconds.
 * @returns {number} Midnight.
 */
export function startOfDay(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Range presets for analytics.
 *
 * @param {'today' | '7d' | '30d' | '90d'} preset - Preset.
 * @param {number} [now] - Epoch milliseconds.
 * @returns {{from: number, to: number}} Range.
 */
export function rangeFor(preset, now = Date.now()) {
  const day = 86_400_000;
  const to = now + 60_000;
  if (preset === 'today') return { from: startOfDay(now), to };
  const days = preset === '7d' ? 7 : preset === '90d' ? 90 : 30;
  return { from: startOfDay(now - (days - 1) * day), to };
}
