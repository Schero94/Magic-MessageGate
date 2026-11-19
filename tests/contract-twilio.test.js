'use strict';

/**
 * Contract: Twilio adapter (SMS, RCS, Lookup v2, Content API, webhooks)
 * against Twilio's official OpenAPI (github.com/twilio/twilio-oai, pinned in
 * tests/contract/specs/twilio_*.json). Webhook parameters are not published
 * machine-readably; tests/contract/specs/twilio-webhooks.json holds the list
 * from Twilio's docs pages (hand-copied, sources and date inside).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const api = require('./contract/specs/twilio_api.json');
const lookups = require('./contract/specs/twilio_lookups.json');
const content = require('./contract/specs/twilio_content.json');
const webhookParams = require('./contract/specs/twilio-webhooks.json');
const {
  validate,
  flatten,
  formToObject,
  requestSchema,
  responseSchema,
  responseExamples,
  queryParameters,
} = require('./contract/validator');
const { capture } = require('./contract/capture');
const twilio = require('../server/src/adapters/twilio');
const { signTwilio } = require('../server/src/utils/signatures');

const MESSAGES = '/2010-04-01/Accounts/{AccountSid}/Messages.json';
const ACCOUNT = '/2010-04-01/Accounts/{Sid}.json';
const LOOKUP = '/v2/PhoneNumbers/{PhoneNumber}';
const CONTENT = '/v1/Content';
const SID = `AC${'a'.repeat(32)}`;
const config = { accountSid: SID, authToken: 'b'.repeat(32), from: '+15005550006' };
const TO = '+4915123456789';

/**
 * Defects in the pinned twilio-oai documents, contradicted by Twilio's
 * reference pages. Matching errors are ignored; listed in docs/contract-tests.md.
 */
const KNOWN_SPEC_DEFECTS = [
  // twilioCard has additionalProperties: false without `body`, but
  // https://www.twilio.com/docs/content/twiliocard documents `body` (RCS
  // only, up to 1600 characters, "Required if title is not specified").
  /\.types\.twilio\/card: "body" is not in the spec$/,
  // Lookup v2 response fields (the data packages such as
  // line_type_intelligence and their members, validation_errors) are declared
  // without `nullable`, but the spec's own examples, and the API for every
  // package that was not requested, return null.
  /^\$\.[a-z0-9_.]+: expected [a-z|]+, got null$/,
];

/**
 * @param {string[]} errors
 * @param {string} what
 */
const ok = (errors, what) => {
  const left = errors.filter((e) => !KNOWN_SPEC_DEFECTS.some((d) => d.test(e)));
  assert.deepEqual(left, [], `${what}:\n${left.join('\n')}`);
};

/**
 * Validates a captured form request against the operation's form schema:
 * every field must be documented, types must match.
 *
 * @param {URLSearchParams} form
 * @param {string} what
 */
function okForm(form, what) {
  const schema = requestSchema(api.spec, 'post', MESSAGES, 'application/x-www-form-urlencoded');
  const documented = Object.keys(flatten(api.spec, schema).properties);
  for (const key of form.keys()) assert.ok(documented.includes(key), `${what}: ${key} is a documented field`);
  ok(validate(api.spec, schema, formToObject(api.spec, schema, form)), what);
}

test('twilio contract: pinned sources are twilio-oai at a fixed commit', () => {
  for (const pinned of [api, lookups, content]) {
    assert.equal(pinned.source.repository, 'https://github.com/twilio/twilio-oai');
    assert.match(pinned.source.commit, /^[0-9a-f]{40} \(tag [\d.]+\)$/);
    assert.match(pinned.source.sha256, /^[0-9a-f]{64}$/);
  }
});

test('twilio contract: SMS and RCS sends use documented form fields', async () => {
  const [example] = Object.values(responseExamples(api.spec, 'post', MESSAGES, '201'));
  ok(validate(api.spec, responseSchema(api.spec, 'post', MESSAGES, '201'), example), 'documented 201 example');
  const cases = [
    ['sms from number', { config, channel: 'sms', payload: { text: 'Hallo' } }],
    [
      'sms via messaging service',
      { config: { ...config, messagingServiceSid: `MG${'c'.repeat(32)}` }, channel: 'sms', payload: { text: 'Hallo' } },
    ],
    [
      'rcs text with media',
      {
        config: { ...config, messagingServiceSid: `MG${'c'.repeat(32)}` },
        channel: 'rcs',
        payload: { kind: 'rcs', text: 'Hallo', mediaUrl: 'https://cms.example.test/f/a.png' },
      },
    ],
    [
      'rcs content template',
      {
        config: { ...config, messagingServiceSid: `MG${'c'.repeat(32)}` },
        channel: 'rcs',
        payload: { kind: 'rcs', contentSid: `HX${'d'.repeat(32)}`, contentVariables: { 1: 'Ana' } },
      },
    ],
  ];
  for (const [name, input] of cases) {
    const io = capture();
    io.answer(201, example);
    const res = await twilio.send({
      ...input,
      to: TO,
      statusCallbackUrl: 'https://cms.example.test/api/magic-messagegate/webhooks/twilio/x',
      fetchImpl: io.fetchImpl,
    });
    const [req] = io.requests;
    assert.equal(req.url.origin, 'https://api.twilio.com');
    assert.equal(req.url.pathname, `/2010-04-01/Accounts/${SID}/Messages.json`);
    assert.match(req.headers.authorization, /^Basic /);
    okForm(req.form, name);
    assert.equal(res.outcome, 'accepted', name);
    assert.equal(res.providerMessageId, example.sid);
  }
});

