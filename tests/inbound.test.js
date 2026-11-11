'use strict';

/** 1.1: inbound messages, media downloads, replies, history, outgoing webhook, sandbox. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { startFakeProviders, JPEG_WITH_EXIF } = require('./helpers/fake-providers');
const { scenario } = require('./helpers/scenario');
const { makeCore, sqliteKnex, loopbackFetch, CREDS, PHONE } = require('./helpers/core');
const { memoryFiles } = require('./helpers/files');
const { DEFAULTS } = require('../server/src/core/settings');
const { signMeta, signTwilio } = require('../server/src/utils/signatures');
const { signDelivery } = require('../server/src/core/hooks-out');
const filetype = require('../server/src/utils/filetype');
const { SANDBOX_NUMBERS } = require('../server/src/testing/numbers');

let fake;
test.before(async () => {
  fake = await startFakeProviders();
});
test.after(() => fake.close());
test.beforeEach(() => fake.reset());

/** @returns {Promise<object>} scenario with a memory media library */
async function inboxScenario(options = {}) {
  const files = memoryFiles();
  const core = await scenario(fake, { files, ...options });
  core.files = files;
  core.received = () => core.events.filter((e) => e.name === 'messagegate.message.received');
  return core;
}

/**
 * Posts a signed Meta webhook with the given messages.
 *
 * @param {object} core
 * @param {object[]} messages
 */
async function metaInbound(core, messages) {
  const account = await core.accounts.getRow(core.wa.id);
  const body = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '9876543210',
        changes: [
          {
            field: 'messages',
            value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '1234567890' }, messages },
          },
        ],
      },
    ],
  };
  const rawBody = Buffer.from(JSON.stringify(body));
  return core.webhooks.meta(account, {
    headers: { 'x-hub-signature-256': signMeta(rawBody, CREDS.meta.appSecret) },
    rawBody,
    body,
  });
}

const waText = (id, text, extra = {}) => ({
  from: PHONE.slice(1),
  id,
  timestamp: '1800000000',
  type: 'text',
  text: { body: text },
  ...extra,
});

test('inbound: WhatsApp text, button and location are stored sealed and the event fires once per message', async () => {
  const core = await inboxScenario();
  await core.sender.send({ to: PHONE, template: 'order_shipped', language: 'de', variables: core.vars });
  await core.drain();
  const wamid = (await core.knex('mg_messages').first()).provider_message_id;
  const messages = [
    waText('wamid.IN1', 'Danke, passt!', { context: { from: '4930000000', id: wamid } }),
    {
      from: PHONE.slice(1),
      id: 'wamid.IN2',
      timestamp: '1800000001',
      type: 'interactive',
      interactive: { type: 'button_reply', button_reply: { id: 'confirm_yes', title: 'Ja' } },
      context: { from: '4930000000', id: wamid },
    },
    {
      from: PHONE.slice(1),
      id: 'wamid.IN3',
      timestamp: '1800000002',
      type: 'button',
      button: { text: 'Stop', payload: 'unsub' },
    },
    {
      from: PHONE.slice(1),
      id: 'wamid.IN4',
      timestamp: '1800000003',
      type: 'location',
      location: { latitude: 52.52, longitude: 13.405, name: 'Shop', address: 'Example street 1' },
    },
  ];
  assert.equal((await metaInbound(core, messages)).status, 200);
  assert.equal((await metaInbound(core, messages)).status, 200, 'provider retry');
  const events = core.received();
  assert.equal(events.length, 4, 'exactly one event per message');
  const [text, button, quick, location] = events.map((e) => e.payload);
  assert.equal(text.kind, 'text');
  assert.ok(text.replyTo, 'context.id links the reply to our message');
  assert.equal(button.buttonPayload, 'confirm_yes');
  assert.equal(quick.buttonPayload, 'unsub');
  assert.equal(location.kind, 'location');
  for (const e of events)
    assert.ok(!JSON.stringify(e.payload).includes('Danke') && !JSON.stringify(e.payload).includes('49151'));
  const raw = await core.knex('mg_inbound').where('document_id', text.inboundId).first();
  assert.ok(!JSON.stringify(raw).includes('Danke'), 'text is sealed at rest');
  const dto = await core.inbound.get(text.inboundId);
  assert.equal(dto.text, 'Danke, passt!');
  assert.equal(dto.contact.phoneMasked, '+491•••89');
  assert.equal((await core.inbound.get(location.inboundId)).location.name, 'Shop');
  const list = await core.inbound.list({ kind: 'button' });
  assert.equal(list.pagination.total, 2);
});

