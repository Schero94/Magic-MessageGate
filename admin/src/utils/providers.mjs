/**
 * Credential fields per provider. Patterns mirror PROVIDER_CONFIG in
 * server/src/core/accounts.js so the wizard reports mistakes inline; the
 * server validates again. Generated values (verify token, Telegram secret)
 * are not asked for.
 */

/** @typedef {{name: string, secret?: boolean, required?: boolean, pattern?: RegExp, placeholder?: string}} ProviderField */

/** @type {Record<string, ProviderField[]>} */
export const PROVIDER_FIELDS = {
  meta: [
    { name: 'phoneNumberId', required: true, pattern: /^\d{5,25}$/, placeholder: '106540352242922' },
    { name: 'wabaId', required: true, pattern: /^\d{5,25}$/, placeholder: '102290129340398' },
    { name: 'accessToken', secret: true, required: true, pattern: /^\S{10,1024}$/ },
    { name: 'appSecret', secret: true, required: true, pattern: /^\S{8,256}$/ },
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
    { name: 'accountSid', required: true, pattern: /^AC[0-9a-f]{32}$/, placeholder: 'AC…' },
    { name: 'authToken', secret: true, required: true, pattern: /^[0-9a-f]{32}$/ },
    { name: 'from', pattern: /^\+\d{6,16}$|^[A-Za-z0-9 ]{1,11}$/, placeholder: '+4915123456789' },
    { name: 'messagingServiceSid', pattern: /^MG[0-9a-f]{32}$/, placeholder: 'MG…' },
  ],
};

/** Channel of each provider. */
export const PROVIDER_CHANNEL = { meta: 'whatsapp', telegram: 'telegram', seven: 'sms', twilio: 'sms' };

/**
 * Validates the credential form.
 *
 * @param {string} provider - Provider id.
 * @param {Record<string, string>} values - Entered values.
 * @param {Record<string, boolean>} [secretsSet] - Secrets already stored (edit mode): empty keeps them.
 * @returns {Record<string, 'required' | 'invalid'>} Errors by field ('from' also when neither sender is set on Twilio).
 */
export function validateCredentials(provider, values, secretsSet = {}) {
  const errors = {};
  for (const field of PROVIDER_FIELDS[provider] || []) {
    const value = String(values[field.name] ?? '').trim();
    if (!value) {
      if (field.required && !(field.secret && secretsSet[field.name])) errors[field.name] = 'required';
      continue;
    }
    if (field.pattern && !field.pattern.test(value)) errors[field.name] = 'invalid';
  }
  if (provider === 'twilio' && !String(values.from ?? '').trim() && !String(values.messagingServiceSid ?? '').trim())
    errors.from = errors.from || 'required';
  return errors;
}

/**
 * Config object to send: trimmed values, empty fields left out so stored
 * secrets are kept on edit.
 *
 * @param {string} provider - Provider id.
 * @param {Record<string, string>} values - Entered values.
 * @returns {Record<string, string>} Config.
 */
export function credentialPayload(provider, values) {
  const config = {};
  for (const field of PROVIDER_FIELDS[provider] || []) {
    const value = String(values[field.name] ?? '').trim();
    if (value) config[field.name] = value;
  }
  return config;
}
