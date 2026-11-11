'use strict';

/** 1.1: RCS channel, attachments, media templates, HLR checks and dry runs. */
const test = require('node:test');
const assert = require('node:assert/strict');

const { startFakeProviders } = require('./helpers/fake-providers');
const { scenario } = require('./helpers/scenario');
const { CREDS, PHONE } = require('./helpers/core');
const { memoryFiles, PDF, PNG } = require('./helpers/files');
const { DEFAULTS } = require('../server/src/core/settings');
const { signTwilio } = require('../server/src/utils/signatures');
const { checkUrl, isBlockedAddress, resolvesPublic } = require('../server/src/utils/url-guard');
const { sniffMatches } = require('../server/src/core/attachments');

const MSG = `MG${'c'.repeat(32)}`;

let fake;
test.before(async () => {
  fake = await startFakeProviders();
});
test.after(() => fake.close());
test.beforeEach(() => fake.reset());

/**
 * Scenario plus an RCS account, an RCS template and RCS consent.
 *
 * @param {object} [options]
 * @returns {Promise<object>}
 */
async function rcsScenario(options = {}) {
  const files = memoryFiles();
  const core = await scenario(fake, { files, ...options });
  core.files = files;
  core.rcs = await core.accounts.create({
    channel: 'rcs',
    provider: 'twilio',
    name: 'RCS',
    config: { ...CREDS.twilio, messagingServiceSid: MSG },
  });
  await core.templates.create({
    key: 'order_shipped',
    channel: 'rcs',
    language: 'de',
    name: 'Order shipped (RCS)',
    content: { text: 'Hallo {{name}}, Bestellung {{order}} ist unterwegs.' },
  });
  await core.contacts.setConsent(core.contact.id, 'rcs', 'granted', 'test');
  return core;
}

/**
 * Signed Twilio status callback for the RCS account.
 *
 * @param {object} core
 * @param {object} params
 */
async function twilioStatus(core, params) {
  const account = await core.accounts.getRow(core.rcs.id);
  const url = `https://cms.example.test/api/magic-messagegate/webhooks/twilio/${account.webhook_path}`;
  const all = { AccountSid: CREDS.twilio.accountSid, ...params };
  return core.webhooks.twilio(account, {
    headers: { 'x-twilio-signature': signTwilio(url, all, CREDS.twilio.authToken) },
    params: all,
    url,
  });
}

test('rcs: an RCS account needs the Messaging Service SID of the RCS sender', async () => {
  const core = await rcsScenario();
  await assert.rejects(
    core.accounts.create({ channel: 'rcs', provider: 'twilio', name: 'x', config: CREDS.twilio }),
    (e) => e.code === 'CONFIG_INVALID' && e.details.field === 'messagingServiceSid'
  );
  await assert.rejects(core.accounts.create({ channel: 'rcs', provider: 'seven', name: 'x', config: CREDS.seven }), {
    code: 'CONFIG_INVALID',
  });
});