test('twilio contract: status mapping uses documented statuses only', () => {
  const documented = flatten(api.spec, { $ref: '#/components/schemas/message_enum_status' }).enum;
  for (const status of Object.keys(twilio.STATUS)) assert.ok(documented.includes(status), `${status} is documented`);
  // Statuses MessageGate ignores on purpose: inbound (receiving, received),
  // not yet sent (scheduled) and group MMS (partially_delivered).
  const ignored = ['receiving', 'received', 'scheduled', 'partially_delivered'];
  for (const status of documented) {
    assert.ok(status in twilio.STATUS || ignored.includes(status), `${status} is mapped or listed as ignored`);
  }
});

test('twilio contract: testConnection reads the documented account resource', async () => {
  const [example] = Object.values(responseExamples(api.spec, 'get', ACCOUNT, '200'));
  ok(validate(api.spec, responseSchema(api.spec, 'get', ACCOUNT, '200'), example), 'account example');
  const io = capture();
  io.answer(200, example);
  const res = await twilio.testConnection({ config, fetchImpl: io.fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.info.status, example.status);
  assert.equal(io.requests[0].url.pathname, `/2010-04-01/Accounts/${SID}.json`);
});

test('twilio contract: line type lookup asks for a documented field and reads the documented answer', async () => {
  const query = queryParameters(lookups.spec, 'get', LOOKUP);
  const fieldsParam = query.get('Fields');
  const examples = responseExamples(lookups.spec, 'get', LOOKUP, '200');
  const schema = responseSchema(lookups.spec, 'get', LOOKUP, '200');
  const withLti = Object.values(examples).find((e) => e.line_type_intelligence);
  assert.ok(withLti, 'the spec has a line_type_intelligence example');
  for (const example of Object.values(examples)) ok(validate(lookups.spec, schema, example), 'lookup example');
  const io = capture();
  io.answer(200, withLti);
  const res = await twilio.lookup({ config, e164: withLti.phone_number, fetchImpl: io.fetchImpl });
  const [req] = io.requests;
  assert.equal(req.url.origin, 'https://lookups.twilio.com');
  assert.equal(decodeURIComponent(req.url.pathname), `/v2/PhoneNumbers/${withLti.phone_number}`);
  for (const key of req.url.searchParams.keys()) assert.ok(query.has(key), `query ${key} is documented`);
  for (const value of req.url.searchParams.get('Fields').split(',')) {
    assert.ok(fieldsParam.description.includes(value), `Fields value ${value} is documented`);
  }
  assert.equal(res.ok, true);
  assert.equal(res.valid, withLti.valid);
  assert.equal(res.lineType, withLti.line_type_intelligence.type);
});

test('twilio contract: RCS rich cards are created with the documented Content API body', async () => {
  const io = capture();
  const [example] = Object.values(responseExamples(content.spec, 'post', CONTENT, '201'));
  ok(validate(content.spec, responseSchema(content.spec, 'post', CONTENT, '201'), example), 'content example');
  io.answer(201, { ...example, sid: `HX${'e'.repeat(32)}` });
  const res = await twilio.createContent({
    config,
    content: {
      friendlyName: 'order_shipped_de_v1',
      language: 'de',
      variables: { 1: 'Ana' },
      card: {
        title: 'Bestellung',
        body: 'Hallo {{1}}',
        media: ['https://cms.example.test/f/a.png'],
        actions: [
          { type: 'URL', title: 'Verfolgen', url: 'https://shop.example.test/t' },
          { type: 'QUICK_REPLY', title: 'Danke', id: 'thanks' },
          { type: 'PHONE_NUMBER', title: 'Anrufen', phone: '+4930000000' },
        ],
      },
      text: 'Bestellung\n\nHallo {{1}}',
    },
    fetchImpl: io.fetchImpl,
  });
  assert.equal(io.requests[0].url.origin, 'https://content.twilio.com');
  ok(
    validate(content.spec, requestSchema(content.spec, 'post', CONTENT, 'application/json'), io.requests[0].json),
    'content body'
  );
  assert.equal(res.ok, true);
});

test('twilio contract: every webhook parameter MessageGate reads is documented', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server/src/core/webhooks.js'), 'utf8');
  const start = source.indexOf('async function twilioEvent');
  const read = new Set([...source.slice(start).matchAll(/\b(?:params|p)\.([A-Z][A-Za-z0-9]+)/g)].map((m) => m[1]));
  const documented = new Set(
    [...webhookParams.inbound, ...webhookParams.statusCallback].map((n) => n.replace('{N}', '0'))
  );
  assert.ok(read.size > 10);
  for (const name of read) assert.ok(documented.has(name), `${name} is a documented webhook parameter`);
  assert.deepEqual(webhookParams.optOutTypes, ['STOP', 'START', 'HELP']);
});

test("twilio contract: the webhook signature matches Twilio's own test vector", () => {
  // twilio-node spec/validation.spec.js (commit 676777e0f190980b307c507ee378004923980d63):
  // token "12345", this URL and these parameters give "RSOYDt4T1cUTdK1PDd93/VVr8B8=".
  const params = {
    CallSid: 'CA1234567890ABCDE',
    Caller: '+14158675309',
    Digits: '1234',
    From: '+14158675309',
    To: '+18005551212',
  };
  assert.equal(
    signTwilio('https://mycompany.com/myapp.php?foo=1&bar=2', params, '12345'),
    'RSOYDt4T1cUTdK1PDd93/VVr8B8='
  );
});
