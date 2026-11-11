'use strict';

/**
 * Strapi services. They are thin wrappers around the core, so other plugins
 * and app code can use the public API:
 *
 *   strapi.plugin('magic-messagegate').service('messages').send({ … })
 */
const { createCore } = require('../core');
const { createFiles } = require('./files');
const { SANDBOX_NUMBERS } = require('../testing/numbers');

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
        files: strapi.db?.query ? createFiles(strapi) : null,
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
     * @param {{source?: string, dryRun?: boolean}} [options] - `dryRun: true` plans without sending (see `preview`).
     * @returns {Promise<{id: string|null, status: string, channel: string, duplicate: boolean}|object>}
     */
    send: (input, options) => coreFor(strapi).sender.send(input, { source: 'service', ...options }),
    /**
     * Dry run: route, account, rendered payload (phone masked) and errors, without sending or cost.
     *
     * @param {object} input
     * @returns {Promise<object>}
     */
    preview: (input) => coreFor(strapi).sender.preview(input),
    /**
     * Answers an inbound message on its channel and account.
     *
     * @param {string} inboundId
     * @param {object} input - `text` | `template` + `variables`, `buttons`, `attachment`, `idempotencyKey`
     * @param {{dryRun?: boolean}} [options]
     * @returns {Promise<object>}
     */
    reply: (inboundId, input, options) => coreFor(strapi).reply(inboundId, input, { source: 'reply', ...options }),
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
    /**
     * Number check: free format check; `remote` (Twilio line type, default on
     * when configured), `hlr` (seven.io HLR, paid), `rcs` (learned RCS capability).
     *
     * @param {string} phone
     * @param {{remote?: boolean, hlr?: boolean, rcs?: boolean}} [options]
     */
    check: (phone, options) => coreFor(strapi).lookup.check(phone, options),
    /**
     * What is known about a number without any paid call.
     *
     * @param {string} phone
     * @returns {Promise<{valid: boolean, e164: string|null, type: string|null, active: boolean|null, whatsapp: string, rcs: string, telegramLinked: boolean, checkedAt: number|null}>}
     */
    capabilities: (phone) => coreFor(strapi).lookup.capabilities(phone),
  }),

  templates: ({ strapi }) => ({
    /**
     * Renders the active template without sending.
     *
     * @param {string} key
     * @param {string|undefined} language
     * @param {Record<string, unknown>} variables
     * @param {'whatsapp'|'rcs'|'telegram'|'sms'} channel
     */
    render: (key, language, variables, channel) => coreFor(strapi).templates.render(key, language, variables, channel),
  }),

  inbound: ({ strapi }) => ({
    /** @param {string} id */
    get: (id) => coreFor(strapi).inbound.get(id),
    /** @param {object} [query] */
    list: (query) => coreFor(strapi).inbound.list(query),
    /** @param {string} id */
    markProcessed: (id) => coreFor(strapi).inbound.markProcessed(id),
    /**
     * @param {string} id
     * @param {{as?: 'buffer'|'stream'|'base64'}} [options]
     */
    getMedia: (id, options) => coreFor(strapi).inbound.getMedia(id, options),
    /**
     * @param {string} id
     * @param {{ttlSeconds?: number}} [options]
     */
    createMediaUrl: (id, options) => coreFor(strapi).inbound.createMediaUrl(id, options),
    /**
     * Subscribes to `messagegate.message.received` (emitted once across processes).
     *
     * @param {(event: object) => void|Promise<void>} handler
     * @returns {() => void} unsubscribe
     */
    onReceived(handler) {
      return strapi.eventHub.on('messagegate.message.received', handler);
    },
    /**
     * Registers a virus scanner for inbound media (per process; register it in every process).
     *
     * @param {(file: {bytes: Buffer, mime: string, size: number, filename: string, inboundId: string}) => Promise<'clean'|'infected'>} fn
     */
    onMediaScan: (fn) => coreFor(strapi).inbound.onMediaScan(fn),
  }),

  conversations: ({ strapi }) => ({
    /**
     * @param {string|{inboundId: string}} ref - contact id or `{ inboundId }`
     * @param {{limit?: number, since?: number, includeMedia?: boolean}} [options]
     */
    history: (ref, options) => coreFor(strapi).inbound.history(ref, options),
  }),

  sandbox: ({ strapi }) => ({
    /** Magic test numbers (see AGENTS.md "Sandbox"). */
    numbers: SANDBOX_NUMBERS,
    /** @returns {boolean} */
    enabled: () => coreFor(strapi).ctx.config.providers.mode === 'sandbox',
    /** @param {object} input */
    simulateInbound: (input) => coreFor(strapi).simulateInbound(input),
    /**
     * Runs worker rounds until nothing is due (tests).
     *
     * @param {{maxRounds?: number}} [options]
     */
    async drain({ maxRounds = 20 } = {}) {
      const core = coreFor(strapi);
      if (core.ctx.config.providers.mode !== 'sandbox')
        throw Object.assign(new Error('SANDBOX_ONLY'), { code: 'SANDBOX_ONLY' });
      for (let i = 0; i < maxRounds; i += 1) {
        const { claimed } = await core.outbox.tick();
        const media = await core.inbound.mediaTick();
        if (!claimed && !media.length) return i;
      }
      return maxRounds;
    },
  }),
};

module.exports.coreFor = coreFor;