test('rcs: default chain whatsapp → rcs → sms; 131026 falls to RCS, 63036 to SMS; capability is learned', async () => {
  const core = await rcsScenario();
  assert.deepEqual(DEFAULTS.routing.defaultChain, ['whatsapp', 'rcs', 'sms']);
  fake.queue('meta.send', { status: 400, json: { error: { code: 131026, message: 'x' } } });
  const first = await core.sender.send({ to: PHONE, template: 'order_shipped', language: 'de', variables: core.vars });
  assert.equal(first.channel, 'whatsapp');
  await core.drain();
  const rcsSend = fake.of('twilio.send')[0].form;
  assert.equal(rcsSend.To, `rcs:${PHONE}`, 'no Twilio-side fallback: MessageGate decides');
  assert.equal(rcsSend.MessagingServiceSid, MSG);
  assert.equal(rcsSend.Body, 'Hallo Ana, Bestellung A-1 ist unterwegs.');
  assert.match(rcsSend.StatusCallback, /webhooks\/twilio\//);
  const rcsRow = await core.knex('mg_messages').where({ channel: 'rcs' }).first();
  const sid = rcsRow.provider_message_id;
  assert.equal(
    (await twilioStatus(core, { MessageSid: sid, MessageStatus: 'undelivered', ErrorCode: '63036' })).status,
    200
  );
  await core.drain();
  assert.equal(fake.count('seven.send'), 1, 'SMS fallback after RCS');
  const contact = await core.contacts.getRowById(core.contact.id);
  assert.equal(contact.rcs_capability, 'not_capable');
  const caps = await core.lookup.capabilities(PHONE);
  assert.equal(caps.rcs, 'not_capable');
  assert.equal(caps.whatsapp, 'unreachable');
  // The learned state skips RCS on the next message.
  const preview = await core.sender.preview({
    to: PHONE,
    template: 'order_shipped',
    language: 'de',
    variables: core.vars,
  });
  assert.deepEqual(
    preview.steps.map((s) => [s.channel, s.code || 'ok']),
    [
      ['whatsapp', 'SUPPRESSED'],
      ['rcs', 'RCS_NOT_CAPABLE'],
      ['sms', 'ok'],
    ]
  );
});

test('rcs: delivered and read callbacks move the timeline forward and mark the number capable', async () => {
  const core = await rcsScenario();
  const sent = await core.sender.send({
    to: PHONE,
    channel: 'rcs',
    template: 'order_shipped',
    language: 'de',
    variables: core.vars,
  });
  await core.drain();
  const row = await core.outbox.getRow(sent.id);
  await twilioStatus(core, { MessageSid: row.provider_message_id, MessageStatus: 'read' });
  await twilioStatus(core, { MessageSid: row.provider_message_id, MessageStatus: 'delivered' });
  const detail = await core.outbox.detail(sent.id);
  assert.equal(detail.status, 'read');
  assert.deepEqual(
    detail.timeline.map((e) => e.type),
    ['queued', 'sent', 'read']
  );
  assert.equal((await core.contacts.getRowById(core.contact.id)).rcs_capability, 'capable');
});

test('rcs: a rich card becomes a Twilio Content template; sends use ContentSid and numbered variables', async () => {
  const core = await rcsScenario();
  const card = await core.templates.create({
    key: 'pickup_ready',
    channel: 'rcs',
    language: 'de',
    name: 'Pickup',
    content: {
      title: 'Abholbereit, {{name}}',
      text: 'Bestellung {{order}} liegt bereit.',
      mediaUrl: 'https://shop.example.com/pickup.png',
      buttons: [
        { type: 'URL', title: 'Details', url: 'https://shop.example.com/o' },
        { type: 'QUICK_REPLY', title: 'Morgen', payload: 'pickup_tomorrow' },
      ],
    },
  });
  assert.equal(card.approvalStatus, 'DRAFT');
  await assert.rejects(
    core.sender.send({ to: PHONE, channel: 'rcs', template: 'pickup_ready', variables: core.vars }),
    { code: 'TEMPLATE_NOT_APPROVED' }
  );
  const approved = await core.templates.submitToTwilio(card.id, core.rcs.id);
  assert.equal(approved.approvalStatus, 'APPROVED');
  assert.match(approved.content.contentSid, /^HX[0-9a-f]{32}$/);
  const created = fake.of('twilio.content')[0].json;
  assert.equal(created.types['twilio/card'].title, 'Abholbereit, {{1}}');
  assert.equal(created.types['twilio/card'].body, 'Bestellung {{2}} liegt bereit.');
  assert.deepEqual(created.types['twilio/card'].actions[1], {
    type: 'QUICK_REPLY',
    title: 'Morgen',
    id: 'pickup_tomorrow',
  });
  assert.ok(created.types['twilio/text'].body.includes('{{2}}'));
  await core.sender.send({ to: PHONE, channel: 'rcs', template: 'pickup_ready', language: 'de', variables: core.vars });
  await core.drain();
  const form = fake.of('twilio.send')[0].form;
  assert.equal(form.ContentSid, approved.content.contentSid);
  assert.deepEqual(JSON.parse(form.ContentVariables), { 1: 'Ana', 2: 'A-1' });
  assert.equal(form.Body, undefined);
  // Editing the card drops the stale Content SID.
  const edited = await core.templates.update(card.id, { content: { ...approved.content, text: 'Neu {{order}}' } });
  assert.equal(edited.approvalStatus, 'DRAFT');
  assert.equal(edited.content.contentSid, undefined);
});

test('attachments: media-library PDF goes as WhatsApp document, RCS media and SMS signed link', async () => {
  const core = await rcsScenario();
  const fileId = core.files.add(
    { name: 'invoice.pdf', mime: 'application/pdf', size: 12.5, url: '/uploads/invoice_1.pdf' },
    PDF
  );
  // WhatsApp session message (window open) with a document.
  await core.contacts.touch(core.contact.id, 'inbound', core.clock.t, 'whatsapp');
  await core.sender.send({ to: PHONE, channel: 'whatsapp', text: 'Ihre Rechnung', attachment: { fileId } });
  await core.drain();
  const wa = fake.of('meta.send')[0].json;
  assert.equal(wa.type, 'document');
  assert.deepEqual(wa.document, {
    link: 'https://cms.example.test/uploads/invoice_1.pdf',
    caption: 'Ihre Rechnung',
    filename: 'invoice.pdf',
  });
  await core.sender.send({ to: PHONE, channel: 'rcs', text: 'Ihre Rechnung', attachment: { fileId } });
  await core.drain();
  assert.equal(fake.of('twilio.send')[0].form.MediaUrl, 'https://cms.example.test/uploads/invoice_1.pdf');

  await core.sender.send({
    to: PHONE,
    channel: 'sms',
    template: 'order_shipped',
    language: 'de',
    variables: core.vars,
    attachment: { fileId },
  });
  await core.drain();
  const text = fake.of('seven.send')[0].form.text;
  const link = /https:\/\/cms\.example\.test\/api\/magic-messagegate\/files\/(\S+)$/.exec(text);
  assert.ok(link, 'SMS carries a signed link');
  const ref = await core.attachments.openLink(link[1]);
  assert.equal(ref.fileId, fileId);
  const stored = await core.knex('mg_attachment_links').first();
  assert.ok(!JSON.stringify(stored).includes('invoice'), 'only a sealed reference is stored');
  // Tampered, foreign or expired tokens all fail the same way.
  const [id, exp, sig] = link[1].split('.');
  assert.equal(await core.attachments.openLink(`${id}.${exp}.${'0'.repeat(32)}`), null);
  assert.equal(await core.attachments.openLink(`${id}.${Number(exp) + 1}.${sig}`), null);
  core.advance(73 * 3_600_000);
  assert.equal(await core.attachments.openLink(link[1]), null);
});

test('attachments: type allow-list, magic bytes, SSRF URL policy and per-channel size caps', async () => {
  const core = await rcsScenario();
  const exe = core.files.add({ name: 'x.exe', mime: 'application/x-msdownload', size: 1, url: '/uploads/x.exe' });
  await assert.rejects(core.sender.send({ to: PHONE, channel: 'sms', text: 'x', attachment: { fileId: exe } }), {
    code: 'ATTACHMENT_TYPE_NOT_ALLOWED',
  });
  const fakePdf = core.files.add({ name: 'a.pdf', mime: 'application/pdf', size: 1, url: '/uploads/a.pdf' }, PNG);
  await assert.rejects(core.sender.send({ to: PHONE, channel: 'sms', text: 'x', attachment: { fileId: fakePdf } }), {
    code: 'ATTACHMENT_TYPE_MISMATCH',
  });
  await assert.rejects(core.sender.send({ to: PHONE, channel: 'sms', text: 'x', attachment: { fileId: 999 } }), {
    code: 'ATTACHMENT_NOT_FOUND',
  });
  for (const url of [
    'http://shop.example.com/a.pdf',
    'https://127.0.0.1/a.pdf',
    'https://10.1.2.3/a.pdf',
    'https://[::1]/a.pdf',
    'https://localhost/a.pdf',
    'https://user:pw@shop.example.com/a.pdf',
    'https://shop.example.com:8443/a.pdf',
    'https://169.254.169.254/latest/meta-data',
  ]) {
    await assert.rejects(
      core.sender.send({ to: PHONE, channel: 'sms', text: 'x', attachment: { url, mimeType: 'application/pdf' } }),
      { code: 'ATTACHMENT_URL_INVALID' },
      url
    );
  }
  assert.equal(checkUrl('https://shop.example.com/a.pdf').ok, true);
  assert.equal(isBlockedAddress('100.64.1.1'), true);
  assert.equal(isBlockedAddress('::ffff:192.168.0.1'), true);
  assert.equal(isBlockedAddress('93.184.216.34'), false);
  assert.equal(
    await resolvesPublic('https://cdn.example.com/x', { lookup: async () => [{ address: '10.0.0.5' }] }),
    false
  );
  assert.equal(
    await resolvesPublic('https://cdn.example.com/x', { lookup: async () => [{ address: '93.184.216.34' }] }),
    true
  );
  await assert.rejects(
    core.sender.send({
      to: PHONE,
      channel: 'sms',
      text: 'x',
      attachment: { url: 'https://shop.example.com/a.png', mimeType: 'application/pdf' },
    }),
    { code: 'ATTACHMENT_TYPE_MISMATCH' }
  );
  // 6 MB image: too big for WhatsApp (5 MB), fine for RCS (16 MB).
  const big = core.files.add({ name: 'big.png', mime: 'image/png', size: 6 * 1024, url: '/uploads/big.png' }, PNG);
  await core.contacts.touch(core.contact.id, 'inbound', core.clock.t, 'whatsapp');
  const plan = await core.sender.preview({ to: PHONE, text: 'Foto', attachment: { fileId: big } });
  assert.deepEqual(
    plan.steps.map((s) => [s.channel, s.code || s.attachmentMode]),
    [
      ['whatsapp', 'ATTACHMENT_TOO_LARGE'],
      ['rcs', 'media'],
      ['sms', undefined],
    ]
  );
  assert.equal(plan.channel, 'rcs');
  assert.ok(sniffMatches(PDF, 'application/pdf'));
  assert.ok(!sniffMatches(PDF, 'image/png'));
});

test('attachments: Telegram sends photos by URL, other files as a link; template without a media header skips WhatsApp', async () => {
  const core = await rcsScenario();
  const tg = await core.accounts.create({
    channel: 'telegram',
    provider: 'telegram',
    name: 'TG',
    config: CREDS.telegram,
  });
  assert.ok(tg.id);
  const contact = core.contact;
  const token = await core.contacts.createLinkToken(contact.id);
  await core.contacts.consumeLinkToken(token, '424242');
  const png = core.files.add({ name: 'map.png', mime: 'image/png', size: 2, url: '/uploads/map.png' }, PNG);
  const mp4 = core.files.add({ name: 'v.mp4', mime: 'video/mp4', size: 2, url: '/uploads/v.mp4' });
  await core.sender.send({
    contactId: contact.document_id,
    channel: 'telegram',
    text: 'Karte <b>',
    attachment: { fileId: png },
  });
  await core.sender.send({
    contactId: contact.document_id,
    channel: 'telegram',
    text: 'Video',
    attachment: { fileId: mp4 },
  });
  await core.drain();
  const photo = fake.of('telegram.sendPhoto')[0].json;
  assert.equal(photo.photo, 'https://cms.example.test/uploads/map.png');
  assert.equal(photo.caption, 'Karte &lt;b&gt;');
  assert.match(
    fake.of('telegram.send')[0].json.text,
    /^Video\n\nhttps:\/\/cms\.example\.test\/api\/magic-messagegate\/files\//
  );
  // The WhatsApp template has no media header, so the attachment cannot go there.
  const plan = await core.sender.preview({
    to: PHONE,
    template: 'order_shipped',
    language: 'de',
    variables: core.vars,
    attachment: { fileId: png },
  });
  assert.equal(plan.steps[0].code, 'ATTACHMENT_UNSUPPORTED');
  assert.equal(plan.channel, 'rcs');
});

test('media templates: submit uploads the sample (Resumable Upload) and sends example.header_handle; sends pass the header media', async () => {
  const core = await rcsScenario({
    config: {
      providers: { ...fake.providers, meta: { ...fake.providers.meta, embeddedSignup: { appId: '100000000000001' } } },
    },
  });
  const sample = core.files.add(
    { name: 'ticket.pdf', mime: 'application/pdf', size: 1, url: '/uploads/ticket.pdf' },
    PDF
  );
  const tpl = await core.templates.create({
    key: 'ticket',
    channel: 'whatsapp',
    language: 'de',
    name: 'Ticket',
    content: { header: { format: 'DOCUMENT', fileId: sample }, body: 'Ihr Ticket, {{name}}.' },
  });
  await core.templates.submitToMeta(tpl.id, core.wa.id);
  const session = fake.of('meta.uploadSession')[0];
  assert.match(
    session.url,
    /\/100000000000001\/uploads\?file_name=ticket\.pdf&file_length=\d+&file_type=application%2Fpdf$/
  );
  const upload = fake.of('meta.upload')[0];
  assert.equal(upload.headers.authorization, `OAuth ${CREDS.meta.accessToken}`);
  assert.equal(upload.headers.file_offset, '0');
  assert.equal(upload.raw, PDF.toString('utf8'));
  const header = fake.of('meta.submit')[0].json.components.find((c) => c.type === 'HEADER');
  assert.deepEqual(header, {
    type: 'HEADER',
    format: 'DOCUMENT',
    example: { header_handle: ['4::aW1hZ2UvanBlZw==:ARZ'] },
  });
  await core.templates.applyProviderStatus({ name: 'ticket', language: 'de', status: 'APPROVED' });
  // Default header media from the template, and a per-message attachment that wins.
  await core.sender.send({
    to: PHONE,
    channel: 'whatsapp',
    template: 'ticket',
    language: 'de',
    variables: { name: 'Ana' },
  });
  const other = core.files.add({ name: 'other.pdf', mime: 'application/pdf', size: 1, url: '/uploads/other.pdf' }, PDF);
  await core.sender.send({
    to: PHONE,
    channel: 'whatsapp',
    template: 'ticket',
    language: 'de',
    variables: { name: 'Ana' },
    attachment: { fileId: other },
  });
  await core.drain();
  const [a, b] = fake.of('meta.send').map((r) => r.json.template.components[0]);
  assert.deepEqual(a, {
    type: 'header',
    parameters: [
      { type: 'document', document: { link: 'https://cms.example.test/uploads/ticket.pdf', filename: 'ticket.pdf' } },
    ],
  });
  assert.equal(b.parameters[0].document.link, 'https://cms.example.test/uploads/other.pdf');
  // Without a sample file or app id the submit explains what is missing.
  const noSample = await core.templates.create({
    key: 'promo',
    channel: 'whatsapp',
    language: 'de',
    name: 'Promo',
    content: { header: { format: 'IMAGE' }, body: 'Neu!' },
  });
  await assert.rejects(
    core.templates.submitToMeta(noSample.id, core.wa.id),
    (e) => e.details.field === 'content.header.fileId'
  );
  const wrongKind = await core.templates.create({
    key: 'promo2',
    channel: 'whatsapp',
    language: 'de',
    name: 'Promo',
    content: { header: { format: 'IMAGE', fileId: sample }, body: 'Neu!' },
  });
  await assert.rejects(core.templates.submitToMeta(wrongKind.id, core.wa.id), { code: 'ATTACHMENT_TYPE_MISMATCH' });
});

test('lookup: seven.io HLR is cached, shares the monthly budget and can block inactive numbers before sending', async () => {
  const core = await rcsScenario();
  await assert.rejects(core.lookup.check(PHONE, { hlr: true, remote: false }), { code: 'LOOKUP_DISABLED' });
  const { revision } = await core.settings.getWithRevision();
  await core.settings.save(
    {
      ...DEFAULTS,
      lookup: {
        ...DEFAULTS.lookup,
        hlrEnabled: true,
        hlrAccountId: core.sms.id,
        monthlyBudget: 3,
        blockInactiveNumbers: true,
      },
    },
    revision
  );
  const first = await core.lookup.check(PHONE, { hlr: true, rcs: true });
  assert.equal(first.hlr.active, true);
  assert.equal(first.hlr.network, 'Synthetic Mobile');
  assert.equal(first.rcs, 'unknown');
  const again = await core.lookup.check(PHONE, { hlr: true });
  assert.equal(again.hlr.cached, true);
  assert.equal(fake.count('seven.hlr'), 1);
  assert.equal(new URL(`http://x${fake.of('seven.hlr')[0].url}`).searchParams.get('number'), PHONE.slice(1));
  const caps = await core.lookup.capabilities(PHONE);
  assert.equal(caps.active, true);
  assert.ok(caps.checkedAt > 0);
  const dto = await core.contacts.dto(await core.contacts.getRowById(core.contact.id));
  assert.equal(dto.line.active, true);

  const inactive = '+4915550000008';
  await core.contacts.upsertByPhone(inactive);
  await assert.rejects(core.sender.send({ to: inactive, channel: 'sms', text: 'Hallo' }), { code: 'NUMBER_INACTIVE' });
  assert.equal(fake.count('seven.send'), 0, 'no provider cost');
  // Budget used up: sends are not blocked by a missing check.
  await core.lookup.check('+4917612345678', { hlr: true });
  const status = await core.lookup.budgetStatus();
  assert.equal(status.used, 3);
  assert.equal(status.hlrEnabled, true);
  const sent = await core.sender
    .send({ to: '+4915112345678', channel: 'sms', text: 'Hallo', transactional: false })
    .catch((e) => e);
  assert.notEqual(sent.code, 'NUMBER_INACTIVE');
});

test('dry run: route, account, masked recipient and rendered payload without queuing, contacts or cost', async () => {
  const core = await rcsScenario();
  const contactsBefore = await core.knex('mg_contacts').count({ n: '*' });
  const plan = await core.sender.send(
    { to: '+4917612345678', template: 'order_shipped', language: 'de', variables: core.vars },
    { dryRun: true }
  );
  assert.equal(plan.dryRun, true);
  assert.equal(plan.valid, false, 'a new number has no consent');
  assert.deepEqual(plan.errors, [{ code: 'NO_CONSENT' }]);
  assert.deepEqual(await core.knex('mg_contacts').count({ n: '*' }), contactsBefore);
  const ok = await core.sender.preview({ to: PHONE, template: 'order_shipped', language: 'de', variables: core.vars });
  assert.equal(ok.valid, true);
  assert.equal(ok.channel, 'whatsapp');
  assert.equal(ok.to, '+491•••89');
  assert.equal(ok.account.provider, 'meta');
  assert.equal(ok.payload.kind, 'template');
  assert.ok(!JSON.stringify(ok).includes(CREDS.meta.accessToken));
  assert.equal((await core.knex('mg_messages').count({ n: '*' }))[0].n, 0);
  const bad = await core.sender.preview({ to: PHONE, template: 'order_shipped', variables: {} });
  assert.equal(bad.valid, false);
  assert.equal(bad.errors[0].code, 'MISSING_VARIABLE');
  const invalid = await core.sender.preview({ to: PHONE });
  assert.deepEqual(invalid.errors, [{ code: 'INVALID_REQUEST', field: 'template' }]);
  assert.equal(fake.requests.length, 0, 'no provider was called');
});

test('templates.render renders the active template for a channel without sending', async () => {
  const core = await rcsScenario();
  const sms = await core.templates.render('order_shipped', 'de', core.vars, 'sms');
  assert.equal(sms.preview, 'Hallo Ana, Bestellung A-1 ist unterwegs.');
  assert.equal(sms.sms.segments, 1);
  const wa = await core.templates.render('order_shipped', 'de', core.vars, 'whatsapp');
  assert.equal(wa.payload.kind, 'template');
  await assert.rejects(core.templates.render('order_shipped', 'de', {}, 'sms'), { code: 'MISSING_VARIABLE' });
  await assert.rejects(core.templates.render('nope', 'de', {}, 'sms'), { code: 'UNKNOWN_TEMPLATE' });
});

test('settings saved by 1.0 (without the new keys) still load and save', async () => {
  const core = await rcsScenario();
  const old = {
    ...DEFAULTS,
    routing: { defaultChain: ['whatsapp', 'sms'], rules: [] },
    lookup: { enabled: false, accountId: null, cacheDays: 30, monthlyBudget: 500 },
  };
  delete old.attachments;
  delete old.inbound;
  delete old.inboundMedia;
  delete old.outgoingWebhook;
  await core
    .knex('mg_meta')
    .insert({ meta_key: 'settings', meta_value: JSON.stringify(old), revision: 1, updated_at: 1 });
  const { value } = await core.settings.getWithRevision();
  assert.deepEqual(value.routing.defaultChain, ['whatsapp', 'sms'], 'a saved chain is kept');
  assert.equal(value.lookup.hlrEnabled, false);
  assert.equal(value.attachments.linkTtlHours, 72);
  await core.settings.save(old, 1);
});
