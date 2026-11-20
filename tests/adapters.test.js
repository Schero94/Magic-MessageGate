'use strict';

/**
 * Contract tests: every adapter talks to a local fake of its provider API.
 * They check the request (path, auth, body) and the outcome classification
 * that drives retries: accepted / rejected / transient / ambiguous.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const { startFakeProviders } = require('./helpers/fake-providers');
const { loopbackFetch, CREDS } = require('./helpers/core');
const { request } = require('../server/src/adapters/http');
const meta = require('../server/src/adapters/meta');
const telegram = require('../server/src/adapters/telegram');
const seven = require('../server/src/adapters/seven');
const twilio = require('../server/src/adapters/twilio');

let fake;
test.before(async () => {
  fake = await startFakeProviders();
});
test.after(() => fake.close());
test.beforeEach(() => fake.reset());

const TO = '+4915123456789';
const tpl = { kind: 'template', name: 'order_shipped', language: 'de', components: [] };

/** A port with nothing listening (connection refused before sending). */
async function closedPort() {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

test('http: refused connection is transient (nothing sent), timeout is ambiguous', async () => {
  const port = await closedPort();
  const refused = await request({ url: `http://127.0.0.1:${port}/x`, fetchImpl: loopbackFetch, timeoutMs: 1000 });
  assert.equal(refused.outcome, 'transient');
  fake.queue('seven.send', { hang: true });
  const hung = await request({ url: `${fake.url}/seven/api/sms`, fetchImpl: loopbackFetch, timeoutMs: 200 });
  assert.equal(hung.outcome, 'ambiguous');
  fake.queue('seven.send', { destroy: true });
  const reset = await request({ url: `${fake.url}/seven/api/sms`, fetchImpl: loopbackFetch, timeoutMs: 1000 });
  assert.equal(reset.outcome, 'ambiguous', 'a reset after the request was written may have been processed');
});

test('http: status classes and Retry-After', async () => {
  for (const [status, outcome] of [
    [200, 'accepted'],
    [400, 'rejected'],
    [401, 'rejected'],
    [429, 'transient'],
    [503, 'transient'],
    [500, 'ambiguous'],
    [502, 'ambiguous'],
    [408, 'ambiguous'],
  ]) {
    fake.queue('seven.send', { status, json: {}, headers: status === 429 ? { 'retry-after': '7' } : {} });
    const res = await request({ url: `${fake.url}/seven/api/sms`, fetchImpl: loopbackFetch });
    assert.equal(res.outcome, outcome, `HTTP ${status}`);
    if (status === 429) assert.equal(res.retryAfterMs, 7000);
  }
});

test('http: redirects are refused (no token forwarding)', async () => {
  fake.queue('seven.send', { status: 302, json: {}, headers: { location: 'http://127.0.0.1:9/steal' } });
  const res = await request({ url: `${fake.url}/seven/api/sms`, fetchImpl: loopbackFetch });
  assert.notEqual(res.outcome, 'accepted');
});

test('meta: template send request shape, bearer token and wamid', async () => {
  const res = await meta.send({
    config: CREDS.meta,
    to: TO,
    payload: tpl,
    settings: fake.providers.meta,
    fetchImpl: loopbackFetch,
  });
  assert.equal(res.outcome, 'accepted');
  assert.match(res.providerMessageId, /^wamid\./);
  const [req] = fake.of('meta.send');
  assert.equal(req.url, '/meta/v23.0/1234567890/messages');
  assert.equal(req.headers.authorization, `Bearer ${CREDS.meta.accessToken}`);
  assert.deepEqual(req.json, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: TO,
    type: 'template',
    template: { name: 'order_shipped', language: { code: 'de' }, components: [] },
  });
});

