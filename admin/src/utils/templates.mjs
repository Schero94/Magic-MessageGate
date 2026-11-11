/**
 * Template editor model: defaults, variable sync and validation. Limits
 * mirror server/src/core/templates.js (WhatsApp: header 60, body 1024,
 * footer 60, button text 25, 10 buttons; RCS: text 1600, title 200, 4
 * buttons with titles up to 25 (quick reply 20); Telegram: 4096, 8 buttons
 * with titles up to 40; SMS 1600).
 */
import { templateVariables } from './templatePreview.mjs';

export const LIMITS = {
  header: 60,
  body: 1024,
  footer: 60,
  button: 25,
  buttons: 10,
  telegram: 4096,
  telegramButton: 40,
  telegramButtons: 8,
  sms: 1600,
  rcs: 1600,
  rcsTitle: 200,
  rcsButton: 25,
  rcsQuickReply: 20,
  rcsButtons: 4,
};
export const KEY_PATTERN = /^[a-z][a-z0-9_]{0,119}$/;
export const LANGUAGE_PATTERN = /^[a-z]{2,3}(_[A-Z]{2})?$/;
/** Button payload (WhatsApp quick reply, RCS quick reply id, Telegram callback data). */
export const PAYLOAD_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
/** Phone number of an RCS call button (E.164). */
export const PHONE_PATTERN = /^\+\d{6,16}$/;
const HTTPS_PATTERN = /^https:\/\/[^\s]+$/;
export const CATEGORIES = ['UTILITY', 'MARKETING', 'AUTHENTICATION'];
export const HEADER_FORMATS = ['NONE', 'TEXT', 'IMAGE', 'DOCUMENT', 'VIDEO'];
export const MEDIA_HEADER_FORMATS = ['IMAGE', 'DOCUMENT', 'VIDEO'];
export const BUTTON_TYPES = ['QUICK_REPLY', 'URL', 'COPY_CODE'];
export const RCS_BUTTON_TYPES = ['URL', 'PHONE_NUMBER', 'QUICK_REPLY'];

/**
 * Text field of a channel's content: `body` on WhatsApp, `text` elsewhere.
 *
 * @param {string} channel - Channel.
 * @returns {'body' | 'text'} Field name.
 */
export const textFieldOf = (channel) => (channel === 'whatsapp' ? 'body' : 'text');

/**
 * Character limit of the main text per channel.
 *
 * @param {string} channel - Channel.
 * @returns {number} Limit.
 */
export const textLimitOf = (channel) =>
  ({ whatsapp: LIMITS.body, rcs: LIMITS.rcs, telegram: LIMITS.telegram })[channel] ?? LIMITS.sms;

/**
 * Whether an RCS template is a rich card that needs a Twilio Content template
 * (it has a title or buttons). Plain text, optionally with an image, is sent
 * directly and approved on save.
 *
 * @param {{channel?: string, content?: object}} template - Template or draft.
 * @returns {boolean} Needs "Create on Twilio".
 */
export function rcsNeedsContent(template) {
  if (template?.channel !== 'rcs') return false;
  const c = template.content || {};
  return Boolean(String(c.title || '').trim() || c.buttons?.length);
}

/**
 * @param {'whatsapp' | 'rcs' | 'telegram' | 'sms'} channel - Channel.
 * @param {string} [language] - Default language.
 * @returns {object} New draft.
 */
export function emptyTemplate(channel = 'whatsapp', language = 'en') {
  return {
    key: '',
    name: '',
    channel,
    language,
    category: 'UTILITY',
    parameterFormat: 'named',
    isActive: true,
    content: { [textFieldOf(channel)]: '' },
    variables: [],
  };
}

/**
 * Content shape for another channel, keeping the main text.
 *
 * @param {object} draft - Draft.
 * @param {'whatsapp' | 'rcs' | 'telegram' | 'sms'} channel - New channel.
 * @returns {object} Draft.
 */
export function switchChannel(draft, channel) {
  const text = draft.content?.body ?? draft.content?.text ?? '';
  return { ...draft, channel, content: { [textFieldOf(channel)]: text } };
}

/**
 * Keeps one variable definition per placeholder in the content, in order,
 * preserving label, example and limits of existing ones.
 *
 * @param {object} draft - Draft.
 * @returns {Array<{name: string, label?: string, example?: string, required: boolean, maxLength: number}>} Variables.
 */
