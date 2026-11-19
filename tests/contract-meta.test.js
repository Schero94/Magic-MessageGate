'use strict';

/**
 * Contract: WhatsApp Cloud API adapter against Meta's official OpenAPI
 * (github.com/facebook/openapi business-messaging-api_v23.0.yaml, pinned in
 * tests/contract/specs/meta.json by scripts/contract-specs.mjs). Requests
 * are captured offline and validated against the spec; responses and
 * webhooks are the spec's own examples or payloads that validate against it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const pinned = require('./contract/specs/meta.json');
const {
  validate,
  flatten,
  requestSchema,
  responseSchema,
  responseExamples,
  queryParameters,
} = require('./contract/validator');
const { capture } = require('./contract/capture');
const meta = require('../server/src/adapters/meta');
const { META_STATUS } = require('../server/src/core/webhooks');
const { signMeta } = require('../server/src/utils/signatures');
const { makeCore, addAccount, CREDS } = require('./helpers/core');

const spec = pinned.spec;
const MESSAGES = '/{Version}/{Phone-Number-ID}/messages';
const PHONE_NUMBER = '/{Version}/{Phone-Number-ID}';
const TEMPLATES = '/{Version}/{WABA-ID}/message_templates';
const MEDIA = '/{Version}/{Media-ID}';
const config = { ...CREDS.meta };
const TO = '+4915123456789';

/**
 * Defects in the pinned official OpenAPI. Each one contradicts Meta's own
 * reference pages (and the spec's own description or examples); errors that
 * match are ignored, every other error fails. Listed in docs/contract-tests.md.
 */
const KNOWN_SPEC_DEFECTS = [
  // TemplateComponent.index: description "Position index of the button
  // (0-9)" and example "0", but pattern "^[2-6, 11-14]$" (a character class).
  /\.index: does not match \^\[2-6, 11-14\]\$$/,
  // TemplateComponent.sub_type lists quick_reply, url, catalog; Meta's
  // copy-code button reference sends sub_type "copy_code" with a
  // "coupon_code" parameter:
  // https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates/copy-code-button-templates
  /\.sub_type: "copy_code" is not one of/,
];

/**
 * @param {string[]} errors
 * @param {string} what
 */
const ok = (errors, what) => {
  const left = errors.filter((e) => !KNOWN_SPEC_DEFECTS.some((d) => d.test(e)));
  assert.deepEqual(left, [], `${what}:\n${left.join('\n')}`);
};

test('meta contract: the pinned source is the official repository at a fixed commit', () => {
  assert.equal(pinned.source.repository, 'https://github.com/facebook/openapi');
  assert.match(pinned.source.commit, /^[0-9a-f]{40}$/);
  assert.match(pinned.source.url, /business-messaging-api_v23\.0\.yaml$/);
  assert.ok(spec.servers.some((s) => s.url === 'https://graph.facebook.com'));
});

test('meta contract: every message body MessageGate sends is a valid Message', async () => {
  const payloads = {
    template: {
      kind: 'template',
      name: 'order_shipped',
      language: 'de',
      components: [
        { type: 'header', parameters: [{ type: 'image', image: { link: 'https://cms.example.test/f/a.jpg' } }] },
        { type: 'body', parameters: [{ type: 'text', text: 'Ana' }] },
        { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'YES' }] },
      ],
    },
    text: { kind: 'text', text: 'Hallo Ana' },
    image: { kind: 'media', mediaType: 'image', link: 'https://cms.example.test/f/a.jpg', caption: 'Rechnung' },
    document: {
      kind: 'media',
      mediaType: 'document',
      link: 'https://cms.example.test/f/a.pdf',
      caption: 'Rechnung',
      filename: 'rechnung.pdf',
    },
    video: { kind: 'media', mediaType: 'video', link: 'https://cms.example.test/f/a.mp4' },
    buttons: {
      kind: 'buttons',
      text: 'Kommst du?',
      buttons: [
        { id: 'yes', title: 'Ja' },
        { id: 'no', title: 'Nein' },
      ],
    },
  };
  const schema = requestSchema(spec, 'post', MESSAGES, 'application/json');
  for (const [name, payload] of Object.entries(payloads)) {
    const io = capture();
    io.answer(200, responseExamples(spec, 'post', MESSAGES, '200')['Example response']);
    const res = await meta.send({ config, to: TO, payload, fetchImpl: io.fetchImpl });
    const [req] = io.requests;
    assert.equal(req.method, 'POST');
    assert.equal(req.url.origin, 'https://graph.facebook.com');
    assert.equal(req.url.pathname, `/v23.0/${config.phoneNumberId}/messages`);
    assert.equal(req.headers.authorization, `Bearer ${config.accessToken}`);
    ok(validate(spec, schema, req.json), `${name} body`);
    assert.equal(res.outcome, 'accepted', name);
    assert.match(res.providerMessageId, /^wamid\./);
  }
});