test('meta: error codes map to retry decisions', async () => {
  const cases = [
    [400, 131026, 'rejected', false],
    [400, 132001, 'rejected', false],
    [429, 130429, 'transient', false],
    [400, 131056, 'transient', false],
    [400, 80007, 'transient', false],
    [500, 131000, 'ambiguous', false],
    [401, 190, 'rejected', true],
  ];
  for (const [status, code, outcome, accountProblem] of cases) {
    fake.queue('meta.send', {
      status,
      json: { error: { message: 'synthetic', type: 'OAuthException', code, fbtrace_id: 'x' } },
    });
    const res = await meta.send({
      config: CREDS.meta,
      to: TO,
      payload: tpl,
      settings: fake.providers.meta,
      fetchImpl: loopbackFetch,
    });
    assert.equal(res.outcome, outcome, `code ${code}`);
    assert.equal(res.code, `META_${code}`);
    assert.equal(res.accountProblem, accountProblem, `account problem for ${code}`);
  }
});

test('meta: free-form text, testConnection, template listing and submit', async () => {
  await meta.send({
    config: CREDS.meta,
    to: TO,
    payload: { kind: 'text', text: 'Hi' },
    settings: fake.providers.meta,
    fetchImpl: loopbackFetch,
  });
  assert.deepEqual(fake.of('meta.send')[0].json.text, { preview_url: false, body: 'Hi' });
  const info = await meta.testConnection({
    config: CREDS.meta,
    settings: fake.providers.meta,
    fetchImpl: loopbackFetch,
  });
  assert.equal(info.ok, true);
  assert.equal(info.info.verifiedName, 'Synthetic Shop');
  fake.queue('meta.templates', {
    status: 200,
    json: {
      data: [{ id: '1', name: 'a', language: 'de', status: 'APPROVED', category: 'UTILITY', components: [] }],
      paging: { next: `${fake.url}/meta/v23.0/9876543210/message_templates?after=x` },
    },
  });
  fake.queue('meta.templates', {
    status: 200,
    json: { data: [{ id: '2', name: 'b', language: 'en', status: 'REJECTED', category: 'MARKETING', components: [] }] },
  });
  const list = await meta.listTemplates({
    config: CREDS.meta,
    settings: fake.providers.meta,
    fetchImpl: loopbackFetch,
  });
  assert.deepEqual(
    list.map((t) => t.name),
    ['a', 'b']
  );
  const submit = await meta.submitTemplate({
    config: CREDS.meta,
    template: { name: 'x', language: 'de', category: 'UTILITY', components: [] },
    settings: fake.providers.meta,
    fetchImpl: loopbackFetch,
  });
  assert.equal(submit.ok, true);
  assert.equal(submit.status, 'PENDING');
});

test('meta: pagination never leaves the configured host', async () => {
  fake.queue('meta.templates', {
    status: 200,
    json: { data: [], paging: { next: 'https://evil.example.test/steal' } },
  });
  const list = await meta.listTemplates({
    config: CREDS.meta,
    settings: fake.providers.meta,
    fetchImpl: loopbackFetch,
  });
  assert.deepEqual(list, []);
  assert.equal(fake.count('meta.templates'), 1);
});

