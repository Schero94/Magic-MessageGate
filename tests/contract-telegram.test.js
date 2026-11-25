'use strict';

/**
 * Contract: Telegram adapter against the Bot API. Telegram publishes no
 * OpenAPI; tests/contract/specs/telegram.json holds the method and type
 * tables of https://core.telegram.org/bots/api converted to JSON Schema by
 * scripts/contract-specs.mjs (Bot API version recorded inside).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const pinned = require('./contract/specs/telegram.json');
const { validate } = require('./contract/validator');
const { capture } = require('./contract/capture');
const telegram = require('../server/src/adapters/telegram');
const { makeCore, addAccount, CREDS } = require('./helpers/core');

const doc = pinned.spec;
const config = { ...CREDS.telegram, secretToken: 'syntheticSecret_0123456789abcdef' };
const method = (name) => doc.methods[name];
const type = (name) => ({ $ref: `#/types/${name}` });

/**
 * @param {string[]} errors
 * @param {string} what
 */
const ok = (errors, what) => assert.deepEqual(errors, [], `${what}:\n${errors.join('\n')}`);

/** A sent Message as the Bot API returns it (required fields of Message). */
const sentMessage = (id) => ({
  message_id: id,
  date: 1800000000,
  chat: { id: 12345, type: 'private', first_name: 'Synthetic' },
  from: { id: 1, is_bot: true, first_name: 'Synthetic Bot' },
  text: 'Hallo',
});

test('telegram contract: the snapshot comes from the official Bot API page', () => {
  assert.equal(pinned.source.url, 'https://core.telegram.org/bots/api');
  assert.equal(pinned.source.machineReadable, false);
  assert.match(doc.botApiVersion, /^\d+\.\d+$/);
  assert.deepEqual(doc.methods.sendMessage.required, ['text']);
});

test('telegram contract: every request body uses documented parameters', async () => {
  const cases = [
    ['sendMessage', { text: 'Hallo &amp; tschüss' }],
    [
      'sendMessage',
      {
        text: 'Kommst du?',
        buttons: [
          { title: 'Ja', payload: 'yes' },
          { title: 'Nein', payload: 'no' },
        ],
      },
    ],
    ['sendPhoto', { kind: 'photo', url: 'https://cms.example.test/f/a.jpg', caption: 'Rechnung' }],
    ['sendDocument', { kind: 'document', url: 'https://cms.example.test/f/a.pdf', caption: 'Rechnung' }],
  ];
  for (const [name, payload] of cases) {
    const io = capture();
    io.answer(200, { ok: true, result: sentMessage(7) });
    const res = await telegram.send({ config, to: '12345', payload, fetchImpl: io.fetchImpl });
    const [req] = io.requests;
    assert.equal(req.url.origin, 'https://api.telegram.org');
    assert.equal(req.url.pathname, `/bot${config.botToken}/${name}`);
    ok(validate(doc, method(name), req.json), `${name} body`);
    assert.equal(res.outcome, 'accepted');
    assert.equal(res.providerMessageId, '12345:7');
  }
  ok(validate(doc, type('Message'), sentMessage(7)), 'sent Message');

  const io = capture();
  io.answer(200, { ok: true, result: true });
  await telegram.answerCallback({ config, callbackQueryId: '4382bfdwdsb323b2d9', fetchImpl: io.fetchImpl });
  ok(validate(doc, method('answerCallbackQuery'), io.requests[0].json), 'answerCallbackQuery body');
});

test('telegram contract: setWebhook uses a documented secret token and update types', async () => {
  const io = capture();
  io.answer(200, { ok: true, result: true });
  await telegram.setWebhook({
    config,
    webhookUrl: 'https://cms.example.test/api/magic-messagegate/webhooks/telegram/x',
    secretToken: config.secretToken,
    fetchImpl: io.fetchImpl,
  });
  const body = io.requests[0].json;
  ok(validate(doc, method('setWebhook'), body), 'setWebhook body');
  assert.match(method('setWebhook').properties.secret_token.description, /1-256 characters/);
  assert.match(body.secret_token, /^[A-Za-z0-9_-]{1,256}$/);
  for (const update of body.allowed_updates)
    assert.ok(doc.types.Update.properties[update], `${update} is an Update field`);

  const core = await makeCore();
  const account = await addAccount(core, 'telegram');
  const row = await core.accounts.getRow(account.id);
  assert.match(core.accounts.configOf(row).secretToken, /^[A-Za-z0-9_-]{1,256}$/, 'generated secret fits the rules');
});

