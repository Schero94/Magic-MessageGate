/**
 * Template editor model: defaults, variable sync and validation. Limits
 * mirror server/src/core/templates.js (WhatsApp: header 60, body 1024,
 * footer 60, button text 25, 10 buttons; Telegram 4096; SMS 1600).
 */
import { templateVariables } from './templatePreview.mjs';

export const LIMITS = { header: 60, body: 1024, footer: 60, button: 25, buttons: 10, telegram: 4096, sms: 1600 };
export const KEY_PATTERN = /^[a-z][a-z0-9_]{0,119}$/;
export const LANGUAGE_PATTERN = /^[a-z]{2,3}(_[A-Z]{2})?$/;
export const CATEGORIES = ['UTILITY', 'MARKETING', 'AUTHENTICATION'];
export const HEADER_FORMATS = ['NONE', 'TEXT', 'IMAGE', 'DOCUMENT', 'VIDEO'];
export const BUTTON_TYPES = ['QUICK_REPLY', 'URL', 'COPY_CODE'];

/**
 * @param {'whatsapp' | 'telegram' | 'sms'} channel - Channel.
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
    content: channel === 'whatsapp' ? { body: '' } : { text: '' },
    variables: [],
  };
}

/**
 * Content shape for another channel, keeping the main text.
 *
 * @param {object} draft - Draft.
 * @param {'whatsapp' | 'telegram' | 'sms'} channel - New channel.
 * @returns {object} Draft.
 */
export function switchChannel(draft, channel) {
  const text = draft.content?.body ?? draft.content?.text ?? '';
  return { ...draft, channel, content: channel === 'whatsapp' ? { body: text } : { text } };
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
 * @param {object} draft - Draft.
 * @param {{ forSubmit?: boolean }} [options] - Also require examples (Meta review needs them).
 * @returns {Record<string, 'required' | 'invalid' | 'tooLong' | 'https' | 'example'>} Errors by path.
 */
export function validateTemplate(draft, { forSubmit = false } = {}) {
  const errors = {};
  const len = (value) => String(value || '').length;
  if (!String(draft.name || '').trim()) errors.name = 'required';
  if (!draft.key) errors.key = 'required';
  else if (!KEY_PATTERN.test(draft.key)) errors.key = 'invalid';
  if (!LANGUAGE_PATTERN.test(String(draft.language || ''))) errors.language = 'invalid';
  const c = draft.content || {};
  if (draft.channel === 'whatsapp') {
    if (!String(c.body || '').trim()) errors['content.body'] = 'required';
    else if (len(c.body) > LIMITS.body) errors['content.body'] = 'tooLong';
    if (c.header?.format === 'TEXT') {
      if (!String(c.header.text || '').trim()) errors['content.header.text'] = 'required';
      else if (len(c.header.text) > LIMITS.header) errors['content.header.text'] = 'tooLong';
    }
    if (
      c.header &&
      ['IMAGE', 'DOCUMENT', 'VIDEO'].includes(c.header.format) &&
      c.header.mediaId &&
      !/^\d{1,30}$/.test(c.header.mediaId)
    )
      errors['content.header.mediaId'] = 'invalid';
    if (len(c.footer) > LIMITS.footer) errors['content.footer'] = 'tooLong';
    (c.buttons || []).forEach((b, i) => {
      if (!String(b.text || '').trim()) errors[`content.buttons.${i}.text`] = 'required';
      else if (len(b.text) > LIMITS.button) errors[`content.buttons.${i}.text`] = 'tooLong';
      if (b.type === 'URL') {
        if (!b.url) errors[`content.buttons.${i}.url`] = 'required';
        else if (!/^https:\/\/[^\s]+$/.test(b.url)) errors[`content.buttons.${i}.url`] = 'https';
      }
    });
    if (forSubmit)
      for (const v of syncVariables(draft))
        if (!String(v.example || '').trim()) errors[`variables.${v.name}.example`] = 'example';
  } else {
    const max = draft.channel === 'telegram' ? LIMITS.telegram : LIMITS.sms;
    if (!String(c.text || '').trim()) errors['content.text'] = 'required';
    else if (len(c.text) > max) errors['content.text'] = 'tooLong';
  }
  return errors;
}

/**
 * Request body for create (full) or update (no key, channel, language).
 *
 * @param {object} draft - Draft.
 * @param {boolean} isNew - Create or update.
 * @returns {object} Body.
 */
export function templatePayload(draft, isNew) {
  const c = draft.content || {};
  let content;
  if (draft.channel === 'whatsapp') {
    content = { body: c.body };
    if (c.header && c.header.format && c.header.format !== 'NONE') {
      content.header = { format: c.header.format };
      if (c.header.format === 'TEXT') content.header.text = c.header.text;
      else if (c.header.mediaId) content.header.mediaId = c.header.mediaId;
    }
    if (String(c.footer || '').trim()) content.footer = c.footer;
    if (c.buttons?.length)
      content.buttons = c.buttons.map((b) => {
        const out = { type: b.type, text: b.text };
        if (b.type === 'URL') out.url = b.url;
        if (b.type === 'COPY_CODE' && b.variable) out.variable = b.variable;
        return out;
      });
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