test('inbound media: WhatsApp image is downloaded once, EXIF is stripped, stored and readable as buffer/base64/stream', async () => {
  const core = await inboxScenario();
  const image = {
    from: PHONE.slice(1),
    id: 'wamid.IMG',
    timestamp: '1800000000',
    type: 'image',
    image: { id: '9000001', mime_type: 'image/jpeg', caption: 'Quittung' },
  };
  await metaInbound(core, [image]);
  await metaInbound(core, [image]);
  const [event] = core.received();
  assert.deepEqual(event.payload.media, { status: 'pending' });
  const [first, second] = await Promise.all([core.inbound.mediaTick(), core.inbound.mediaTick()]);
  assert.deepEqual([...first, ...second], ['ready']);
  assert.equal(fake.count('meta.mediaFile'), 1, 'single download');
  const media = fake.of('meta.mediaFile')[0];
  assert.equal(media.headers.authorization, `Bearer ${CREDS.meta.accessToken}`);
  const ready = core.events.filter((e) => e.name === 'messagegate.media.ready');
  assert.equal(ready.length, 1);
  const dto = await core.inbound.get(event.payload.inboundId);
  assert.equal(dto.media.status, 'ready');
  assert.equal(dto.media.caption, 'Quittung');
  const file = await core.inbound.getMedia(dto.id);
  assert.equal(file.mime, 'image/jpeg');
  assert.ok(!file.data.includes(Buffer.from('GPS!!')), 'EXIF removed');
  assert.ok(file.data.length < JPEG_WITH_EXIF.length);
  assert.equal((await core.inbound.getMedia(dto.id, { as: 'base64' })).data, file.data.toString('base64'));
  const stream = (await core.inbound.getMedia(dto.id, { as: 'stream' })).data;
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  assert.deepEqual(Buffer.concat(chunks), file.data);
  // Signed short-lived URL for services that fetch by URL.
  const { url, expiresAt } = await core.inbound.createMediaUrl(dto.id, { ttlSeconds: 60 });
  assert.ok(expiresAt <= core.clock.t + 61_000);
  const token = url.split('/files/')[1];
  const ref = await core.attachments.openLink(token);
  assert.equal((await core.attachments.source(ref)).type, 'inbound');
  core.advance(61_000);
  assert.equal(await core.attachments.openLink(token), null);
});