test('meta contract: templates rendered by the template engine are valid template messages', async () => {
  const engine = require('../server/src/utils/template-engine');
  const schema = requestSchema(spec, 'post', MESSAGES, 'application/json');
  const templates = [
    {
      channel: 'whatsapp',
      key: 'order_shipped',
      language: 'de',
      parameterFormat: 'named',
      variables: [
        { name: 'name', example: 'Ana' },
        { name: 'order', example: 'A-1' },
        { name: 'code', example: 'X7K2' },
      ],
      content: {
        header: { format: 'TEXT', text: 'Bestellung {{order}}' },
        body: 'Hallo {{name}}, Bestellung {{order}} ist unterwegs.',
        buttons: [
          { type: 'URL', text: 'Verfolgen', url: 'https://shop.example.test/track/{{order}}' },
          { type: 'QUICK_REPLY', text: 'Danke', payload: 'THANKS' },
          { type: 'COPY_CODE', text: 'Code', variable: 'code' },
        ],
      },
    },
    {
      channel: 'whatsapp',
      key: 'invoice',
      language: 'en_US',
      parameterFormat: 'positional',
      variables: [{ name: '1', example: 'Ana' }],
      content: { header: { format: 'DOCUMENT' }, body: 'Hi {{1}}, your invoice.' },
    },
  ];
  for (const template of templates) {
    const values = Object.fromEntries(template.variables.map((v) => [v.name, v.example]));
    const { payload } = engine.render(template, values, {
      headerMedia: { link: 'https://cms.example.test/f/invoice.pdf', filename: 'invoice.pdf' },
    });
    const io = capture();
    io.answer(200, { messaging_product: 'whatsapp', messages: [{ id: 'wamid.X' }] });
    await meta.send({ config, to: TO, payload, fetchImpl: io.fetchImpl });
    ok(validate(spec, schema, io.requests[0].json), `rendered ${template.key}`);
    for (const c of io.requests[0].json.template.components.filter((x) => x.type === 'button')) {
      assert.match(c.index, /^\d$/, 'button index 0-9 (Meta reference)');
    }
  }
});

test('meta contract: the documented send responses validate and give the wamid', () => {
  const schema = responseSchema(spec, 'post', MESSAGES, '200');
  const examples = responseExamples(spec, 'post', MESSAGES, '200');
  assert.ok(Object.keys(examples).length > 5);
  for (const [name, example] of Object.entries(examples)) {
    ok(validate(spec, schema, example), `example "${name}"`);
  }
});

