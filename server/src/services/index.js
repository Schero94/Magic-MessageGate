'use strict';

/**
 * Strapi services. They are thin wrappers around the core, so other plugins
 * and app code can use the public API:
 *
 *   strapi.plugin('magic-messagegate').service('messages').send({ … })
 */
const { createCore } = require('../core');

const PLUGIN = 'magic-messagegate';
/** @type {WeakMap<object, object>} */
const cores = new WeakMap();

/**
 * Builds (once per Strapi instance) the core bound to Strapi's database.
 *
 * @param {object} strapi
 * @returns {object}
 */
function coreFor(strapi) {
  if (!cores.has(strapi)) {
    const config = strapi.config.get(`plugin::${PLUGIN}`) || {};
    let magicMail;
    try {
      magicMail = strapi.plugin('magic-mail')?.service('email-router') || null;
    } catch {
      magicMail = null;
    }
    cores.set(
      strapi,
      createCore({
        knex: strapi.db.connection,
        config,
        log: strapi.log,
        emit: (name, payload) => {
          try {
            strapi.eventHub?.emit(name, payload);
          } catch {
            // listeners must never break sending
          }
        },
        publicUrl: config.publicUrl || strapi.config.get('server.url') || '',
        magicMail,
      })
    );
  }
  return cores.get(strapi);
}

module.exports = {
  core: ({ strapi }) => ({
    /** @returns {object} The MessageGate core. */
    get: () => coreFor(strapi),
  }),

  messages: ({ strapi }) => ({
    /**
     * Queues a message. See AGENTS.md for the full contract.
     *
     * @param {object} input
     * @param {{source?: string}} [options]
     * @returns {Promise<{id: string|null, status: string, channel: string, duplicate: boolean}>}
     */
    send: (input, options) => coreFor(strapi).sender.send(input, { source: 'service', ...options }),
    /** @param {string} id */
    get: (id) => coreFor(strapi).outbox.detail(id),
    /** @param {object} query */
    list: (query) => coreFor(strapi).outbox.list(query),
    /** @param {string} id @param {{confirmDuplicateRisk?: boolean}} [options] */
    retry: (id, options) => coreFor(strapi).outbox.retry(id, options),
    /** @param {string} id */
    cancel: (id) => coreFor(strapi).outbox.discard(id),
  }),

  contacts: ({ strapi }) => ({
    /**
     * @param {string} phone
     * @param {{userId?: number, locale?: string}} [extra]
     */
    async upsert(phone, extra = {}) {
      const core = coreFor(strapi);
      const settings = await core.settings.get();
      const { row } = await core.contacts.upsertByPhone(phone, { ...extra, country: settings.defaultCountry });
      return core.contacts.dto(row);
    },
    /**
     * @param {string} contactId
     * @param {'whatsapp'|'telegram'|'sms'} channel
     * @param {string} [source]
     */
    async grantConsent(contactId, channel, source = 'api') {
      const core = coreFor(strapi);
      const row = await core.contacts.getRow(contactId);
      if (!row) throw Object.assign(new Error('Contact not found'), { code: 'NOT_FOUND' });
      await core.contacts.setConsent(row.id, channel, 'granted', source);
    },
    /**
     * @param {string} contactId
     * @param {'whatsapp'|'telegram'|'sms'} channel
     * @param {string} [source]
     */
    async revokeConsent(contactId, channel, source = 'api') {
      const core = coreFor(strapi);
      const row = await core.contacts.getRow(contactId);
      if (!row) throw Object.assign(new Error('Contact not found'), { code: 'NOT_FOUND' });
      await core.contacts.setConsent(row.id, channel, 'revoked', source);
    },
  }),

  telegram: ({ strapi }) => ({
    /**
     * Creates a one-time deep link that binds a Telegram chat to a contact.
     *
     * @param {string} contactId
     * @param {string} [accountId] - Telegram account; the default account when omitted.
     * @returns {Promise<{url: string|null, token: string, expiresInMinutes: number}>}
     */
    async createLink(contactId, accountId) {
      const core = coreFor(strapi);
      const row = await core.contacts.getRow(contactId);
      if (!row) throw Object.assign(new Error('Contact not found'), { code: 'NOT_FOUND' });
      const token = await core.contacts.createLinkToken(row.id);
      const account = accountId
        ? await core.accounts.getRow(accountId)
        : (await core.accounts.forChannel('telegram'))[0];
      const username = account ? core.accounts.configOf(account).botUsername : null;
      return { url: username ? `https://t.me/${username}?start=${token}` : null, token, expiresInMinutes: 30 };
    },
  }),

  lookup: ({ strapi }) => ({
    /** @param {string} phone */
    check: (phone) => coreFor(strapi).lookup.check(phone),
  }),
};

module.exports.coreFor = coreFor;