export function syncVariables(draft) {
  const names = templateVariables(draft);
  for (const b of draft.content?.buttons || [])
    if (b.type === 'COPY_CODE' && b.variable && !names.includes(b.variable)) names.push(b.variable);
  const given = new Map((draft.variables || []).map((v) => [v.name, v]));
  return names.map((name) => ({ required: true, maxLength: 256, ...(given.get(name) || {}), name }));
}

/**
 * Checks a required text against its limit.
 *
 * @param {object} errors - Collected errors (mutated).
 * @param {string} path - Error path.
 * @param {string} value - Text.
 * @param {number} max - Limit.
 * @returns {void}
 */
function checkText(errors, path, value, max) {
  if (!String(value || '').trim()) errors[path] = 'required';
  else if (String(value).length > max) errors[path] = 'tooLong';
}

/**
 * @param {object} draft - Draft.
 * @param {{ forSubmit?: boolean }} [options] - Also require examples (Meta review needs them).
 * @returns {Record<string, 'required' | 'invalid' | 'tooLong' | 'https' | 'example' | 'phone' | 'payload' | 'sampleFile'>} Errors by path.
 */
export function validateTemplate(draft, { forSubmit = false } = {}) {
  const errors = {};
  const len = (value) => String(value || '').length;
  if (!String(draft.name || '').trim()) errors.name = 'required';
  if (!draft.key) errors.key = 'required';
  else if (!KEY_PATTERN.test(draft.key)) errors.key = 'invalid';
  if (!LANGUAGE_PATTERN.test(String(draft.language || ''))) errors.language = 'invalid';
  const c = draft.content || {};
  const payload = (b, i) => {
    if (b.payload && !PAYLOAD_PATTERN.test(b.payload)) errors[`content.buttons.${i}.payload`] = 'payload';
  };
  const https = (value, path) => {
    if (!value) errors[path] = 'required';
    else if (!HTTPS_PATTERN.test(value)) errors[path] = 'https';
  };
  if (draft.channel === 'whatsapp') {
    checkText(errors, 'content.body', c.body, LIMITS.body);
    if (c.header?.format === 'TEXT') checkText(errors, 'content.header.text', c.header.text, LIMITS.header);
    if (c.header && MEDIA_HEADER_FORMATS.includes(c.header.format)) {
      // Meta needs a sample of the media on submit; the server uploads this file.
      if (c.header.fileId == null) {
        if (forSubmit) errors['content.header.fileId'] = 'sampleFile';
      } else if (!Number.isInteger(c.header.fileId) || c.header.fileId < 1) errors['content.header.fileId'] = 'invalid';
    }
    if (len(c.footer) > LIMITS.footer) errors['content.footer'] = 'tooLong';
    (c.buttons || []).forEach((b, i) => {
      checkText(errors, `content.buttons.${i}.text`, b.text, LIMITS.button);
      if (b.type === 'URL') https(b.url, `content.buttons.${i}.url`);
      if (b.type === 'QUICK_REPLY') payload(b, i);
    });
    if (forSubmit)
      for (const v of syncVariables(draft))
        if (!String(v.example || '').trim()) errors[`variables.${v.name}.example`] = 'example';
  } else if (draft.channel === 'rcs') {
    checkText(errors, 'content.text', c.text, LIMITS.rcs);
    if (len(c.title) > LIMITS.rcsTitle) errors['content.title'] = 'tooLong';
    if (c.mediaUrl && !HTTPS_PATTERN.test(c.mediaUrl)) errors['content.mediaUrl'] = 'https';
    (c.buttons || []).forEach((b, i) => {
      checkText(
        errors,
        `content.buttons.${i}.title`,
        b.title,
        b.type === 'QUICK_REPLY' ? LIMITS.rcsQuickReply : LIMITS.rcsButton
      );
      if (b.type === 'URL') https(b.url, `content.buttons.${i}.url`);
      if (b.type === 'PHONE_NUMBER') {
        if (!b.phone) errors[`content.buttons.${i}.phone`] = 'required';
        else if (!PHONE_PATTERN.test(b.phone)) errors[`content.buttons.${i}.phone`] = 'phone';
      }
      if (b.type === 'QUICK_REPLY') payload(b, i);
    });
  } else if (draft.channel === 'telegram') {
    checkText(errors, 'content.text', c.text, LIMITS.telegram);
    (c.buttons || []).forEach((b, i) => {
      checkText(errors, `content.buttons.${i}.title`, b.title, LIMITS.telegramButton);
      if (!b.payload) errors[`content.buttons.${i}.payload`] = 'required';
      else payload(b, i);
    });
  } else checkText(errors, 'content.text', c.text, LIMITS.sms);
  return errors;
}