test('meta contract: testConnection asks for documented fields and reads the documented answer', async () => {
  const io = capture();
  const example = {
    display_phone_number: '+1 631-555-5555',
    verified_name: 'Synthetic Shop',
    quality_rating: 'GREEN',
    id: '1906385232743451',
  };
  ok(validate(spec, responseSchema(spec, 'get', PHONE_NUMBER, '200'), example), 'phone number info');
  io.answer(200, example);
  const res = await meta.testConnection({ config, fetchImpl: io.fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.info.verifiedName, 'Synthetic Shop');
  const fields = io.requests[0].url.searchParams.get('fields').split(',');
  const documented = Object.keys(flatten(spec, responseSchema(spec, 'get', PHONE_NUMBER, '200')).properties);
  for (const field of fields) assert.ok(documented.includes(field), `field ${field} is documented`);
});

test('meta contract: Graph errors use the documented error object', async () => {
  const errors = responseExamples(spec, 'get', PHONE_NUMBER, '400');
  assert.ok(Object.keys(errors).length);
  for (const example of Object.values(errors)) {
    ok(validate(spec, responseSchema(spec, 'get', PHONE_NUMBER, '400'), example), 'error example');
    const io = capture();
    io.answer(400, example);
    const res = await meta.send({ config, to: TO, payload: { kind: 'text', text: 'x' }, fetchImpl: io.fetchImpl });
    assert.equal(res.outcome, 'rejected');
    assert.equal(res.code, `META_${example.error.code}`);
  }
});

test('meta contract: template list and submit follow the documented shapes', async () => {
  const listExamples = responseExamples(spec, 'get', TEMPLATES, '200');
  const listSchema = responseSchema(spec, 'get', TEMPLATES, '200');
  const query = queryParameters(spec, 'get', TEMPLATES);
  for (const [name, example] of Object.entries(listExamples)) {
    ok(validate(spec, listSchema, example), `list example ${name}`);
    const io = capture();
    io.answer(200, { ...example, paging: {} });
    const items = await meta.listTemplates({ config, fetchImpl: io.fetchImpl });
    assert.equal(items.length, example.data.length, name);
    // `fields` and `limit` are Graph-wide parameters (field expansion and
    // cursor pagination, https://developers.facebook.com/docs/graph-api/results),
    // which the pinned spec does not repeat per operation.
    for (const key of io.requests[0].url.searchParams.keys()) {
      assert.ok(query.has(key) || key === 'fields' || key === 'limit', `query ${key} is documented`);
    }
    for (const item of items) assert.ok(meta.TEMPLATE_STATUSES.includes(item.status));
  }

  const io = capture();
  io.answer(200, { id: '1473688840035974', status: 'PENDING', category: 'UTILITY' });
  await meta.submitTemplate({
    config,
    template: {
      name: 'order_shipped',
      language: 'de',
      category: 'UTILITY',
      parameterFormat: 'named',
      components: [
        {
          type: 'BODY',
          text: 'Hallo {{name}}',
          example: { body_text_named_params: [{ param_name: 'name', example: 'Ana' }] },
        },
      ],
    },
    fetchImpl: io.fetchImpl,
  });
  ok(validate(spec, requestSchema(spec, 'post', TEMPLATES, 'application/json'), io.requests[0].json), 'submit body');
});

test('meta contract: media download follows the documented two-step flow', async () => {
  const [example] = Object.values(responseExamples(spec, 'get', MEDIA, '200'));
  ok(validate(spec, responseSchema(spec, 'get', MEDIA, '200'), example), 'media example');
  const io = capture();
  io.answer(200, { ...example, url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1' });
  io.binary(200, Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg');
  const res = await meta.downloadMedia({
    config,
    ref: { id: '2621233374848975' },
    maxBytes: 1_000_000,
    fetchImpl: io.fetchImpl,
  });
  assert.equal(res.ok, true);
  assert.equal(res.mime, example.mime_type);
  assert.equal(io.requests[0].url.pathname, '/v23.0/2621233374848975');
  assert.equal(io.requests[1].headers.authorization, `Bearer ${config.accessToken}`);
});

test('meta contract: status mapping covers the documented webhook statuses', () => {
  const statuses = flatten(spec, { $ref: '#/components/schemas/Statuses' });
  for (const status of statuses.properties.status.enum) assert.ok(META_STATUS[status], `status ${status} is mapped`);
});

/**
 * The pinned spec's incoming message schemas (IncomingMessage → TextMessage,
 * InteractiveMessageReply, …) extend the OUTGOING BaseMessageProperties
 * (required messaging_product, recipient_type, to; no from, id, timestamp),
 * so no real webhook message can pass. The envelope is validated with each
 * message reduced to its type part, and the type part (`text`,
 * `interactive`, …) against its own schema. Listed in docs/contract-tests.md.
 *
 * @param {object} body
 * @returns {object}
 */
function envelopeOnly(body) {
  const copy = structuredClone(body);
  for (const entry of copy.entry) {
    for (const change of entry.changes) {
      if (Array.isArray(change.value.messages)) {
        change.value.messages = change.value.messages.map((m) => ({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: change.value.metadata.display_phone_number,
          type: m.type,
          [m.type]: m[m.type],
          ...(m.context ? { context: m.context } : {}),
        }));
      }
    }
  }
  return copy;
}

/**
 * @param {object} message - Incoming message from a webhook.
 * @returns {string[]} Errors of the type-specific part.
 */
function incomingPart(message) {
  const mapping = flatten(spec, { $ref: '#/components/schemas/IncomingMessage' }).discriminator.mapping;
  assert.ok(mapping[message.type], `incoming type ${message.type} is documented`);
  const typed = flatten(spec, { $ref: mapping[message.type] });
  assert.ok(typed.properties[message.type], `${message.type} part is documented`);
  for (const key of ['from', 'id', 'timestamp']) assert.equal(typeof message[key], 'string', key);
  return validate(spec, typed.properties[message.type], message[message.type], `$.${message.type}`);
}

test('meta contract: spec-valid webhooks are verified and processed', async () => {
  const core = await makeCore();
  await addAccount(core, 'meta');
  const [row] = await core.accounts.forChannel('whatsapp');
  const { row: contact } = await core.contacts.upsertByPhone('+4915123456789');
  await core.contacts.setConsent(contact.id, 'whatsapp', 'granted', 'test');
  const metadata = { display_phone_number: '15550000000', phone_number_id: CREDS.meta.phoneNumberId };
  const payloads = [
    {
      messaging_product: 'whatsapp',
      metadata,
      contacts: [{ profile: { name: 'Synthetic' }, wa_id: '4915123456789' }],
      messages: [
        { from: '4915123456789', id: 'wamid.IN1', timestamp: '1800000000', type: 'text', text: { body: 'Hallo' } },
      ],
    },
    {
      messaging_product: 'whatsapp',
      metadata,
      contacts: [{ profile: { name: 'Synthetic' }, wa_id: '4915123456789' }],
      messages: [
        {
          from: '4915123456789',
          id: 'wamid.IN2',
          timestamp: '1800000001',
          type: 'interactive',
          context: { from: '15550000000', id: 'wamid.OUT0' },
          interactive: { type: 'button_reply', button_reply: { id: 'yes', title: 'Ja' } },
        },
      ],
    },
    {
      messaging_product: 'whatsapp',
      metadata,
      statuses: [{ id: 'wamid.OUT1', status: 'delivered', timestamp: '1800000002', recipient_id: '4915123456789' }],
    },
  ];
  const schema = { $ref: '#/components/schemas/WebhookPayload' };
  for (const value of payloads) {
    const body = {
      object: 'whatsapp_business_account',
      entry: [{ id: CREDS.meta.wabaId, changes: [{ field: 'messages', value }] }],
    };
    ok(validate(spec, schema, envelopeOnly(body)), 'webhook payload');
    for (const message of value.messages || []) ok(incomingPart(message), `incoming ${message.type}`);
    const raw = Buffer.from(JSON.stringify(body));
    const headers = { 'x-hub-signature-256': signMeta(raw, CREDS.meta.appSecret) };
    assert.equal((await core.webhooks.meta(row, { headers, rawBody: raw, body })).status, 200);
    const tampered = Buffer.concat([raw, Buffer.from(' ')]);
    assert.equal((await core.webhooks.meta(row, { headers, rawBody: tampered, body })).status, 401);
  }
  const inbound = await core.inbound.list({});
  assert.equal(inbound.results.length, 2, 'text and button reply stored');
});
