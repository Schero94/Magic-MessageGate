'use strict';

/**
 * Provider webhooks: delivery statuses, inbound messages (opt-out keywords,
 * last activity, Telegram linking) and WhatsApp template status updates.
 *
 * Every request is authenticated with the provider's signature before any
 * work happens; every event is de-duplicated through `mg_webhook_receipts`
 * (providers retry, Meta for up to 36 hours), and statuses only move
 * forward (outbox.applyProviderStatus).
 */
const { claimOnce, unclaim } = require('../store/coordination');
const signatures = require('../utils/signatures');
const { parsePhone } = require('../utils/phone');
const seven = require('../adapters/seven');
const twilio = require('../adapters/twilio');

const META_STATUS = { sent: 'sent', delivered: 'delivered', read: 'read', played: 'read', failed: 'failed' };

/**
 * @param {import('./context').CoreContext} ctx
 * @param {{settings: object, accounts: object, templates: object, contacts: object, outbox: object}} deps
 */
function createWebhooks(ctx, deps) {
  /**
   * Runs `fn` once per event key; releases the key when `fn` throws so the
   * provider's retry is processed again.
   *
   * @param {string} provider
   * @param {string} key
   * @param {() => Promise<void>} fn
   * @returns {Promise<boolean>} Whether the event was new.
   */
  async function once(provider, key, fn) {
    if (!(await claimOnce(ctx.knex, provider, key, ctx.now()))) return false;
    try {
      await fn();
      return true;
    } catch (error) {
      await unclaim(ctx.knex, provider, key);
      throw error;
    }
  }

  /**
   * @param {string} text
   * @returns {Promise<boolean>}
   */
  async function isOptOut(text) {
    const settings = await deps.settings.get();
    const word = String(text || '')
      .trim()
      .toUpperCase();
    return word.length > 0 && word.length <= 24 && settings.optOutKeywords.some((k) => k.toUpperCase() === word);
  }

  /**
   * @param {string} channel
   * @param {string} phone - E.164 or digits
   * @param {string} text
   * @param {number} at
   * @returns {Promise<void>}
   */
  async function inboundByPhone(channel, phone, text, at) {
    const settings = await deps.settings.get();
    const parsed = parsePhone(String(phone).startsWith('+') ? phone : `+${phone}`, settings.defaultCountry);
    if (!parsed.valid) return;
    const { row } = await deps.contacts.upsertByPhone(parsed.e164, { country: settings.defaultCountry });
    await deps.contacts.touch(row.id, 'inbound', at, channel);
    if (await isOptOut(text)) await deps.contacts.setConsent(row.id, channel, 'revoked', 'keyword');
  }

  const api = {
    /**
     * Meta GET verification (hub.challenge).
     *
     * @param {object|null} account - Account row, or null for the app-level URL.
     * @param {Record<string,string>} query
     * @param {object} [configOverride] - App-level config ({verifyToken, appSecret}).
     * @returns {{status: number, body: string}}
     */
    metaVerify(account, query, configOverride) {
      const config = configOverride || deps.accounts.configOf(account);
      const ok =
        query['hub.mode'] === 'subscribe' &&
        typeof query['hub.challenge'] === 'string' &&
        /^[A-Za-z0-9_-]{1,128}$/.test(query['hub.challenge']) &&
        signatures.timingSafe(String(query['hub.verify_token'] || ''), String(config.verifyToken || ''));
      return ok ? { status: 200, body: query['hub.challenge'] } : { status: 403, body: 'Forbidden' };
    },

    /**
     * Meta POST (statuses, inbound messages, template status updates).
     *
     * @param {object|null} account - Account row, or null for the app-level URL.
     * @param {{headers: Record<string,string>, rawBody: Buffer, body: any}} request
     * @param {object} [configOverride] - App-level config ({appSecret}); events are
     *   matched by message id, so one app URL serves every Embedded Signup account.
     * @returns {Promise<{status: number}>}
     */
    async meta(account, { headers, rawBody, body }, configOverride) {
      const config = configOverride || deps.accounts.configOf(account);
      if (!signatures.verifyMeta(rawBody, headers['x-hub-signature-256'], config.appSecret)) return { status: 401 };
      for (const entry of Array.isArray(body?.entry) ? body.entry.slice(0, 100) : []) {
        for (const change of Array.isArray(entry?.changes) ? entry.changes.slice(0, 100) : []) {
          const value = change?.value || {};
          if (change.field === 'message_template_status_update') {
            const key = `tpl:${value.message_template_id}:${value.event}:${entry.time || ''}`;
            await once('meta', key, () =>
              deps.templates.applyProviderStatus({
                name: String(value.message_template_name || ''),
                language: String(value.message_template_language || ''),
                status: String(value.event || ''),
                id: value.message_template_id ? String(value.message_template_id) : undefined,
                reason: value.reason,
              })
            );
            continue;
          }
          if (change.field !== 'messages') continue;
          for (const status of Array.isArray(value.statuses) ? value.statuses.slice(0, 500) : []) {
            const mapped = META_STATUS[status?.status];
            if (!mapped || typeof status.id !== 'string') continue;
            const code =
              Array.isArray(status.errors) && status.errors[0]?.code ? `META_${Number(status.errors[0].code)}` : null;
            await once('meta', `st:${status.id}:${status.status}`, async () => {
              await deps.outbox.applyProviderStatus({
                providerMessageId: status.id,
                status: mapped,
                at: Number(status.timestamp) * 1000 || ctx.now(),
                code,
              });
            });
          }
          for (const message of Array.isArray(value.messages) ? value.messages.slice(0, 100) : []) {
            if (typeof message?.id !== 'string' || typeof message?.from !== 'string') continue;
            await once('meta', `in:${message.id}`, () =>
              inboundByPhone(
                'whatsapp',
                message.from,
                message.text?.body || message.button?.text || '',
                Number(message.timestamp) * 1000 || ctx.now()
              )
            );
          }
        }
      }
      return { status: 200 };
    },

    /**
     * Telegram updates (linking via /start <token>, opt-out, last activity).
     *
     * @param {object} account
     * @param {{headers: Record<string,string>, body: any}} request
     * @returns {Promise<{status: number}>}
     */
    async telegram(account, { headers, body }) {
      const config = deps.accounts.configOf(account);
      if (!signatures.verifyTelegram(headers['x-telegram-bot-api-secret-token'], config.secretToken))
        return { status: 401 };
      const message = body?.message;
      if (!Number.isInteger(body?.update_id) || !message?.chat?.id || message.chat.type !== 'private')
        return { status: 200 };
      const chatId = String(message.chat.id);
      const text = typeof message.text === 'string' ? message.text.slice(0, 4096) : '';
      await once('telegram', `${account.id}:${body.update_id}`, async () => {
        const at = Number(message.date) * 1000 || ctx.now();
        const start = /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{16,64})$/.exec(text.trim());
        if (start) {
          const contact = await deps.contacts.consumeLinkToken(start[1], chatId);
          if (contact) await deps.contacts.touch(contact.id, 'inbound', at, 'telegram');
          return;
        }
        const contact = await deps.contacts.byChatId(chatId);
        if (!contact) return;
        await deps.contacts.touch(contact.id, 'inbound', at, 'telegram');
        if (text.trim().toLowerCase() === '/stop' || (await isOptOut(text))) {
          await deps.contacts.setConsent(contact.id, 'telegram', 'revoked', 'keyword');
        }
      });
      return { status: 200 };
    },

    /**
     * seven.io webhooks (dlr, sms_mo).
     *
     * @param {object} account
     * @param {{headers: Record<string,string>, rawBody: Buffer, body: any, url: string, method: string}} request
     * @returns {Promise<{status: number}>}
     */
    async seven(account, { headers, rawBody, body, url, method }) {
      const config = deps.accounts.configOf(account);
      const check = signatures.verifySeven({
        signingKey: config.signingKey,
        headers,
        method,
        url,
        rawBody,
        now: ctx.now(),
      });
      if (!check.ok) return { status: 401 };
      // Replay protection: a nonce is accepted once inside the 30 s window.
      if (!(await claimOnce(ctx.knex, 'seven-nonce', check.nonce, ctx.now()))) return { status: 200 };
      try {
        await sevenEvent(body);
      } catch (error) {
        await unclaim(ctx.knex, 'seven-nonce', check.nonce);
        throw error;
      }
      return { status: 200 };
    },

    /**
     * Twilio status callbacks and inbound SMS (form-encoded).
     *
     * @param {object} account
     * @param {{headers: Record<string,string>, params: Record<string,string>, url: string}} request
     * @returns {Promise<{status: number}>}
     */
    async twilio(account, { headers, params, url }) {
      return twilioEvent(account, { headers, params, url });
    },
  };
  return api;

  /**
   * @param {any} body - verified seven.io webhook body
   * @returns {Promise<void>}
   */
  async function sevenEvent(body) {
    const event = body?.webhook_event;
    const data = body?.data || {};
    if (event === 'dlr' && data.msg_id && typeof data.status === 'string') {
      const mapped = seven.DLR_STATUS[data.status.toUpperCase()];
      if (mapped) {
        await once('seven', `dlr:${data.msg_id}:${data.status}`, async () => {
          await deps.outbox.applyProviderStatus({
            providerMessageId: String(data.msg_id),
            status: mapped,
            at: Date.parse(String(data.timestamp || '').replace(' ', 'T')) || ctx.now(),
            code: mapped === 'failed' ? `SEVEN_${data.status.toUpperCase()}` : null,
          });
        });
      }
    } else if (event === 'sms_mo' && data.sender && data.id) {
      await once('seven', `mo:${data.id}`, () =>
        inboundByPhone('sms', String(data.sender), String(data.text || ''), ctx.now())
      );
    }
  }

  /**
   * @param {object} account
   * @param {{headers: Record<string,string>, params: Record<string,string>, url: string}} request
   * @returns {Promise<{status: number}>}
   */
  async function twilioEvent(account, { headers, params, url }) {
    const config = deps.accounts.configOf(account);
    if (!signatures.verifyTwilio(url, params, headers['x-twilio-signature'], config.authToken)) return { status: 401 };
    const sid = params.MessageSid || params.SmsSid;
    if (typeof sid !== 'string' || !/^(SM|MM)[0-9a-f]{32}$/.test(sid)) return { status: 200 };
    if (params.MessageStatus) {
      const status = String(params.MessageStatus).toLowerCase();
      const mapped = twilio.STATUS[status];
      if (mapped) {
        await once('twilio', `st:${sid}:${status}`, async () => {
          await deps.outbox.applyProviderStatus({
            providerMessageId: sid,
            status: mapped,
            at: ctx.now(),
            code: mapped === 'failed' ? `TWILIO_${Number(params.ErrorCode) || status.toUpperCase()}` : null,
          });
        });
      }
      if (status !== 'received') return { status: 200 };
    }
    if (params.From && typeof params.Body === 'string') {
      await once('twilio', `in:${sid}`, () => inboundByPhone('sms', String(params.From), params.Body, ctx.now()));
    }
    return { status: 200 };
  }
}

module.exports = { createWebhooks, META_STATUS };