test('inbound media: oversize, blocked type, MIME mismatch, expired id and scan verdicts', async () => {
  const core = await inboxScenario();
  const { revision } = await core.settings.getWithRevision();
  await core.settings.save({ ...DEFAULTS, inboundMedia: { ...DEFAULTS.inboundMedia, maxMb: 1 } }, revision);
  const msg = (id, mediaId, mime, type = 'document') => ({
    from: PHONE.slice(1),
    id,
    timestamp: '1800000000',
    type,
    [type]: { id: mediaId, mime_type: mime, filename: 'x' },
  });
  fake.queue('meta.media', {
    status: 200,
    json: { url: `${fake.url}/meta-cdn/big`, mime_type: 'application/pdf', file_size: 5 * 1024 * 1024 },
  });
  await metaInbound(core, [msg('w1', '9000002', 'application/pdf')]);
  await core.inbound.mediaTick();
  await metaInbound(core, [msg('w2', '9000003', 'application/x-msdownload')]);
  await core.inbound.mediaTick();
  // Declared PDF, the bytes are a JPEG.
  await metaInbound(core, [msg('w3', '9000004', 'application/pdf')]);
  await core.inbound.mediaTick();
  fake.queue('meta.media', { status: 404, json: { error: { code: 100 } } });
  await metaInbound(core, [msg('w4', '9000005', 'image/jpeg', 'image')]);
  await core.inbound.mediaTick();
  // Streaming cap: no content-length match, body larger than allowed.
  fake.queue('meta.media', { status: 200, json: { url: `${fake.url}/meta-cdn/huge`, mime_type: 'image/jpeg' } });
  fake.queue('meta.mediaFile', { status: 200, body: Buffer.alloc(2 * 1024 * 1024, 0xff), type: 'image/jpeg' });
  await metaInbound(core, [msg('w5', '9000006', 'image/jpeg', 'image')]);
  await core.inbound.mediaTick();
  const failed = core.events.filter((e) => e.name === 'messagegate.media.failed').map((e) => e.payload.code);
  assert.deepEqual(failed, [
    'MEDIA_TOO_LARGE',
    'MEDIA_TYPE_BLOCKED',
    'MEDIA_TYPE_MISMATCH',
    'MEDIA_EXPIRED',
    'MEDIA_TOO_LARGE',
  ]);
  // A media URL on another host is refused (no SSRF through provider answers).
  fake.queue('meta.media', { status: 200, json: { url: 'https://169.254.169.254/latest', mime_type: 'image/jpeg' } });
  await metaInbound(core, [msg('w6', '9000007', 'image/jpeg', 'image')]);
  await core.inbound.mediaTick();
  assert.equal(core.events.at(-1).payload.code, 'MEDIA_HOST_REFUSED');

  // Scanner: quarantine until clean, infected files are dropped.
  const verdicts = ['pending', 'clean'];
  core.inbound.onMediaScan(async () => verdicts.shift());
  await metaInbound(core, [msg('w7', '9000008', 'image/jpeg', 'image')]);
  assert.deepEqual(await core.inbound.mediaTick(), ['quarantined']);
  const row = await core.knex('mg_inbound').where('provider_key', 'meta:w7').first();
  assert.equal(row.media_file_id, null, 'not stored while quarantined');
  await assert.rejects(core.inbound.getMedia(row.document_id), { code: 'MEDIA_NOT_READY' });
  core.advance(301_000);
  assert.deepEqual(await core.inbound.mediaTick(), ['ready']);
  core.inbound.onMediaScan(async () => 'infected');
  await metaInbound(core, [msg('w8', '9000009', 'image/jpeg', 'image')]);
  await core.inbound.mediaTick();
  assert.equal(core.events.at(-1).payload.code, 'MEDIA_INFECTED');
});

test('inbound: Telegram photo, voice and inline-keyboard press; callbacks are answered', async () => {
  const core = await inboxScenario();
  const tg = await core.accounts.create({
    channel: 'telegram',
    provider: 'telegram',
    name: 'TG',
    config: CREDS.telegram,
  });
  const account = await core.accounts.getRow(tg.id);
  const config = core.accounts.configOf(account);
  const token = await core.contacts.createLinkToken(core.contact.id);
  await core.contacts.consumeLinkToken(token, '424242');
  const send = (update) =>
    core.webhooks.telegram(account, {
      headers: { 'x-telegram-bot-api-secret-token': config.secretToken },
      body: update,
    });
  const chat = { id: 424242, type: 'private' };
  await core.sender.send({
    contactId: core.contact.document_id,
    channel: 'telegram',
    text: 'Termin?',
    buttons: [{ payload: 'yes', title: 'Ja' }],
  });
  await core.drain();
  const sent = fake.of('telegram.send')[0].json;
  assert.deepEqual(sent.reply_markup, { inline_keyboard: [[{ text: 'Ja', callback_data: 'yes' }]] });
  const ourId = sent && (await core.knex('mg_messages').first()).provider_message_id.split(':')[1];
  await send({
    update_id: 1,
    message: {
      message_id: 10,
      date: 1800000000,
      chat,
      photo: [
        { file_id: 'AgACAgIAAxkBAAIB', file_size: 10 },
        { file_id: 'AgACAgIAAxkBAAIC', file_size: 70 },
      ],
      caption: 'Foto',
    },
  });
  await send({
    update_id: 2,
    message: {
      message_id: 11,
      date: 1800000001,
      chat,
      voice: { file_id: 'AwACAgIAAxkBAAID', duration: 4, mime_type: 'audio/ogg' },
    },
  });
  await send({
    update_id: 3,
    callback_query: { id: 'cbq-1', from: { id: 424242 }, data: 'yes', message: { message_id: Number(ourId), chat } },
  });
  await send({
    update_id: 3,
    callback_query: { id: 'cbq-1', from: { id: 424242 }, data: 'yes', message: { message_id: Number(ourId), chat } },
  });
  const events = core.received().map((e) => e.payload);
  assert.deepEqual(
    events.map((e) => [e.kind, e.buttonPayload || null]),
    [
      ['media', null],
      ['media', null],
      ['button', 'yes'],
    ]
  );
  assert.ok(events[2].replyTo, 'the press links to our message');
  assert.equal(fake.count('telegram.answerCallback'), 1);
  assert.equal(fake.of('telegram.getFile').length, 0);
  fake.queue('telegram.file', { status: 200, body: JPEG_WITH_EXIF, type: 'image/jpeg' });
  fake.queue('telegram.file', { status: 200, body: Buffer.from('OggS\u0000\u0002voice', 'latin1'), type: 'audio/ogg' });
  await core.inbound.mediaTick();
  assert.equal(fake.of('telegram.getFile')[0].json.file_id, 'AgACAgIAAxkBAAIC', 'largest photo size');
  const photo = await core.inbound.get(events[0].inboundId);
  assert.equal(photo.media.status, 'ready');
  assert.equal(photo.media.mime, 'image/jpeg');
  const voice = await core.inbound.get(events[1].inboundId);
  assert.equal(voice.media.status, 'ready');
  assert.equal(voice.media.duration, 4);
});