test('telegram: sendMessage, 429 retry_after, 403 blocked, 401 account problem', async () => {
  const ok = await telegram.send({
    config: CREDS.telegram,
    to: '555001',
    payload: { text: '<b>x</b>' },
    settings: fake.providers.telegram,
    fetchImpl: loopbackFetch,
  });
  assert.equal(ok.outcome, 'accepted');
  assert.match(ok.providerMessageId, /^555001:\d+$/);
  const req = fake.of('telegram.send')[0];
  assert.equal(req.json.chat_id, '555001');
  assert.equal(req.json.parse_mode, 'HTML');
  assert.ok(req.url.startsWith(`/telegram/bot${CREDS.telegram.botToken}/`));

  fake.queue('telegram.send', {
    status: 429,
    json: {
      ok: false,
      error_code: 429,
      description: 'Too Many Requests: retry after 5',
      parameters: { retry_after: 5 },
    },
  });
  const limited = await telegram.send({
    config: CREDS.telegram,
    to: '555001',
    payload: { text: 'x' },
    settings: fake.providers.telegram,
    fetchImpl: loopbackFetch,
  });
  assert.equal(limited.outcome, 'transient');
  assert.equal(limited.retryAfterMs, 5000);

  fake.queue('telegram.send', {
    status: 403,
    json: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
  });
  const blocked = await telegram.send({
    config: CREDS.telegram,
    to: '555001',
    payload: { text: 'x' },
    settings: fake.providers.telegram,
    fetchImpl: loopbackFetch,
  });
  assert.equal(blocked.outcome, 'rejected');
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.code, 'TG_403');

  fake.queue('telegram.send', { status: 401, json: { ok: false, error_code: 401, description: 'Unauthorized' } });
  const unauthorized = await telegram.send({
    config: CREDS.telegram,
    to: '555001',
    payload: { text: 'x' },
    settings: fake.providers.telegram,
    fetchImpl: loopbackFetch,
  });
  assert.equal(unauthorized.accountProblem, true);
});

test('telegram: getMe and setWebhook with secret_token', async () => {
  const me = await telegram.testConnection({
    config: CREDS.telegram,
    settings: fake.providers.telegram,
    fetchImpl: loopbackFetch,
  });
  assert.equal(me.info.username, 'synthetic_test_bot');
  const hook = await telegram.setWebhook({
    config: CREDS.telegram,
    secretToken: 'secret-token-value-1234',
    webhookUrl: 'https://cms.example.test/api/magic-messagegate/webhooks/telegram/abc',
    settings: fake.providers.telegram,
    fetchImpl: loopbackFetch,
  });
  assert.equal(hook.ok, true);
  const body = fake.of('telegram.setWebhook')[0].json;
  assert.equal(body.secret_token, 'secret-token-value-1234');
  assert.equal(body.url, 'https://cms.example.test/api/magic-messagegate/webhooks/telegram/abc');
});

test('seven: form request with X-Api-Key and return codes', async () => {
  const ok = await seven.send({
    config: CREDS.seven,
    to: TO,
    payload: { text: 'Hi' },
    messageId: 'abc123',
    settings: fake.providers.seven,
    fetchImpl: loopbackFetch,
  });
  assert.equal(ok.outcome, 'accepted');
  assert.match(ok.providerMessageId, /^\d+$/);
  const req = fake.of('seven.send')[0];
  assert.equal(req.headers['x-api-key'], CREDS.seven.apiKey);
  assert.equal(req.form.to, TO);
  assert.equal(req.form.text, 'Hi');
  assert.equal(req.form.from, 'Shop');
  for (const [success, outcome] of [
    ['500', 'transient'],
    ['402', 'ambiguous'],
    ['900', 'rejected'],
    ['202', 'rejected'],
  ]) {
    fake.queue('seven.send', { status: 200, json: { success, messages: [] } });
    const res = await seven.send({
      config: CREDS.seven,
      to: TO,
      payload: { text: 'Hi' },
      settings: fake.providers.seven,
      fetchImpl: loopbackFetch,
    });
    assert.equal(res.outcome, outcome, `seven ${success}`);
  }
  const balance = await seven.testConnection({
    config: CREDS.seven,
    settings: fake.providers.seven,
    fetchImpl: loopbackFetch,
  });
  assert.equal(balance.ok, true);
});

