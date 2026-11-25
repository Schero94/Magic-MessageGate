'use strict';

/**
 * Contract: seven.io adapter against seven.io's official OpenAPI
 * (github.com/seven-io/api-schemes, pinned in tests/contract/specs/seven.json)
 * and the official webhook examples from docs.seven.io (seven-webhooks.json).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const pinned = require('./contract/specs/seven.json');
const hooks = require('./contract/specs/seven-webhooks.json');
const {
  validate,
  formToObject,
  requestSchema,
  responseSchema,
  queryParameters,
  flatten,
} = require('./contract/validator');
const { capture } = require('./contract/capture');
const seven = require('../server/src/adapters/seven');
const { makeCore, addAccount, CREDS } = require('./helpers/core');

const spec = pinned.spec;
const config = { ...CREDS.seven };
const TO = '+4915123456789';

/**
 * @param {string[]} errors
 * @param {string} what
 */
const ok = (errors, what) => assert.deepEqual(errors, [], `${what}:\n${errors.join('\n')}`);

test('seven contract: the pinned source is seven-io/api-schemes at a fixed commit', () => {
  assert.equal(pinned.source.repository, 'https://github.com/seven-io/api-schemes');
  assert.match(pinned.source.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(
    spec.servers.map((s) => s.url),
    ['https://gateway.seven.io/api']
  );
});

test('seven contract: the SMS request uses documented form fields and the documented limit', async () => {
  const schema = requestSchema(spec, 'post', '/sms', 'application/x-www-form-urlencoded');
  const props = flatten(spec, schema).properties;
  assert.match(props.text.description, /1520 characters/);
  assert.equal(seven.MAX_TEXT, 1520);
  const answer = {
    success: '100',
    total_price: 0.075,
    balance: 593.994,
    debug: 'false',
    sms_type: 'direct',
    messages: [
      {
        id: '77149843739',
        sender: 'Shop',
        recipient: '4915123456789',
        text: 'Hallo',
        encoding: 'gsm',
        parts: 1,
        price: 0.075,
        success: true,
        error: null,
        error_text: null,
      },
    ],
  };
  ok(
    // `error` / `error_text` are null when nothing failed (docs example);
    // the schema types them as strings, so they are left out here.
    validate(spec, responseSchema(spec, 'post', '/sms', '200'), {
      ...answer,
      messages: answer.messages.map((m) => Object.fromEntries(Object.entries(m).filter(([, v]) => v !== null))),
    }),
    'documented SmsResponse'
  );
  const io = capture();
  io.answer(200, answer);
  const res = await seven.send({
    config,
    to: TO,
    payload: { text: 'Hallo' },
    messageId: 'k3j4h5g6f7d8s9a0q1w2e3r4',
    fetchImpl: io.fetchImpl,
  });
  const [req] = io.requests;
  assert.equal(`${req.url.origin}${req.url.pathname}`, 'https://gateway.seven.io/api/sms');
  assert.equal(req.headers['x-api-key'], config.apiKey);
  for (const key of req.form.keys()) assert.ok(props[key], `${key} is a documented field`);
  ok(validate(spec, schema, formToObject(spec, schema, req.form)), 'sms form');
  assert.equal(res.outcome, 'accepted');
  assert.equal(res.providerMessageId, '77149843739');
});

test('seven contract: balance and HLR follow the documented shapes', async () => {
  const balance = { amount: 12.5, currency: 'EUR' };
  ok(validate(spec, responseSchema(spec, 'get', '/balance', '200'), balance), 'balance');
  let io = capture();
  io.answer(200, balance);
  const conn = await seven.testConnection({ config, fetchImpl: io.fetchImpl });
  assert.equal(conn.ok, true);
  assert.equal(conn.info.balance, 12.5);
  assert.equal(io.requests[0].url.pathname, '/api/balance');

  const hlr = {
    international_format_number: '4915123456789',
    country_code: 'DE',
    current_carrier: { network_code: '26203', name: 'Synthetic Mobile', country: 'DE', network_type: 'mobile' },
    lookup_outcome: 'true',
    valid_number: 'valid',
    reachable: 'reachable',
    roaming: { status: 'not_roaming' },
  };
  ok(validate(spec, responseSchema(spec, 'get', '/lookup/hlr', '200'), hlr), 'hlr');
  io = capture();
  io.answer(200, hlr);
  const res = await seven.hlr({ config, e164: TO, fetchImpl: io.fetchImpl });
  const query = queryParameters(spec, 'get', '/lookup/hlr');
  for (const key of io.requests[0].url.searchParams.keys()) assert.ok(query.has(key), `${key} is documented`);
  assert.deepEqual(
    { valid: res.valid, reachable: res.reachable, roaming: res.roaming, networkType: res.networkType },
    { valid: 'valid', reachable: 'reachable', roaming: 'not_roaming', networkType: 'mobile' }
  );
});

test('seven contract: the official webhook examples are verified and processed', async () => {
  assert.deepEqual(Object.keys(seven.DLR_STATUS).sort(), [
    'ACCEPTED',
    'BUFFERED',
    'DELIVERED',
    'EXPIRED',
    'FAILED',
    'NOTDELIVERED',
    'REJECTED',
    'TRANSMITTED',
  ]);
  const core = await makeCore();
  await addAccount(core, 'seven');
  const [account] = await core.accounts.forChannel('sms');
  const url = `https://cms.example.test/api/magic-messagegate/webhooks/seven/${account.webhook_path}`;
  /**
   * Signs like docs.seven.io/en/rest-api/signing: HMAC-SHA256 over
   * timestamp, nonce, method, URL and MD5 of the body, one per line.
   *
   * @param {Buffer} raw
   * @returns {Record<string, string>}
   */
  const sign = (raw) => {
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomBytes(16).toString('hex');
    const md5 = crypto.createHash('md5').update(raw).digest('hex');
    const signature = crypto
      .createHmac('sha256', config.signingKey)
      .update([ts, nonce, 'POST', url, md5].join('\n'))
      .digest('hex');
    return { 'x-signature': signature, 'x-timestamp': ts, 'x-nonce': nonce };
  };

  const sent = await core.outbox.enqueue({
    channel: 'sms',
    accountId: account.id,
    contactId: null,
    to: TO,
    payload: { text: 'Hallo' },
    seed: {},
    notAfter: Date.now() + 3_600_000,
  });
  await core
    .knex('mg_messages')
    .where('id', sent.row.id)
    .update({ status: 'sent', provider_message_id: hooks.examples.dlr.data.msg_id });

  // The official sms_mo example's sender (49176123456789) has one digit too
  // many for a German mobile number, so libphonenumber rejects it and no
  // contact could be created; a valid synthetic number replaces it.
  const smsMo = structuredClone(hooks.examples.sms_mo);
  smsMo.data.sender = '4915123456789';
  for (const example of [hooks.examples.dlr, smsMo]) {
    const raw = Buffer.from(JSON.stringify(example));
    const res = await core.webhooks.seven(account, {
      headers: sign(raw),
      rawBody: raw,
      body: example,
      url,
      method: 'POST',
    });
    assert.equal(res.status, 200, example.webhook_event);
    const forged = await core.webhooks.seven(account, {
      headers: { ...sign(raw), 'x-signature': 'f'.repeat(64) },
      rawBody: raw,
      body: example,
      url,
      method: 'POST',
    });
    assert.equal(forged.status, 401);
  }
  assert.equal((await core.outbox.getRow(sent.row.document_id)).status, 'sent', 'TRANSMITTED keeps "sent"');
  const inbound = (await core.inbound.list({})).results;
  assert.equal(inbound.length, 1, 'sms_mo stored');
  assert.equal(inbound[0].receivedAt, Number(hooks.examples.sms_mo.data.time) * 1000);
});

test('seven contract: webhook management uses the documented hooks operations (issue #17)', async () => {
  const createSchema = requestSchema(spec, 'post', '/hooks', 'application/x-www-form-urlencoded');
  const createProps = flatten(spec, createSchema).properties;
  for (const event of seven.HOOK_EVENTS) assert.ok(createProps.event_type.enum.includes(event), `${event} documented`);
  assert.ok(createProps.request_method.enum.includes('JSON'));
  /** Strips nulls: the reference examples send `null` where the schema types strings. */
  const noNulls = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null));

  // POST /api/hooks: answer example from docs.seven.io/en/rest-api/endpoints/webhooks.
  const created = { success: true, code: null, id: 12345, error_message: null };
  ok(validate(spec, responseSchema(spec, 'post', '/hooks', '200'), noNulls(created)), 'create answer');
  let io = capture();
  io.answer(200, created);
  const target = 'https://cms.example.test/api/magic-messagegate/webhooks/seven/abcdefghijklmnopqrstuvwx';
  const res = await seven.createHook({ config, targetUrl: target, eventType: 'dlr', fetchImpl: io.fetchImpl });
  assert.deepEqual(res, { ok: true, code: null, id: '12345' });
  let [req] = io.requests;
  assert.equal(req.method, 'POST');
  assert.equal(`${req.url.origin}${req.url.pathname}`, 'https://gateway.seven.io/api/hooks');
  assert.equal(req.headers['x-api-key'], config.apiKey);
  for (const key of req.form.keys()) assert.ok(createProps[key], `${key} is a documented field`);
  ok(validate(spec, createSchema, formToObject(spec, createSchema, req.form)), 'create form');
  assert.equal(req.form.get('request_method'), 'JSON', 'MessageGate reads only JSON webhook bodies');

  // DELETE /api/hooks with the id.
  const deleteSchema = requestSchema(spec, 'delete', '/hooks', 'application/x-www-form-urlencoded');
  ok(validate(spec, responseSchema(spec, 'delete', '/hooks', '200'), noNulls(created)), 'delete answer');
  io = capture();
  io.answer(200, created);
  assert.deepEqual(await seven.deleteHook({ config, id: '12345', fetchImpl: io.fetchImpl }), { ok: true, code: null });
  [req] = io.requests;
  assert.equal(req.method, 'DELETE');
  assert.equal(req.url.pathname, '/api/hooks');
  for (const key of req.form.keys()) assert.ok(flatten(spec, deleteSchema).properties[key], `${key} documented`);
  ok(validate(spec, deleteSchema, formToObject(spec, deleteSchema, req.form)), 'delete form');

  // GET /api/hooks: the reference page's example (`hooks` list) ...
  const page = {
    success: true,
    code: null,
    hooks: [
      {
        id: '410',
        target_url: 'https://acme.example.test/v1/webhooks',
        headers: '',
        event_type: 'sms_mo',
        event_filter: '49157123456789',
        request_method: 'GET',
        enabled: true,
        created: '2021-03-01 11:19:08',
      },
      {
        id: '1277',
        target_url: 'https://hooks.example.test/hook',
        headers: 'Authorization: Basic dXNlcjpwYXNz',
        event_type: 'all',
        event_filter: null,
        request_method: 'JSON',
        enabled: false,
        created: '2021-12-30 13:33:02',
      },
    ],
  };
  io = capture();
  io.answer(200, page);
  let list = await seven.listHooks({ config, fetchImpl: io.fetchImpl });
  assert.equal(io.requests[0].method, 'GET');
  assert.equal(io.requests[0].url.pathname, '/api/hooks');
  assert.equal([...io.requests[0].url.searchParams.keys()].length, 0);
  assert.deepEqual(list, {
    ok: true,
    code: null,
    hooks: [
      {
        id: '410',
        targetUrl: 'https://acme.example.test/v1/webhooks',
        eventType: 'sms_mo',
        requestMethod: 'GET',
        enabled: true,
      },
      {
        id: '1277',
        targetUrl: 'https://hooks.example.test/hook',
        eventType: 'all',
        requestMethod: 'JSON',
        enabled: false,
      },
    ],
  });
  // ... and the OpenAPI's shape (`data[].hooks`, see docs/contract-tests.md).
  const openapiShape = { data: page.hooks.map((h) => ({ success: true, hooks: noNulls(h) })) };
  ok(validate(spec, responseSchema(spec, 'get', '/hooks', '200'), openapiShape), 'OpenAPI list shape');
  for (const h of page.hooks) {
    for (const key of Object.keys(h)) {
      assert.ok(
        flatten(spec, flatten(spec, responseSchema(spec, 'get', '/hooks', '200')).properties.data.items).properties
          .hooks.properties[key],
        `${key} is a documented hook field`
      );
    }
  }
  io = capture();
  io.answer(200, openapiShape);
  list = await seven.listHooks({ config, fetchImpl: io.fetchImpl });
  assert.deepEqual(
    list.hooks.map((h) => h.id),
    ['410', '1277']
  );

  // Failures: bare auth code, documented `success: false`, HTTP errors.
  for (const [status, json, code] of [
    [200, 900, 'SEVEN_900'],
    [200, { success: false, code: 'invalid_url', id: null, error_message: 'x' }, 'SEVEN_invalid_url'],
    [401, {}, 'HTTP_401'],
  ]) {
    io = capture();
    io.answer(status, json);
    io.answer(status, json);
    io.answer(status, json);
    assert.equal((await seven.listHooks({ config, fetchImpl: io.fetchImpl })).code, code);
    assert.equal(
      (await seven.createHook({ config, targetUrl: target, eventType: 'dlr', fetchImpl: io.fetchImpl })).code,
      code
    );
    assert.equal((await seven.deleteHook({ config, id: '1', fetchImpl: io.fetchImpl })).code, code);
  }
});