test('inbound: Twilio MMS media follows the redirect only to Twilio hosts; button payloads and SMS reply windows', async () => {
  const core = await inboxScenario();
  const sms = await core.accounts.create({ channel: 'sms', provider: 'twilio', name: 'Twilio', config: CREDS.twilio });
  const account = await core.accounts.getRow(sms.id);
  const url = `https://cms.example.test/api/magic-messagegate/webhooks/twilio/${account.webhook_path}`;
  const post = (params) => {
    const all = { AccountSid: CREDS.twilio.accountSid, ...params };
    return core.webhooks.twilio(account, {
      headers: { 'x-twilio-signature': signTwilio(url, all, CREDS.twilio.authToken) },
      params: all,
      url,
    });
  };
  await core.sender.send({
    to: PHONE,
    channel: 'sms',
    template: 'order_shipped',
    language: 'de',
    variables: core.vars,
  });
  await core.drain();
  const hex = (n) => n.toString(16).padStart(32, '0');
  const mediaUrl = `${fake.url}/twilio/2010-04-01/Accounts/${CREDS.twilio.accountSid}/Messages/MM${hex(1)}/Media/ME${hex(2)}`;
  await post({
    MessageSid: `MM${hex(1)}`,
    From: PHONE,
    To: '+15005550006',
    Body: '',
    NumMedia: '1',
    MediaUrl0: mediaUrl,
    MediaContentType0: 'image/png',
  });
  await post({ MessageSid: `SM${hex(3)}`, From: PHONE, To: '+15005550006', Body: 'JA' });
  await post({
    MessageSid: `SM${hex(4)}`,
    From: PHONE,
    To: '+15005550006',
    Body: 'Ja',
    ButtonPayload: 'confirm',
    ButtonText: 'Ja',
  });
  await post({
    MessageSid: `MM${hex(5)}`,
    From: PHONE,
    To: '+15005550006',
    Body: '',
    NumMedia: '1',
    MediaUrl0: 'https://evil.example.com/x',
    MediaContentType0: 'image/png',
  });
  const events = core.received().map((e) => e.payload);
  assert.equal(events.length, 4);
  assert.ok(events[1].replyTo, 'SMS answer within the window links to the last outbound SMS');
  assert.equal(events[2].buttonPayload, 'confirm');
  await core.inbound.mediaTick();
  const media = fake.of('twilio.media')[0];
  assert.match(media.headers.authorization, /^Basic /);
  assert.equal(fake.count('twilio.cdn'), 1);
  assert.equal(
    fake.of('twilio.cdn')[0].headers.authorization,
    undefined,
    'credentials are not sent to the storage host'
  );
  assert.equal((await core.inbound.get(events[0].inboundId)).media.status, 'ready');
  const failed = core.events.filter((e) => e.name === 'messagegate.media.failed');
  assert.deepEqual(
    failed.map((e) => e.payload.code),
    ['MEDIA_HOST_REFUSED']
  );
});