test('twilio: basic auth, form body, status callback and error codes', async () => {
  const ok = await twilio.send({
    config: CREDS.twilio,
    to: TO,
    payload: { text: 'Hi' },
    statusCallbackUrl: 'https://cms.example.test/cb',
    settings: fake.providers.twilio,
    fetchImpl: loopbackFetch,
  });
  assert.equal(ok.outcome, 'accepted');
  assert.match(ok.providerMessageId, /^SM[0-9a-f]{32}$/);
  const req = fake.of('twilio.send')[0];
  assert.equal(
    req.headers.authorization,
    `Basic ${Buffer.from(`${CREDS.twilio.accountSid}:${CREDS.twilio.authToken}`).toString('base64')}`
  );
  assert.deepEqual(req.form, {
    To: TO,
    Body: 'Hi',
    From: CREDS.twilio.from,
    StatusCallback: 'https://cms.example.test/cb',
  });

  fake.queue('twilio.send', { status: 429, json: { code: 20429, message: 'Too Many Requests', status: 429 } });
  assert.equal(
    (
      await twilio.send({
        config: CREDS.twilio,
        to: TO,
        payload: { text: 'x' },
        settings: fake.providers.twilio,
        fetchImpl: loopbackFetch,
      })
    ).outcome,
    'transient'
  );
  fake.queue('twilio.send', { status: 400, json: { code: 21211, message: 'Invalid To', status: 400 } });
  const invalid = await twilio.send({
    config: CREDS.twilio,
    to: TO,
    payload: { text: 'x' },
    settings: fake.providers.twilio,
    fetchImpl: loopbackFetch,
  });
  assert.equal(invalid.outcome, 'rejected');
  assert.equal(invalid.code, 'TWILIO_21211');
});

test('twilio: Lookup v2 line type intelligence', async () => {
  const res = await twilio.lookup({
    config: CREDS.twilio,
    e164: TO,
    settings: fake.providers.twilio,
    fetchImpl: loopbackFetch,
  });
  assert.equal(res.ok, true);
  assert.equal(res.valid, true);
  assert.equal(res.lineType, 'mobile');
  const req = fake.of('twilio.lookup')[0];
  assert.equal(req.url, `/lookup/v2/PhoneNumbers/${encodeURIComponent(TO)}?Fields=line_type_intelligence`);
  assert.equal(req.method, 'GET');
});

/* ------------------------------------------------ provider audit 2026-11-20 */

test('http: Retry-After as seconds or HTTP-date, capped at one day', () => {
  const { parseRetryAfter } = require('../server/src/adapters/http');
  const now = Date.parse('2026-11-20T10:00:00Z');
  assert.equal(parseRetryAfter('7', now), 7000);
  assert.equal(parseRetryAfter('Fri, 20 Nov 2026 10:00:30 GMT', now), 30_000);
  assert.equal(parseRetryAfter('Fri, 20 Nov 2026 09:00:00 GMT', now), null, 'a date in the past');
  assert.equal(parseRetryAfter('999999', now), 86_400_000);
  assert.equal(parseRetryAfter('soon', now), null);
  assert.equal(parseRetryAfter(null, now), null);
});

test('telegram: long HTML text is never cut inside an entity', async () => {
  const escaped = '&amp;'.repeat(4096); // 4096 visible characters, 20480 bytes of HTML
  await telegram.send({
    config: CREDS.telegram,
    to: '12345',
    payload: { text: escaped },
    settings: fake.providers.telegram,
    fetchImpl: loopbackFetch,
  });
  const [req] = fake.of('telegram.send');
  assert.equal(req.json.text, escaped, 'within 4096 visible characters the text is sent unchanged');
  await telegram.send({
    config: CREDS.telegram,
    to: '12345',
    payload: { text: `${escaped}x&lt;` },
    settings: fake.providers.telegram,
    fetchImpl: loopbackFetch,
  });
  const long = fake.of('telegram.send')[1].json.text;
  assert.equal(long, escaped, 'cut at 4096 visible characters, after a whole entity');
});

test('seven: text is cut to the documented 1520 characters without splitting an emoji', async () => {
  const text = `${'a'.repeat(1519)}😀tail`;
  await seven.send({
    config: CREDS.seven,
    to: TO,
    payload: { text },
    settings: fake.providers.seven,
    fetchImpl: loopbackFetch,
  });
  const [req] = fake.of('seven.send');
  assert.equal(req.form.text, 'a'.repeat(1519), 'the surrogate pair at 1520/1521 is dropped, not split');
  assert.equal(seven.MAX_TEXT, 1520);
});