test('telegram contract: errors and rate limits use ResponseParameters', async () => {
  const error = {
    ok: false,
    error_code: 429,
    description: 'Too Many Requests: retry after 3',
    parameters: { retry_after: 3 },
  };
  ok(validate(doc, type('ResponseParameters'), error.parameters), 'ResponseParameters');
  const io = capture();
  io.answer(429, error);
  const res = await telegram.send({ config, to: '12345', payload: { text: 'x' }, fetchImpl: io.fetchImpl });
  assert.equal(res.outcome, 'transient');
  assert.equal(res.retryAfterMs, 3000);
});

test('telegram contract: getFile answers a documented File and the download path follows it', async () => {
  const file = { file_id: 'AgACAgIAAxkBAAIC', file_unique_id: 'AQADxyz', file_size: 4, file_path: 'photos/file_1.jpg' };
  ok(validate(doc, type('File'), file), 'File');
  const io = capture();
  io.answer(200, { ok: true, result: file });
  io.binary(200, Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg');
  const res = await telegram.downloadMedia({
    config,
    ref: { id: file.file_id },
    maxBytes: 1000,
    fetchImpl: io.fetchImpl,
  });
  ok(validate(doc, method('getFile'), io.requests[0].json), 'getFile body');
  assert.equal(io.requests[1].url.pathname, `/file/bot${config.botToken}/${file.file_path}`);
  assert.equal(res.ok, true);
});

test('telegram contract: documented updates are verified and processed', async () => {
  const core = await makeCore();
  const account = await addAccount(core, 'telegram');
  const row = await core.accounts.getRow(account.id);
  const secret = core.accounts.configOf(row).secretToken;
  const { row: contact } = await core.contacts.upsertByPhone('+4915123456789');
  const token = await core.contacts.createLinkToken(contact.id);
  const chat = { id: 12345, type: 'private', first_name: 'Synthetic' };
  const from = { id: 12345, is_bot: false, first_name: 'Synthetic' };
  const updates = [
    {
      update_id: 1,
      message: { message_id: 1, date: 1800000000, chat, from, text: `/start ${token}` },
    },
    { update_id: 2, message: { message_id: 2, date: 1800000001, chat, from, text: 'Hallo' } },
    {
      update_id: 3,
      message: {
        message_id: 3,
        date: 1800000002,
        chat,
        from,
        photo: [
          { file_id: 'AgACAgIAAxkBAAIC', file_unique_id: 'a', width: 90, height: 90, file_size: 10 },
          { file_id: 'AgACAgIAAxkBAAID', file_unique_id: 'b', width: 800, height: 800, file_size: 100 },
        ],
        caption: 'Foto',
      },
    },
    {
      update_id: 4,
      message: { message_id: 4, date: 1800000003, chat, from, location: { latitude: 52.52, longitude: 13.405 } },
    },
    {
      update_id: 5,
      callback_query: {
        id: '4382bfdwdsb323b2d9',
        from,
        chat_instance: '-1',
        data: 'yes',
        message: { message_id: 9, date: 1800000004, chat },
      },
    },
  ];
  for (const update of updates) {
    ok(validate(doc, type('Update'), update), `update ${update.update_id}`);
    const headers = { 'x-telegram-bot-api-secret-token': secret };
    assert.equal((await core.webhooks.telegram(row, { headers, body: update })).status, 200);
    const wrong = { 'x-telegram-bot-api-secret-token': `${secret}x` };
    assert.equal((await core.webhooks.telegram(row, { headers: wrong, body: update })).status, 401);
  }
  const inbound = (await core.inbound.list({})).results;
  assert.deepEqual(inbound.map((m) => m.kind).sort(), ['button', 'location', 'media', 'text']);
});

test('telegram contract: Test connection calls getMe and reads a documented BotFullInfo (Bot API 10.5)', async () => {
  // Bot API 10.5 split BotFullInfo out of User: getMe returns BotFullInfo and the getMe-only
  // fields (can_join_groups, supports_inline_queries, ...) are no longer part of User.
  assert.ok(Number(doc.botApiVersion) >= 10.5, 'snapshot from Bot API 10.5 or newer');
  assert.deepEqual(method('getMe').properties, {}, 'getMe takes no parameters');
  assert.equal(doc.types.User.properties.can_join_groups, undefined);
  const bot = {
    id: 1,
    is_bot: true,
    first_name: 'Synthetic Bot',
    username: 'synthetic_bot',
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_guest_queries: false,
    supports_inline_queries: false,
    needs_inline_query_location: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    has_topic_sidebar: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };
  ok(validate(doc, type('BotFullInfo'), bot), 'BotFullInfo');
  const io = capture();
  io.answer(200, { ok: true, result: bot });
  const res = await telegram.testConnection({ config, fetchImpl: io.fetchImpl });
  const [req] = io.requests;
  assert.equal(req.method, 'GET');
  assert.equal(req.url.pathname, `/bot${config.botToken}/getMe`);
  assert.equal(req.json, null, 'no request body');
  // The adapter reads only `username`, which BotFullInfo documents.
  assert.ok(doc.types.BotFullInfo.properties.username);
  assert.deepEqual(res, { ok: true, code: null, info: { username: 'synthetic_bot' } });
});

test('telegram contract: a callback query with inline_message_id and no message (Bot API 10.5) is recorded and answered', async () => {
  // Since 10.5 a bot can choose (setMySettings callback_query_mode) to get inline_message_id
  // instead of message for buttons in its own messages. The press is still recorded for the
  // contact of the private chat (from.id), without a link to the outbound message.
  const io = capture();
  const core = await makeCore({ fetchImpl: io.fetchImpl });
  const account = await addAccount(core, 'telegram');
  const row = await core.accounts.getRow(account.id);
  const secret = core.accounts.configOf(row).secretToken;
  const { row: contact } = await core.contacts.upsertByPhone('+4915123456789');
  const token = await core.contacts.createLinkToken(contact.id);
  const chat = { id: 12345, type: 'private', first_name: 'Synthetic' };
  const from = { id: 12345, is_bot: false, first_name: 'Synthetic' };
  const headers = { 'x-telegram-bot-api-secret-token': secret };
  const start = { update_id: 1, message: { message_id: 1, date: 1800000000, chat, from, text: `/start ${token}` } };
  assert.equal((await core.webhooks.telegram(row, { headers, body: start })).status, 200);

  const update = {
    update_id: 2,
    callback_query: {
      id: '4382bfdwdsb323b2e0',
      from,
      inline_message_id: 'AgAAAN3wAQB7_synthetic',
      chat_instance: '-1',
      data: 'yes',
    },
  };
  assert.ok(doc.types.CallbackQuery.properties.inline_message_id, 'inline_message_id is documented');
  assert.ok(!doc.types.CallbackQuery.required.includes('message'), 'message is optional');
  ok(validate(doc, type('Update'), update), 'update with inline_message_id');
  io.answer(200, { ok: true, result: true });
  assert.equal((await core.webhooks.telegram(row, { headers, body: update })).status, 200);

  const inbound = (await core.inbound.list({})).results;
  assert.equal(inbound.length, 1);
  assert.equal(inbound[0].kind, 'button');
  assert.equal(inbound[0].buttonPayload, 'yes');
  assert.equal(inbound[0].replyTo, null, 'no outbound message to link to');
  const answers = io.requests.filter((req) => req.url.pathname.endsWith('/answerCallbackQuery'));
  assert.equal(answers.length, 1, 'the loading indicator is stopped');
  ok(validate(doc, method('answerCallbackQuery'), answers[0].json), 'answerCallbackQuery body');
});
