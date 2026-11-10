'use strict';

/**
 * Template rendering for WhatsApp, Telegram and SMS.
 *
 * Placeholders: named `{{first_name}}` (lowercase letters, digits after the
 * first character, underscores) or positional `{{1}}`, matching Meta's
 * `parameter_format` (https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview.md).
 * Variables are plain text only: control characters are removed, and for
 * Telegram (parse_mode HTML) they are HTML-escaped so a variable can never
 * inject markup. WhatsApp body parameters may not contain new lines, tabs or
 * more than four consecutive spaces, so those are normalised.
 */
const { z } = require('zod');

const NAMED = /\{\{\s*([a-z][a-z0-9_]{0,59})\s*\}\}/g;
const POSITIONAL = /\{\{\s*([1-9][0-9]?)\s*\}\}/g;
// eslint-disable-next-line no-control-regex -- strips C0 controls, DEL, zero-width and bidi override characters
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;
const GSM7 =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXT = '^{}\\[~]|€';

/**
 * Lists the placeholders used in a text, in order of first appearance.
 *
 * @param {string} text
 * @param {'named'|'positional'} format
 * @returns {string[]}
 */
function placeholders(text, format) {
  const re = format === 'positional' ? POSITIONAL : NAMED;
  const found = [];
  for (const match of String(text || '').matchAll(re)) {
    if (!found.includes(match[1])) found.push(match[1]);
  }
  return found;
}

/**
 * Collects every placeholder of a template's content.
 *
 * @param {{channel: string, parameterFormat?: string, content: object}} template
 * @returns {string[]}
 */