test('seven: 101 with one failed recipient, opt-out, credit and spending limit codes', async () => {
  const cases = [
    [
      { success: '101', messages: [{ id: null, success: false, error: '407004' }] },
      'rejected',
      'SEVEN_407004',
      false,
      true,
    ],
    [{ success: '101', messages: [{ id: null, success: false, error: '202' }] }, 'rejected', 'SEVEN_202', false, false],
    [{ success: '407004' }, 'rejected', 'SEVEN_407004', false, true],
    [{ success: '501' }, 'rejected', 'SEVEN_501', true, false],
    [{ success: '500' }, 'transient', 'SEVEN_500', true, undefined],
    [{ success: '101' }, 'ambiguous', 'SEVEN_101', false, undefined],
  ];
  for (const [json, outcome, code, accountProblem, optedOut] of cases) {
    fake.queue('seven.send', { status: 200, json });
    const res = await seven.send({
      config: CREDS.seven,
      to: TO,
      payload: { text: 'Hi' },
      settings: fake.providers.seven,
      fetchImpl: loopbackFetch,
    });
    assert.equal(res.outcome, outcome, JSON.stringify(json));
    assert.equal(res.code, code);
    assert.equal(res.accountProblem, accountProblem, `account problem for ${code}`);
    assert.equal(res.optedOut, optedOut, `opted out for ${code}`);
  }
});

test('seven: HLR roaming is read from the documented object', async () => {
  fake.queue('seven.hlr', {
    status: 200,
    json: { valid_number: 'valid', reachable: 'reachable', roaming: { status: 'not_roaming' }, current_carrier: {} },
  });
  const res = await seven.hlr({
    config: CREDS.seven,
    e164: TO,
    settings: fake.providers.seven,
    fetchImpl: loopbackFetch,
  });
  assert.equal(res.roaming, 'not_roaming');
});

test('twilio: 21610 (recipient replied STOP) is a permanent opt-out', async () => {
  fake.queue('twilio.send', {
    status: 400,
    json: { code: 21610, message: 'Attempt to send to unsubscribed recipient', status: 400 },
  });
  const res = await twilio.send({
    config: CREDS.twilio,
    to: TO,
    payload: { text: 'Hi' },
    settings: fake.providers.twilio,
    fetchImpl: loopbackFetch,
  });
  assert.equal(res.outcome, 'rejected');
  assert.equal(res.code, 'TWILIO_21610');
  assert.equal(res.optedOut, true);
  fake.queue('twilio.send', { status: 400, json: { code: 21611, message: 'queue full', status: 400 } });
  const full = await twilio.send({
    config: CREDS.twilio,
    to: TO,
    payload: { text: 'Hi' },
    settings: fake.providers.twilio,
    fetchImpl: loopbackFetch,
  });
  assert.equal(full.outcome, 'transient', '21611: the sender queue is full, nothing was sent');
});

test('meta: the pinned Graph API version stays supported for at least 90 more days', () => {
  // https://developers.facebook.com/docs/graph-api/changelog/versions (read
  // 2026-11-20): v23.0 released 2025-05-29, available until 2027-10-08. The
  // official WhatsApp OpenAPI (github.com/facebook/openapi) describes v23.0.
  // This test fails 90 days before the end so the default can be moved in time.
  const EXPIRES = { 'v23.0': '2027-10-08' };
  const source = require('node:fs').readFileSync(require.resolve('../server/src/adapters/meta'), 'utf8');
  const version = /const DEFAULT_VERSION = '(v\d+\.\d)'/.exec(source)?.[1];
  assert.ok(EXPIRES[version], `add the end of support of ${version} to this test`);
  assert.ok(Date.parse(EXPIRES[version]) - Date.now() > 90 * 86_400_000, `${version} ends on ${EXPIRES[version]}`);
});