test('reply: same channel and account; WhatsApp free text needs the 24-hour window; markProcessed is idempotent', async () => {
  const core = await inboxScenario();
  await metaInbound(core, [waText('wamid.R1', 'Wann kommt das Paket?')]);
  const [event] = core.received();
  const sent = await core.reply(event.payload.inboundId, {
    text: 'Morgen.',
    buttons: [{ payload: 'ok', title: 'OK' }],
  });
  assert.equal(sent.channel, 'whatsapp');
  await core.drain();
  const body = fake.of('meta.send')[0].json;
  assert.equal(body.type, 'interactive');
  assert.deepEqual(body.interactive.action.buttons, [{ type: 'reply', reply: { id: 'ok', title: 'OK' } }]);
  core.advance(25 * 3_600_000);
  await assert.rejects(core.reply(event.payload.inboundId, { text: 'Noch da?' }), { code: 'WINDOW_CLOSED' });
  const viaTemplate = await core.reply(event.payload.inboundId, {
    template: 'order_shipped',
    language: 'de',
    variables: core.vars,
  });
  assert.equal(viaTemplate.channel, 'whatsapp');
  await assert.rejects(core.reply(event.payload.inboundId, { to: '+4917612345678', text: 'x' }), {
    code: 'INVALID_REQUEST',
  });
  const a = await core.inbound.markProcessed(event.payload.inboundId);
  const b = await core.inbound.markProcessed(event.payload.inboundId);
  assert.equal(a.alreadyProcessed, false);
  assert.equal(b.alreadyProcessed, true);
  assert.equal(a.processedAt, b.processedAt);
  const history = await core.inbound.history({ inboundId: event.payload.inboundId });
  assert.deepEqual(
    history.items.map((i) => [i.direction, i.kind]),
    [
      ['inbound', 'text'],
      ['outbound', 'text'],
      ['outbound', 'template'],
    ]
  );
  assert.equal(history.items[0].text, 'Wann kommt das Paket?');
  assert.equal(history.items[0].status, 'processed');
});

test('GDPR: export includes inbound text, erasure removes inbound rows and stored files; retention purges', async () => {
  const core = await inboxScenario();
  await metaInbound(core, [
    waText('wamid.G1', 'Meine Adresse ist geheim'),
    {
      from: PHONE.slice(1),
      id: 'wamid.G2',
      timestamp: '1800000000',
      type: 'image',
      image: { id: '9000010', mime_type: 'image/jpeg' },
    },
  ]);
  await core.inbound.mediaTick();
  const exported = await core.exportContact(core.contact.document_id);
  assert.equal(exported.inbound.length, 2);
  assert.equal(exported.inbound[0].text, 'Meine Adresse ist geheim');
  assert.equal(core.files.rows.size, 1);
  await core.eraseContact(core.contact.document_id);
  assert.equal((await core.knex('mg_inbound').count({ n: '*' }))[0].n, 0);
  assert.equal(core.files.rows.size, 0, 'stored media removed');

  const again = await inboxScenario();
  await metaInbound(again, [waText('wamid.P1', 'alt')]);
  again.advance(91 * 86_400_000);
  assert.equal(await again.inbound.purge(90), 1);
});

