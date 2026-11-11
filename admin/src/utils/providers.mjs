/**
 * Credential fields per provider and channel. Patterns mirror PROVIDER_CONFIG
 * in server/src/core/accounts.js so the wizard reports mistakes inline; the
 * server validates again. Generated values (verify token, Telegram secret)
 * are not asked for.
 */

/**
 * @typedef {object} ProviderField
 * @property {string} name - Config key.
 * @property {'text' | 'boolean'} [type] - Input type (default text).
 * @property {boolean} [secret] - Masked and stored encrypted.
 * @property {boolean} [required] - Must be set.
 * @property {RegExp} [pattern] - Expected format.
 * @property {string} [placeholder] - Example value.
 */

/** @type {ProviderField[]} */
const TWILIO_CREDENTIALS = [
  { name: 'accountSid', required: true, pattern: /^AC[0-9a-f]{32}$/, placeholder: 'AC…' },
  { name: 'authToken', secret: true, required: true, pattern: /^[0-9a-f]{32}$/ },
  { name: 'apiKeySid', pattern: /^SK[0-9a-f]{32}$/, placeholder: 'SK…' },
  { name: 'apiKeySecret', secret: true, pattern: /^\S{8,128}$/ },
];

/** @type {Record<string, ProviderField[]>} */
export const PROVIDER_FIELDS = {
  meta: [
    { name: 'phoneNumberId', required: true, pattern: /^\d{5,25}$/, placeholder: '106540352242922' },
    { name: 'wabaId', required: true, pattern: /^\d{5,25}$/, placeholder: '102290129340398' },
    { name: 'accessToken', secret: true, required: true, pattern: /^\S{10,1024}$/ },
    { name: 'appSecret', secret: true, required: true, pattern: /^\S{8,256}$/ },
    { name: 'appId', pattern: /^\d{5,25}$/, placeholder: '1234567890123456' },
  ],
  telegram: [
    {
      name: 'botToken',
      secret: true,
      required: true,
      pattern: /^\d{3,20}:[A-Za-z0-9_-]{20,80}$/,
      placeholder: '123456789:AA…',
    },
  ],
  seven: [
    { name: 'apiKey', secret: true, required: true, pattern: /^\S{8,256}$/ },
    { name: 'signingKey', secret: true, required: true, pattern: /^\S{8,256}$/ },
    { name: 'senderId', pattern: /^[A-Za-z0-9 ]{1,11}$|^\+?\d{3,16}$/, placeholder: 'MyShop' },
  ],
  twilio: [
    ...TWILIO_CREDENTIALS,
    { name: 'from', pattern: /^\+\d{6,16}$|^[A-Za-z0-9 ]{1,11}$/, placeholder: '+4915123456789' },
    { name: 'messagingServiceSid', pattern: /^MG[0-9a-f]{32}$/, placeholder: 'MG…' },
  ],
};

/**
 * Fields that differ for a provider on a specific channel, keyed
 * `channel:provider`. RCS through Twilio sends only through a Messaging
 * Service (the one that holds the approved RCS sender).
 *
 * @type {Record<string, ProviderField[]>}
 */
export const CHANNEL_PROVIDER_FIELDS = {
  'rcs:twilio': [
    ...TWILIO_CREDENTIALS,
    { name: 'messagingServiceSid', required: true, pattern: /^MG[0-9a-f]{32}$/, placeholder: 'MG…' },
    { name: 'twilioFallback', type: 'boolean' },
  ],
};

/** Default channel of each provider (Twilio also serves RCS, chosen explicitly). */
export const PROVIDER_CHANNEL = { meta: 'whatsapp', telegram: 'telegram', seven: 'sms', twilio: 'sms' };

/**
 * Options of the "Connect a channel" step, in display order.
 *
 * @type {Array<{id: string, channel: string, provider: string}>}
 */
export const CONNECT_OPTIONS = [
  { id: 'whatsapp', channel: 'whatsapp', provider: 'meta' },
  { id: 'rcs', channel: 'rcs', provider: 'twilio' },
  { id: 'telegram', channel: 'telegram', provider: 'telegram' },
  { id: 'seven', channel: 'sms', provider: 'seven' },
  { id: 'twilio', channel: 'sms', provider: 'twilio' },
];

/**
 * Credential fields for a provider on a channel.
 *
 * @param {string} provider - Provider id.
 * @param {string} [channel] - Channel (defaults to the provider's usual channel).
 * @returns {ProviderField[]} Fields.
 */
export function fieldsFor(provider, channel = PROVIDER_CHANNEL[provider]) {
  return CHANNEL_PROVIDER_FIELDS[`${channel}:${provider}`] || PROVIDER_FIELDS[provider] || [];
}

/**
 * Validates the credential form.
 *
 * @param {string} provider - Provider id.
 * @param {Record<string, string | boolean>} values - Entered values.
 * @param {Record<string, boolean>} [secretsSet] - Secrets already stored (edit mode): empty keeps them.
 * @param {string} [channel] - Channel (RCS changes the Twilio fields).
 * @returns {Record<string, 'required' | 'invalid'>} Errors by field ('from' also when neither sender is set on Twilio SMS).
 */
export function validateCredentials(provider, values, secretsSet = {}, channel = PROVIDER_CHANNEL[provider]) {
  const errors = {};
  const fields = fieldsFor(provider, channel);
  for (const field of fields) {
    if (field.type === 'boolean') continue;
    const value = String(values[field.name] ?? '').trim();
    if (!value) {
      if (field.required && !(field.secret && secretsSet[field.name])) errors[field.name] = 'required';
      continue;
    }
    if (field.pattern && !field.pattern.test(value)) errors[field.name] = 'invalid';
  }
  if (
    provider === 'twilio' &&
    fields.some((f) => f.name === 'from') &&
    !String(values.from ?? '').trim() &&
    !String(values.messagingServiceSid ?? '').trim()
  )
    errors.from = errors.from || 'required';
  return errors;
}

/**
 * Config object to send: trimmed values, empty text fields left out so stored
 * secrets are kept on edit; boolean fields are always sent.
 *
 * @param {string} provider - Provider id.
 * @param {Record<string, string | boolean>} values - Entered values.
 * @param {string} [channel] - Channel.
 * @returns {Record<string, string | boolean>} Config.
 */
export function credentialPayload(provider, values, channel = PROVIDER_CHANNEL[provider]) {
  const config = {};
  for (const field of fieldsFor(provider, channel)) {
    if (field.type === 'boolean') {
      config[field.name] = values[field.name] === true;
      continue;
    }
    const value = String(values[field.name] ?? '').trim();
    if (value) config[field.name] = value;
  }
  return config;
}
