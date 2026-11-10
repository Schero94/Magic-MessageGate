/**
 * Client-side template preview. Mirrors server/src/utils/template-engine.js
 * (placeholder syntax and SMS segment rules) so the editor can preview
 * unsaved changes. The server render stays authoritative on send.
 */

const NAMED = /\{\{\s*([a-z][a-z0-9_]{0,59})\s*\}\}/g;
const POSITIONAL = /\{\{\s*([1-9][0-9]?)\s*\}\}/g;
const GSM7 =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXT = '^{}\\[~]|€';

/**
 * Placeholders in a text, in order of first appearance.
 *
 * @param {string} text - Template text.
 * @param {'named' | 'positional'} [format] - Placeholder style.
 * @returns {string[]} Names.
 */
export function placeholders(text, format = 'named') {
  const re = format === 'positional' ? POSITIONAL : NAMED;
  const found = [];
  for (const match of String(text || '').matchAll(re)) if (!found.includes(match[1])) found.push(match[1]);
  return found;
}

/**
 * Every placeholder of a template's content (header text, body or text, URL buttons).
 *
 * @param {{channel: string, parameterFormat?: string, content: object}} template - Template.
 * @returns {string[]} Names.
 */
export function templateVariables(template) {
  const format = template.parameterFormat === 'positional' ? 'positional' : 'named';
  const c = template.content || {};
  const texts = [c.header?.format === 'TEXT' ? c.header.text : '', c.body, c.text];
  for (const button of c.buttons || []) if (button.type === 'URL') texts.push(button.url);
  const names = [];
  for (const text of texts) for (const name of placeholders(text, format)) if (!names.includes(name)) names.push(name);
  return names;
}

/**
 * Splits a text into plain and placeholder parts for highlighted rendering.
 * A placeholder is replaced by its value, else its example, else kept as `{{name}}`.
 *
 * @param {string} text - Template text.
 * @param {Record<string, string>} values - Variable values.
 * @param {Record<string, string>} examples - Example values.
 * @param {'named' | 'positional'} [format] - Placeholder style.
 * @returns {Array<{text: string, variable?: string, filled?: boolean}>} Parts.
 */
export function previewParts(text, values = {}, examples = {}, format = 'named') {
  const re = format === 'positional' ? POSITIONAL : NAMED;
  const parts = [];
  let last = 0;
  const source = String(text || '');
  for (const match of source.matchAll(re)) {
    if (match.index > last) parts.push({ text: source.slice(last, match.index) });
    const name = match[1];
    const value = values[name] || examples[name];
    parts.push({ text: value ? String(value) : `{{${name}}}`, variable: name, filled: Boolean(value) });
    last = match.index + match[0].length;
  }
  if (last < source.length) parts.push({ text: source.slice(last) });
  return parts;
}

/**
 * Plain rendered text.
 *
 * @param {string} text - Template text.
 * @param {Record<string, string>} values - Values.
 * @param {Record<string, string>} examples - Examples.
 * @param {'named' | 'positional'} [format] - Placeholder style.
 * @returns {string} Text.
 */
export function renderText(text, values, examples, format) {
  return previewParts(text, values, examples, format)
    .map((p) => p.text)
    .join('');
}

/**
 * SMS length: GSM-7 (160/153 per segment) or UCS-2 (70/67).
 *
 * @param {string} text - Rendered text.
 * @returns {{encoding: 'GSM-7' | 'UCS-2', characters: number, segments: number}} Info.
 */
export function smsSegments(text) {
  const value = String(text || '');
  let units = 0;
  let gsm = true;
  for (const ch of value) {
    if (GSM7.includes(ch)) units += 1;
    else if (GSM7_EXT.includes(ch)) units += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm) return { encoding: 'GSM-7', characters: units, segments: units <= 160 ? 1 : Math.ceil(units / 153) };
  const chars = [...value].reduce((n, ch) => n + (ch.codePointAt(0) > 0xffff ? 2 : 1), 0);
  return { encoding: 'UCS-2', characters: chars, segments: chars <= 70 ? 1 : Math.ceil(chars / 67) };
}

/**
 * Template key from a display name: lowercase, digits and underscores.
 *
 * @param {string} name - Display name.
 * @returns {string} Key (may be empty).
 */
export function keyFromName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .replace(/_+$/, '')
    .slice(0, 120);
}
