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
 * @param {{settings: object, accounts: object, templates: object, contacts: object, outbox: object, inbound: object}} deps
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
   * Stores an inbound message once, then updates last activity and handles
   * opt-out keywords (only for new messages, so provider retries are no-ops).
   *
   * @param {object} input - see inbound.record; `contact` must be set
   * @returns {Promise<object|null>} stored row or null (duplicate)
   */
  async function receive(input) {
    const row = await deps.inbound.record(input);
    if (!row || !input.contact) return row;
    await deps.contacts.touch(input.contact.id, 'inbound', input.at, input.channel);
    if (input.text && (await isOptOut(input.text))) {
      await deps.contacts.setConsent(input.contact.id, input.channel, 'revoked', 'keyword');
    }
    return row;
  }

  /**
   * @param {string} phone - E.164 or digits
   * @returns {Promise<object|null>} contact row
   */
  async function contactByPhone(phone) {
    const settings = await deps.settings.get();
    const raw = String(phone || '').replace(/^(rcs|whatsapp|sms):/i, '');
    const parsed = parsePhone(raw.startsWith('+') ? raw : `+${raw}`, settings.defaultCountry);
    if (!parsed.valid) return null;
    return (await deps.contacts.upsertByPhone(parsed.e164, { country: settings.defaultCountry })).row;
  }

  /**
   * Maps a Cloud API inbound message to MessageGate fields.
   * https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages
   *
   * @param {object} m
   * @returns {object}
   */
  function metaMessage(m) {
    const out = { kind: 'other', replyProviderId: typeof m.context?.id === 'string' ? m.context.id : null };
    if (m.type === 'text') Object.assign(out, { kind: 'text', text: m.text?.body });
    else if (m.type === 'button') {
      Object.assign(out, {
        kind: 'button',
        buttonPayload: m.button?.payload,
        buttonTitle: m.button?.text,
        text: m.button?.text,
      });
    } else if (m.type === 'interactive') {
      const reply = m.interactive?.button_reply || m.interactive?.list_reply;
      if (reply)
        Object.assign(out, { kind: 'button', buttonPayload: reply.id, buttonTitle: reply.title, text: reply.title });
    } else if (['image', 'video', 'document', 'audio', 'sticker'].includes(m.type)) {
      const media = m[m.type] || {};
      if (typeof media.id === 'string') {
        Object.assign(out, {
          kind: 'media',
          media: {
            ref: { id: media.id },
            mime: media.mime_type,
            filename: media.filename,
            caption: media.caption,
            voice: media.voice === true,
          },
        });
      }
    } else if (m.type === 'location' && Number.isFinite(Number(m.location?.latitude))) {
      out.kind = 'location';
      out.location = {
        latitude: Number(m.location.latitude),
        longitude: Number(m.location.longitude),
        ...(m.location.name ? { name: String(m.location.name).slice(0, 200) } : {}),
        ...(m.location.address ? { address: String(m.location.address).slice(0, 300) } : {}),
      };
    }
    return out;
  }

  /**
   * Finds the Meta account of a phone number id (app-level webhook URL).
   *
   * @param {string|undefined} phoneNumberId
   * @returns {Promise<object|null>}
   */
  async function metaAccountFor(phoneNumberId) {
    if (!phoneNumberId) return null;
    for (const row of await deps.accounts.forChannel('whatsapp')) {
      if (deps.accounts.configOf(row).phoneNumberId === String(phoneNumberId)) return row;
    }
    return null;
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
          const messages = Array.isArray(value.messages) ? value.messages.slice(0, 100) : [];
          const owner = messages.length ? account || (await metaAccountFor(value.metadata?.phone_number_id)) : null;
          for (const message of messages) {
            if (typeof message?.id !== 'string' || typeof message?.from !== 'string') continue;
            const contact = await contactByPhone(message.from);
            if (!contact) continue;
            await receive({
              provider: 'meta',
              providerMessageId: message.id,
              channel: 'whatsapp',
              contact,
              account: owner,
              at: Number(message.timestamp) * 1000 || ctx.now(),
              ...metaMessage(message),
            });
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
      if (!Number.isInteger(body?.update_id)) return { status: 200 };
      if (body.callback_query) {
        await telegramCallback(account, config, body.callback_query);
        return { status: 200 };
      }
      const message = body?.message;
      if (!message?.chat?.id || message.chat.type !== 'private') return { status: 200 };
      const chatId = String(message.chat.id);
      const text = typeof message.text === 'string' ? message.text.slice(0, 4096) : '';
      const at = Number(message.date) * 1000 || ctx.now();
      const start = /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{16,64})$/.exec(text.trim());
      if (start) {
        await once('telegram', `${account.id}:${body.update_id}`, async () => {
          const contact = await deps.contacts.consumeLinkToken(start[1], chatId);
          if (contact) await deps.contacts.touch(contact.id, 'inbound', at, 'telegram');
        });
        return { status: 200 };
      }
      const contact = await deps.contacts.byChatId(chatId);
      if (!contact) return { status: 200 };
      const row = await receive({
        provider: 'telegram',
        providerMessageId: `${account.id}:${chatId}:${message.message_id}`,
        channel: 'telegram',
        contact,
        account,
        at,
        ...telegramMessage(message, chatId),
      });
      if (row && text.trim().toLowerCase() === '/stop') {
        await deps.contacts.setConsent(contact.id, 'telegram', 'revoked', 'keyword');
      }
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
        await sevenEvent(account, body);
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
   * @param {object} account
   * @param {any} body - verified seven.io webhook body
   * @returns {Promise<void>}
   */
  async function sevenEvent(account, body) {
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
      const contact = await contactByPhone(String(data.sender));
      if (!contact) return;
      await receive({
        provider: 'seven',
        providerMessageId: `mo:${data.id}`,
        channel: 'sms',
        contact,
        account,
        kind: 'text',
        text: String(data.text || '').slice(0, 4096),
        at: Date.parse(String(data.time || '').replace(' ', 'T')) || ctx.now(),
      });
    }
  }

  /**
   * Maps a Telegram Message to MessageGate fields.
   * https://core.telegram.org/bots/api#message
   *
   * @param {object} m
   * @param {string} chatId
   * @returns {object}
   */
  function telegramMessage(m, chatId) {
    const out = {
      kind: 'other',
      replyProviderId: m.reply_to_message?.message_id ? `${chatId}:${m.reply_to_message.message_id}` : null,
    };
    const caption = typeof m.caption === 'string' ? m.caption : undefined;
    const media = (file, mime, extra = {}) => ({
      kind: 'media',
      text: caption,
      media: {
        ref: { id: file.file_id },
        mime: file.mime_type || mime,
        filename: file.file_name,
        caption,
        size: file.file_size,
        ...extra,
      },
    });
    if (typeof m.text === 'string') Object.assign(out, { kind: 'text', text: m.text });
    else if (Array.isArray(m.photo) && m.photo.length) {
      const largest = [...m.photo].sort((a, b) => Number(b.file_size || 0) - Number(a.file_size || 0))[0];
      Object.assign(out, media(largest, 'image/jpeg'));
    } else if (m.voice) Object.assign(out, media(m.voice, 'audio/ogg', { duration: m.voice.duration, voice: true }));
    else if (m.audio) Object.assign(out, media(m.audio, 'audio/mpeg', { duration: m.audio.duration }));
    else if (m.video) Object.assign(out, media(m.video, 'video/mp4', { duration: m.video.duration }));
    else if (m.document) Object.assign(out, media(m.document, 'application/octet-stream'));
    else if (m.sticker) {
      const animated = m.sticker.is_animated || m.sticker.is_video;
      Object.assign(out, media(m.sticker, animated ? 'application/x-tgsticker' : 'image/webp'));
    } else if (m.location || m.venue?.location) {
      const loc = m.location || m.venue.location;
      out.kind = 'location';
      out.location = {
        latitude: Number(loc.latitude),
        longitude: Number(loc.longitude),
        ...(m.venue?.title ? { name: String(m.venue.title).slice(0, 200) } : {}),
        ...(m.venue?.address ? { address: String(m.venue.address).slice(0, 300) } : {}),
      };
    }
    return out;
  }

  /**
   * Inline keyboard press: answer the callback query (the client shows a
   * spinner until then) and store the button payload.
   *
   * @param {object} account
   * @param {object} config
   * @param {object} query - CallbackQuery
   * @returns {Promise<void>}
   */
  async function telegramCallback(account, config, query) {
    if (typeof query?.id !== 'string' || !query.from?.id) return;
    const chatId = String(query.message?.chat?.id || query.from.id);
    const contact = await deps.contacts.byChatId(chatId);
    const row = contact
      ? await receive({
          provider: 'telegram',
          providerMessageId: `cb:${query.id}`,
          channel: 'telegram',
          contact,
          account,
          kind: 'button',
          buttonPayload: typeof query.data === 'string' ? query.data.slice(0, 64) : null,
          replyProviderId: query.message?.message_id ? `${chatId}:${query.message.message_id}` : null,
          at: ctx.now(),
        })
      : null;
    if (row || !contact) {
      await ctx
        .adapter('telegram')
        .answerCallback({
          config,
          callbackQueryId: query.id,
          settings: ctx.config.providers.telegram,
          fetchImpl: ctx.fetchImpl,
        })
        .catch(() => {});
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
    if (params.From && (typeof params.Body === 'string' || Number(params.NumMedia) > 0)) {
      const from = String(params.From);
      if (/^whatsapp:/i.test(from)) return { status: 200 };
      const contact = await contactByPhone(from);
      if (!contact) return { status: 200 };
      await receive({
        provider: 'twilio',
        providerMessageId: sid,
        channel: /^rcs:/i.test(from) || account.channel === 'rcs' ? 'rcs' : 'sms',
        contact,
        account,
        at: ctx.now(),
        ...twilioMessage(params),
      });
    }
    return { status: 200 };
  }
}