/**
 * Content to send for a WhatsApp template.
 *
 * @param {object} c - Draft content.
 * @returns {object} Content.
 */
function whatsappPayload(c) {
  const content = { body: c.body };
  if (c.header && c.header.format && c.header.format !== 'NONE') {
    content.header = { format: c.header.format };
    if (c.header.format === 'TEXT') content.header.text = c.header.text;
    else {
      // mediaId is no longer edited here but kept when it was stored before.
      if (c.header.mediaId) content.header.mediaId = c.header.mediaId;
      if (c.header.fileId != null) content.header.fileId = c.header.fileId;
    }
  }
  if (String(c.footer || '').trim()) content.footer = c.footer;
  if (c.buttons?.length)
    content.buttons = c.buttons.map((b) => {
      const out = { type: b.type, text: b.text };
      if (b.type === 'URL') out.url = b.url;
      if (b.type === 'COPY_CODE' && b.variable) out.variable = b.variable;
      if (b.type === 'QUICK_REPLY' && b.payload) out.payload = b.payload;
      return out;
    });
  return content;
}

/**
 * Card fields of an RCS template, without the server-owned Content SID and
 * variable order.
 *
 * @param {object} c - Draft content.
 * @returns {object} Card content.
 */
function rcsCard(c) {
  const content = { text: c.text };
  if (String(c.title || '').trim()) content.title = c.title;
  if (String(c.mediaUrl || '').trim()) content.mediaUrl = c.mediaUrl.trim();
  if (c.buttons?.length)
    content.buttons = c.buttons.map((b) => {
      const out = { type: b.type, title: b.title };
      if (b.type === 'URL') out.url = b.url;
      if (b.type === 'PHONE_NUMBER') out.phone = b.phone;
      if (b.type === 'QUICK_REPLY' && b.payload) out.payload = b.payload;
      return out;
    });
  return content;
}

/**
 * Whether two RCS contents describe the same card. A changed card no longer
 * matches its Twilio Content template, so saving drops the SID (DRAFT again).
 *
 * @param {object} a - Content.
 * @param {object} b - Content.
 * @returns {boolean} Same card.
 */
export function sameRcsCard(a, b) {
  return JSON.stringify(rcsCard(a || {})) === JSON.stringify(rcsCard(b || {}));
}

/**
 * Request body for create (full) or update (no key, channel, language).
 * The RCS Content SID and variable order are sent back unchanged; the server
 * drops them when the card changed.
 *
 * @param {object} draft - Draft.
 * @param {boolean} isNew - Create or update.
 * @returns {object} Body.
 */
export function templatePayload(draft, isNew) {
  const c = draft.content || {};
  let content;
  if (draft.channel === 'whatsapp') content = whatsappPayload(c);
  else if (draft.channel === 'rcs') {
    content = rcsCard(c);
    if (c.contentSid) content.contentSid = c.contentSid;
    if (c.variableOrder) content.variableOrder = c.variableOrder;
  } else if (draft.channel === 'telegram') {
    content = { text: c.text };
    if (c.buttons?.length) content.buttons = c.buttons.map((b) => ({ title: b.title, payload: b.payload }));
  } else content = { text: c.text };
  const variables = syncVariables(draft).map((v) => {
    const out = { name: v.name, required: v.required !== false, maxLength: Number(v.maxLength) || 256 };
    if (String(v.label || '').trim()) out.label = v.label.trim();
    if (String(v.example || '').trim()) out.example = v.example;
    return out;
  });
  const body = {
    name: draft.name.trim(),
    category: draft.category,
    parameterFormat: draft.parameterFormat,
    content,
    variables,
    isActive: draft.isActive,
  };
  return isNew ? { ...body, key: draft.key, channel: draft.channel, language: draft.language } : body;
}