function templateVariables(template) {
  const format = template.parameterFormat === 'positional' ? 'positional' : 'named';
  const c = template.content || {};
  const texts = [c.header?.format === 'TEXT' ? c.header.text : '', c.body, c.text];
  for (const button of c.buttons || []) {
    if (button.type === 'URL') texts.push(button.url);
  }
  const names = [];
  for (const text of texts) {
    for (const name of placeholders(text, format)) if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Builds the zod schema for a template's variable definitions.
 *
 * @param {Array<{name: string, required?: boolean, maxLength?: number}>} definitions
 * @returns {import('zod').ZodObject<any>}
 */
function variablesSchema(definitions) {
  const shape = {};
  for (const def of definitions || []) {
    const max = Math.min(Math.max(Number(def.maxLength) || 1024, 1), 1024);
    let field = z.union([z.string(), z.number(), z.boolean()]).transform(String).pipe(z.string().max(max));
    if (def.required !== false) field = field.refine((v) => v.trim().length > 0, { message: 'required' });
    else field = field.optional();
    shape[def.name] = field;
  }
  return z.object(shape).strict();
}

/**
 * Removes control and bidi-override characters.
 *
 * @param {string} value
 * @returns {string}
 */
const clean = (value) => String(value ?? '').replace(CONTROL, '');

/**
 * @param {string} value
 * @returns {string}
 */
const escapeHtml = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * WhatsApp parameter text rules: no new lines or tabs, at most four spaces in a row.
 *
 * @param {string} value
 * @returns {string}
 */
const whatsappParam = (value) =>
  clean(value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {5,}/g, '    ');

/**
 * Replaces placeholders in a text.
 *
 * @param {string} text
 * @param {Record<string,string>} values
 * @param {'named'|'positional'} format
 * @param {(v: string) => string} [encode]
 * @returns {string}
 */
function fill(text, values, format, encode = (v) => v) {
  const re = format === 'positional' ? POSITIONAL : NAMED;
  return String(text || '').replace(re, (_, name) => encode(values[name] ?? ''));
}

/**
 * SMS length: GSM-7 (160/153) or UCS-2 (70/67) segments.
 *
 * @param {string} text
 * @returns {{encoding: 'GSM-7'|'UCS-2', characters: number, segments: number}}
 */
function smsSegments(text) {
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
 * Visible length of Telegram HTML (tags removed, entities counted as one).
 *
 * @param {string} html
 * @returns {number}
 */
const telegramVisibleLength = (html) =>
  [
    ...String(html)
      .replace(/<[^>]*>/g, '')
      .replace(/&(?:#\d+|#x[0-9a-f]+|[a-z]+);/gi, '_'),
  ].length;

/**
 * Validates variables and renders a template for its channel.
 *
 * @param {{channel: string, key: string, language: string, parameterFormat?: string, content: object, variables: Array<object>}} template
 * @param {Record<string, unknown>} input
 * @returns {{payload: object, preview: string, sms?: object}}
 * @throws {{code: 'MISSING_VARIABLE'|'INVALID_VARIABLE', details: object}}
 */
function render(template, input) {
  const format = template.parameterFormat === 'positional' ? 'positional' : 'named';
  const parsed = variablesSchema(template.variables).safeParse(input || {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = String(issue?.path?.[0] ?? '');
    const given = input && Object.prototype.hasOwnProperty.call(input, field) ? input[field] : undefined;
    const missing =
      issue?.code !== 'unrecognized_keys' && (given === undefined || given === null || issue?.message === 'required');
    const error = new Error(missing ? 'MISSING_VARIABLE' : 'INVALID_VARIABLE');
    error.code = missing ? 'MISSING_VARIABLE' : 'INVALID_VARIABLE';
    error.details = { field: field.slice(0, 60) };
    throw error;
  }
  const values = Object.fromEntries(Object.entries(parsed.data).map(([k, v]) => [k, clean(v)]));
  const c = template.content || {};

  if (template.channel === 'whatsapp') {
    const param = (name) =>
      format === 'named'
        ? { type: 'text', parameter_name: name, text: whatsappParam(values[name] ?? '') }
        : { type: 'text', text: whatsappParam(values[name] ?? '') };
    const components = [];
    if (c.header?.format === 'TEXT') {
      const names = placeholders(c.header.text, format);
      if (names.length) components.push({ type: 'header', parameters: names.map(param) });
    } else if (c.header && ['IMAGE', 'DOCUMENT', 'VIDEO'].includes(c.header.format) && c.header.mediaId) {
      const kind = c.header.format.toLowerCase();
      components.push({ type: 'header', parameters: [{ type: kind, [kind]: { id: String(c.header.mediaId) } }] });
    }
    const bodyNames = placeholders(c.body, format);
    if (bodyNames.length) components.push({ type: 'body', parameters: bodyNames.map(param) });
    (c.buttons || []).forEach((button, index) => {
      if (button.type === 'URL') {
        const names = placeholders(button.url, format);
        if (names.length) {
          components.push({
            type: 'button',
            sub_type: 'url',
            index: String(index),
            parameters: [{ type: 'text', text: whatsappParam(values[names[0]] ?? '') }],
          });
        }
      }
      if (button.type === 'COPY_CODE' && button.variable) {
        components.push({
          type: 'button',
          sub_type: 'copy_code',
          index: String(index),
          parameters: [{ type: 'coupon_code', coupon_code: whatsappParam(values[button.variable] ?? '').slice(0, 15) }],
        });
      }
    });
    const preview = [
      c.header?.format === 'TEXT' ? fill(c.header.text, values, format) : null,
      fill(c.body, values, format),
      c.footer || null,
    ]
      .filter(Boolean)
      .join('\n\n');
    return {
      payload: { kind: 'template', name: template.key, language: template.language, components },
      preview,
    };
  }

  if (template.channel === 'telegram') {
    // Telegram counts 4096 characters after entity parsing
    // (https://core.telegram.org/bots/api#sendmessage). Cutting HTML could
    // break a tag or entity, so an over-long result is refused instead.
    const text = fill(c.text, values, format, escapeHtml);
    if (telegramVisibleLength(text) > 4096) {
      const error = new Error('INVALID_VARIABLE');
      error.code = 'INVALID_VARIABLE';
      error.details = { field: 'text', reason: 'too_long' };
      throw error;
    }
    return { payload: { text }, preview: fill(c.text, values, format) };
  }

  const text = fill(c.text, values, format).slice(0, 1600);
  return { payload: { text }, preview: text, sms: smsSegments(text) };
}

module.exports = {
  telegramVisibleLength,
  placeholders,
  templateVariables,
  variablesSchema,
  render,
  smsSegments,
  escapeHtml,
  clean,
};
