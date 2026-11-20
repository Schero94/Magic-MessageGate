'use strict';

/**
 * Live: Telegram Bot API with the owner's bot (TELEGRAM_BOT_TOKEN) and a
 * private chat the owner opened with it (TELEGRAM_CHAT_ID). Messages go to
 * that chat only. Telegram is free.
 *
 * Opt-in webhooks (LIVE_WEBHOOKS=1 and LIVE_INTERACTIVE=1): MessageGate
 * registers its webhook on a cloudflared tunnel (the real "Test connection"
 * path), sends a message with two buttons and waits 120 s for the owner to
 * tap one. The previous webhook is restored afterwards: deleted when there
 * was none; when there was one, the test needs TELEGRAM_RESTORE_SECRET (its
 * secret token, which getWebhookInfo does not return) and is skipped without it.
 *
 * Run: LIVE_PROVIDERS=telegram npm run test:live (keys: docs/live-tests.md).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadLiveConfig, installLiveFetch, withTunnel, waitFor } = require('../helpers/live-env');

const { env, skipReason, optIn } = loadLiveConfig();
const skip = skipReason('telegram');
if (skip) console.log(`telegram live suite skipped: ${skip}`);
const telegram = require('../../server/src/adapters/telegram');
const engine = require('../../server/src/utils/template-engine');

const config = () => ({ botToken: env.TELEGRAM_BOT_TOKEN });

let live;
test.before(() => {
  if (!skip) live = installLiveFetch();
});
test.after(() => {
  if (skip) return;
  live.restore();
  console.log(JSON.stringify({ liveRequests: live.results }, null, 1));
});

/**
 * @param {string} method
 * @param {object} [body]
 * @returns {Promise<any>}
 */
async function bot(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

/**
 * Core with the live bot and a contact linked to the owner's chat.
 *
 * @param {string} [publicUrl]
 * @returns {Promise<{strapi: object, core: object, account: object, contact: object}>}
 */
async function setup(publicUrl = '') {
  const { fakeStrapi } = require('../helpers/strapi');
  const strapi = await fakeStrapi({ publicUrl });
  const core = strapi.core;
  const account = await core.accounts.create({
    channel: 'telegram',
    provider: 'telegram',
    name: 'Bot live',
    config: config(),
  });
  const { row } = await core.contacts.upsertByPhone('+4915123456789');
  const token = await core.contacts.createLinkToken(row.id);
  const contact = await core.contacts.consumeLinkToken(token, String(env.TELEGRAM_CHAT_ID));
  await core.contacts.setConsent(row.id, 'telegram', 'granted', 'live-test');
  return { strapi, core, account, contact: contact || row };
}

test('telegram live: getMe through testConnection', { skip }, async () => {
  const res = await telegram.testConnection({ config: config() });
  assert.equal(res.ok, true, `getMe answered ${res.code}`);
  assert.equal(typeof res.info.username, 'string');
  const info = await bot('getWebhookInfo');
  console.log(JSON.stringify({ telegramWebhookSet: Boolean(info.result?.url) }));
});

test('telegram live: text with HTML entities through the full send path', { skip }, async () => {
  const { core, contact } = await setup();
  const res = await core.sender.send({
    contactId: contact.document_id,
    channel: 'telegram',
    text: 'MessageGate live test: <b> & "quotes" stay literal',
  });
  await core.outbox.tick();
  const row = await core.outbox.getRow(res.id);
  assert.equal(row.status, 'sent', `send ended with ${row.error_code}`);
  assert.match(row.provider_message_id, /^-?\d+:\d+$/);
});

test('telegram live: 4096 visible characters with entities are accepted', { skip }, async () => {
  const text = engine.escapeHtml(`MessageGate live test, long text & entities. ${'&'.repeat(4096)}`);
  const res = await telegram.send({ config: config(), to: String(env.TELEGRAM_CHAT_ID), payload: { text } });
  assert.equal(res.outcome, 'accepted', `long text answered ${res.code}`);
});

test('telegram live: inline buttons are accepted', { skip }, async () => {
  const res = await telegram.send({
    config: config(),
    to: String(env.TELEGRAM_CHAT_ID),
    payload: {
      text: 'MessageGate live test: buttons (no need to tap)',
      buttons: [
        { title: 'Ja', payload: 'live_yes' },
        { title: 'Nein', payload: 'live_no' },
      ],
    },
  });
  assert.equal(res.outcome, 'accepted', `buttons answered ${res.code}`);
});

test('telegram live: unknown chat and wrong token are refused', { skip }, async () => {
  const chat = await telegram.send({ config: config(), to: '1', payload: { text: 'never sent' } });
  assert.equal(chat.outcome, 'rejected');
  assert.equal(chat.accountProblem, false, `unknown chat answered ${chat.code}`);
  const token = await telegram.send({
    config: { botToken: '123456789:AAwrongTokenForTheLiveTest_000000000' },
    to: String(env.TELEGRAM_CHAT_ID),
    payload: { text: 'never sent' },
  });
  assert.equal(token.outcome, 'rejected');
  assert.equal(token.accountProblem, true, `wrong token answered ${token.code}`);
  console.log(JSON.stringify({ telegramRefused: { chat: chat.code, token: token.code } }));
});

const hookSkip = optIn('telegram', {
  flags: { LIVE_WEBHOOKS: 'cloudflared tunnel', LIVE_INTERACTIVE: 'the owner taps a button in Telegram' },
});

test('telegram live: webhook end to end, button tap by the owner', { skip: hookSkip, timeout: 240_000 }, async (t) => {
  const before = (await bot('getWebhookInfo')).result || {};
  if (before.url && !env.TELEGRAM_RESTORE_SECRET) {
    t.skip('a webhook is set; TELEGRAM_RESTORE_SECRET is needed to restore it');
    return;
  }
  await withTunnel(async ({ url, hits, use }) => {
    const { strapi, core, account, contact } = await setup(url);
    use(strapi);
    try {
      const conn = await core.accounts.testConnection(account.id);
      assert.equal(conn.ok, true, 'testConnection registered the webhook');
      const res = await core.sender.send({
        contactId: contact.document_id,
        channel: 'telegram',
        text: 'MessageGate live webhook test: please tap a button within 2 minutes.',
        buttons: [
          { title: 'Ja', payload: 'live_yes' },
          { title: 'Nein', payload: 'live_no' },
        ],
      });
      await core.outbox.tick();
      assert.equal((await core.outbox.getRow(res.id)).status, 'sent');
      const tapped = await waitFor(async () => {
        const list = (await core.inbound.list({})).results;
        return list.find((m) => m.kind === 'button') || null;
      }, 120_000);
      console.log(JSON.stringify({ telegramWebhook: { hits, tapped: tapped?.buttonPayload || null } }, null, 1));
      assert.ok(tapped, 'the button tap arrived by webhook');
      assert.ok(['live_yes', 'live_no'].includes(tapped.buttonPayload));
    } finally {
      if (before.url) {
        await bot('setWebhook', {
          url: before.url,
          secret_token: env.TELEGRAM_RESTORE_SECRET,
          allowed_updates: before.allowed_updates || [],
          max_connections: before.max_connections,
        });
      } else {
        await bot('deleteWebhook', { drop_pending_updates: false });
      }
    }
  });
});