/**
 * Maps Twilio inbound webhook parameters (SMS, MMS, RCS) to MessageGate fields.
 * https://www.twilio.com/docs/messaging/guides/webhook-request
 *
 * @param {Record<string,string>} p
 * @returns {object}
 */
function twilioMessage(p) {
  const out = {
    kind: 'text',
    text: typeof p.Body === 'string' ? p.Body.slice(0, 4096) : '',
    replyProviderId: /^(SM|MM)[0-9a-f]{32}$/.test(String(p.OriginalRepliedMessageSid || ''))
      ? p.OriginalRepliedMessageSid
      : null,
  };
  if (p.ButtonPayload) {
    Object.assign(out, {
      kind: 'button',
      buttonPayload: String(p.ButtonPayload).slice(0, 256),
      buttonTitle: p.ButtonText,
    });
  } else if (Number(p.NumMedia) > 0 && p.MediaUrl0) {
    Object.assign(out, {
      kind: 'media',
      media: { ref: { url: String(p.MediaUrl0) }, mime: p.MediaContentType0, caption: out.text || undefined },
    });
  } else if (p.Latitude && p.Longitude && Number.isFinite(Number(p.Latitude))) {
    out.kind = 'location';
    out.location = {
      latitude: Number(p.Latitude),
      longitude: Number(p.Longitude),
      ...(p.Label ? { name: String(p.Label).slice(0, 200) } : {}),
      ...(p.Address ? { address: String(p.Address).slice(0, 300) } : {}),
    };
  }
  return out;
}

module.exports = { createWebhooks, META_STATUS, twilioMessage };