test('outgoing webhook: selected events are delivered once, signed, retried; private URLs are refused', async () => {
  const received = [];
  let fail = 1;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(fail-- > 0 ? 500 : 204);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const hookUrl = `http://127.0.0.1:${server.address().port}/hook`;
  try {
    // The receiver is a local http server: the test transport maps https://127.0.0.1 to it.
    const fetchImpl = (target, init) =>
      loopbackFetch(String(target).replace('https://127.0.0.1', 'http://127.0.0.1'), init);
    const core = await inboxScenario({
      fetchImpl,
      config: { providers: fake.providers, outgoingWebhooks: { allowPrivateHosts: true } },
    });
    const { secret } = await core.hooksOut.rotateSecret();
    assert.match(secret, /^whsec_/);
    const { revision } = await core.settings.getWithRevision();
    await core.settings.save(
      {
        ...DEFAULTS,
        outgoingWebhook: { enabled: true, url: hookUrl.replace('http:', 'https:'), events: ['message.received'] },
      },
      revision
    );
    core.advance(10_000);
    await metaInbound(core, [waText('wamid.H1', 'Hallo')]);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(await core.hooksOut.tick(), ['retry']);
    assert.deepEqual(await core.hooksOut.tick(), [], 'backoff');
    core.advance(61_000);
    assert.deepEqual(await core.hooksOut.tick(), ['delivered']);
    assert.equal(received.length, 2);
    const last = received[1];
    const expected = signDelivery(secret, last.headers['x-messagegate-timestamp'], last.body);
    assert.equal(last.headers['x-messagegate-signature'], expected);
    assert.equal(last.headers['x-messagegate-event'], 'message.received');
    const body = JSON.parse(last.body);
    assert.equal(body.event, 'message.received');
    assert.ok(!last.body.includes('Hallo') && !last.body.includes('49151'), 'no text or phone in deliveries');
    await core.drain();
    assert.equal(received.length, 2, 'status events are not selected');
  } finally {
    await new Promise((r) => server.close(r));
  }
  const strict = await inboxScenario();
  const { revision } = await strict.settings.getWithRevision();
  await strict.settings.save(
    { ...DEFAULTS, outgoingWebhook: { enabled: true, url: 'https://10.0.0.8/hook', events: ['message.received'] } },
    revision
  );
  await strict.hooksOut.rotateSecret();
  await metaInbound(strict, [waText('wamid.H2', 'x')]);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(await strict.hooksOut.tick(), ['failed']);
  assert.equal((await strict.knex('mg_webhook_out').first()).last_code, 'URL_REFUSED');
});

test('sandbox: deterministic outcomes by magic number, simulated inbound with media, no network', async () => {
  const files = memoryFiles();
  const core = await makeCore({ config: { providers: { mode: 'sandbox' } }, files, now: () => 1_800_000_000_000 });
  await core.accounts.create({ channel: 'whatsapp', provider: 'meta', name: 'WA', config: CREDS.meta });
  await core.accounts.create({
    channel: 'rcs',
    provider: 'twilio',
    name: 'RCS',
    config: { ...CREDS.twilio, messagingServiceSid: `MG${'c'.repeat(32)}` },
  });
  await core.accounts.create({ channel: 'sms', provider: 'seven', name: 'SMS', config: CREDS.seven });
  const { revision } = await core.settings.getWithRevision();
  await core.settings.save({ ...DEFAULTS, requireConsent: false }, revision);
  const drain = async () => {
    for (let i = 0; i < 10; i += 1) if (!(await core.outbox.tick()).claimed) break;
  };
  const sendText = async (to) => {
    await core.contacts.upsertByPhone(to);
    const contact = await core.contacts.getRowByPhone(to);
    await core.contacts.touch(contact.id, 'inbound', 1_800_000_000_000, 'whatsapp');
    return core.sender.send({ to, text: 'Hallo' });
  };
  const read = await sendText(SANDBOX_NUMBERS.read);
  const notWa = await sendText(SANDBOX_NUMBERS.notOnWhatsApp);
  const both = await sendText(SANDBOX_NUMBERS.rcsNotCapable);
  const uncertain = await sendText(SANDBOX_NUMBERS.uncertain);
  await drain();
  assert.equal((await core.outbox.detail(read.id)).status, 'read');
  const wa = await core.outbox.detail(notWa.id);
  assert.equal(wa.errorCode, 'META_131026');
  assert.equal(wa.fallbacks[0].channel, 'rcs');
  assert.equal(wa.fallbacks[0].status, 'delivered');
  assert.equal((await core.outbox.detail(both.id)).status, 'delivered', 'WhatsApp delivers for this number');
  assert.equal((await core.outbox.detail(uncertain.id)).status, 'uncertain');

  const inbound = await core.simulateInbound({
    to: SANDBOX_NUMBERS.delivered,
    text: 'Hi',
    media: { mime: 'application/pdf', size: 4096, filename: 'beleg.pdf' },
  });
  assert.equal(inbound.media.status, 'pending');
  await core.inbound.mediaTick();
  const file = await core.inbound.getMedia(inbound.id);
  assert.equal(file.size, 4096);
  assert.equal(file.filename, 'beleg.pdf');
  const big = await core.simulateInbound({
    to: SANDBOX_NUMBERS.delivered,
    media: { mime: 'image/png', size: 30 * 1024 * 1024 },
  });
  const mismatch = await core.simulateInbound({
    to: SANDBOX_NUMBERS.delivered,
    media: { mime: 'image/png', mismatch: true },
  });
  await core.inbound.mediaTick();
  assert.equal((await core.inbound.get(big.id)).media.code, 'MEDIA_TOO_LARGE');
  assert.equal((await core.inbound.get(mismatch.id)).media.code, 'MEDIA_TYPE_MISMATCH');
  const dup = await core.simulateInbound({ to: SANDBOX_NUMBERS.delivered, text: 'x', providerMessageId: 'same' });
  assert.ok(dup.id);
  assert.deepEqual(
    await core.simulateInbound({ to: SANDBOX_NUMBERS.delivered, text: 'x', providerMessageId: 'same' }),
    { duplicate: true }
  );

  const live = await makeCore({ providers: fake.providers });
  await assert.rejects(live.simulateInbound({ to: PHONE, text: 'x' }), { code: 'SANDBOX_ONLY' });
});

test('inbound media: two processes claim the same job once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-mp-'));
  const file = path.join(dir, 'db.sqlite');
  const files = memoryFiles();
  const a = await makeCore({ knex: sqliteKnex(file), providers: fake.providers, files, nodeId: 'a' });
  const b = await makeCore({ knex: sqliteKnex(file), providers: fake.providers, files, nodeId: 'b' });
  await a.accounts.create({ channel: 'whatsapp', provider: 'meta', name: 'WA', config: CREDS.meta });
  const contact = (await a.contacts.upsertByPhone(PHONE)).row;
  const account = (await a.accounts.forChannel('whatsapp'))[0];
  const input = {
    provider: 'meta',
    providerMessageId: 'wamid.MP',
    channel: 'whatsapp',
    contact,
    account,
    kind: 'media',
    media: { ref: { id: '9000011' }, mime: 'image/jpeg' },
    at: Date.now(),
  };
  const [ra, rb] = await Promise.all([a.inbound.record(input), b.inbound.record(input)]);
  assert.equal([ra, rb].filter(Boolean).length, 1, 'one row, one event');
  const results = (await Promise.all([a.inbound.mediaTick(), b.inbound.mediaTick()])).flat();
  assert.deepEqual(results, ['ready']);
  assert.equal(fake.count('meta.mediaFile'), 1);
});

test('filetype: magic bytes, safe names and metadata stripping', () => {
  assert.equal(filetype.detectFamily(Buffer.from('%PDF-1.7')), 'pdf');
  assert.equal(filetype.detectFamily(Buffer.from('<html><script>')), null);
  assert.equal(filetype.matchesType(Buffer.from('OggS\u0000\u0002'), 'audio/ogg'), true);
  assert.equal(filetype.matchesType(Buffer.from('hello'), 'image/png'), false);
  assert.equal(filetype.baseMime('audio/ogg; codecs=opus'), 'audio/ogg');
  assert.equal(filetype.safeFilename('../../etc/pass wd.exe', 'application/pdf'), 'etc-pass-wd.pdf');
  assert.equal(filetype.safeFilename('', 'image/jpeg'), 'file.jpg');
  const stripped = filetype.stripJpegExif(JPEG_WITH_EXIF);
  assert.ok(!stripped.includes(Buffer.from('Exif')));
  assert.equal(filetype.detectFamily(stripped), 'jpeg');
  for (const mime of filetype.DEFAULT_INBOUND_TYPES) {
    assert.ok(filetype.matchesType(filetype.syntheticFile(mime, 100), mime), mime);
  }
});
