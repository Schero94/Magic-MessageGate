'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { seal, open, tryOpen, hashValue, randomToken, safeEqual, resetKeyCache } = require('../server/src/utils/crypto');
const { parsePhone } = require('../server/src/utils/phone');
const sig = require('../server/src/utils/signatures');
const engine = require('../server/src/utils/template-engine');
const { CODES, MessageGateError, isMessageGateError } = require('../server/src/utils/errors');

const KEY = 'synthetic-test-key-0123456789abcdef';

test('crypto: seal/open round trip, purpose and key binding', () => {
  resetKeyCache();
  const sealed = seal({ to: '+4915123456789' }, 'message-payload', KEY);
  assert.match(sealed, /^g1:/);
  assert.ok(!sealed.includes('4915123456789'));
  assert.deepEqual(open(sealed, 'message-payload', KEY), { to: '+4915123456789' });
  assert.throws(() => open(sealed, 'account-config', KEY), 'other purpose must not decrypt');
  assert.throws(() => open(sealed, 'message-payload', 'another-key-0123456789abcdef'), 'other key must not decrypt');
  const parts = sealed.split(':');
  parts[3] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => open(parts.join(':'), 'message-payload', KEY), 'GCM tag must reject tampering');
  assert.equal(tryOpen(parts.join(':'), 'message-payload', KEY, 'fallback'), 'fallback');
  assert.equal(open(null, 'message-payload', KEY), null);
  assert.notEqual(seal('x', 'p', KEY), seal('x', 'p', KEY), 'random IV');
});

test('crypto: hashes are keyed and stable; tokens are url-safe', () => {
  resetKeyCache();
  assert.equal(hashValue('a', 'phone', KEY), hashValue('a', 'phone', KEY));
  assert.notEqual(hashValue('a', 'phone', KEY), hashValue('a', 'chat', KEY));
  assert.notEqual(hashValue('a', 'phone', KEY), crypto.createHash('sha256').update('a').digest('hex'));
  assert.match(randomToken(24), /^[A-Za-z0-9_-]{32}$/);
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
});

test('crypto: missing master key fails loudly', () => {
  resetKeyCache();
  const saved = { ...process.env };
  delete process.env.MESSAGEGATE_ENCRYPTION_KEY;
  delete process.env.APP_KEYS;
  delete process.env.ADMIN_JWT_SECRET;
  try {
    assert.throws(() => seal('x', 'p', undefined), /MESSAGEGATE_ENCRYPTION_KEY/);
  } finally {
    Object.assign(process.env, saved);
    resetKeyCache();
  }
});

test('phone: E.164 normalisation, country default and line type', () => {
  const mobile = parsePhone('0151 23456789', 'DE');
  assert.equal(mobile.valid, true);
  assert.equal(mobile.e164, '+4915123456789');
  assert.equal(mobile.country, 'DE');
  assert.equal(mobile.mobile, true);
  const landline = parsePhone('+49 30 12345678');
  assert.equal(landline.valid, true);
  assert.equal(landline.mobile, false);
  assert.equal(parsePhone('12').valid, false);
  assert.equal(parsePhone('not a number').valid, false);
  assert.equal(parsePhone('+1 202 555 0143', 'DE').country, 'US');
});

test('signatures: Meta X-Hub-Signature-256 (HMAC-SHA256 of the raw body)', () => {
  const body = Buffer.from('{"object":"whatsapp_business_account"}');
  const header = `sha256=${crypto.createHmac('sha256', 'app-secret').update(body).digest('hex')}`;
  assert.equal(sig.verifyMeta(body, header, 'app-secret'), true);
  assert.equal(sig.signMeta(body, 'app-secret'), header);
  assert.equal(sig.verifyMeta(Buffer.from(body.toString() + ' '), header, 'app-secret'), false);
  assert.equal(sig.verifyMeta(body, header, 'other'), false);
  assert.equal(sig.verifyMeta(body, undefined, 'app-secret'), false);
  assert.equal(sig.verifyMeta(body, 'sha1=abc', 'app-secret'), false);
});

test('signatures: Telegram secret token header', () => {
  assert.equal(sig.verifyTelegram('s3cret-token-value-123', 's3cret-token-value-123'), true);
  assert.equal(sig.verifyTelegram('wrong', 's3cret-token-value-123'), false);
  assert.equal(sig.verifyTelegram(undefined, 's3cret-token-value-123'), false);
  assert.equal(sig.verifyTelegram('x', undefined), false);
});

test('signatures: seven.io HMAC over timestamp, nonce, method, url and body md5', () => {
  const rawBody = Buffer.from('{"webhook_event":"dlr"}');
  const url = 'https://cms.example.test/api/magic-messagegate/webhooks/seven/abc';
  const now = 1_700_000_000_000;
  const ts = String(now / 1000);
  const nonce = 'abcdef1234567890';
  const md5 = crypto.createHash('md5').update(rawBody).digest('hex');
  const signature = crypto
    .createHmac('sha256', 'signing')
    .update([ts, nonce, 'POST', url, md5].join('\n'))
    .digest('hex');
  const headers = { 'x-signature': signature, 'x-timestamp': ts, 'x-nonce': nonce };
  assert.deepEqual(sig.verifySeven({ signingKey: 'signing', headers, method: 'POST', url, rawBody, now }), {
    ok: true,
    nonce,
  });
  assert.equal(
    sig.verifySeven({ signingKey: 'signing', headers, method: 'POST', url, rawBody, now: now + 31_000 }).reason,
    'stale'
  );
  assert.equal(
    sig.verifySeven({ signingKey: 'signing', headers, method: 'POST', url: `${url}x`, rawBody, now }).reason,
    'mismatch'
  );
  assert.equal(
    sig.verifySeven({
      signingKey: 'signing',
      headers: { ...headers, 'x-nonce': '!' },
      method: 'POST',
      url,
      rawBody,
      now,
    }).reason,
    'headers'
  );
  assert.equal(sig.verifySeven({ signingKey: '', headers, method: 'POST', url, rawBody, now }).ok, false);
});

test('signatures: Twilio X-Twilio-Signature (HMAC-SHA1 of url + sorted params)', () => {
  const url = 'https://cms.example.test/api/magic-messagegate/webhooks/twilio/abc';
  const params = { MessageStatus: 'delivered', MessageSid: `SM${'1'.repeat(32)}`, AccountSid: `AC${'a'.repeat(32)}` };
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join('');
  const header = crypto.createHmac('sha1', 'token').update(data).digest('base64');
  assert.equal(sig.signTwilio(url, params, 'token'), header);
  assert.equal(sig.verifyTwilio(url, params, header, 'token'), true);
  assert.equal(sig.verifyTwilio(url, { ...params, MessageStatus: 'read' }, header, 'token'), false);
  assert.equal(sig.verifyTwilio(`${url}?x=1`, params, header, 'token'), false);
});

const waTemplate = {
  channel: 'whatsapp',
  key: 'order_shipped',
  language: 'de',
  parameterFormat: 'named',
  content: {
    header: { format: 'TEXT', text: 'Order {{order}}' },
    body: 'Hi {{name}}, your order {{order}} ships today.',
    footer: 'Synthetic Shop',
    buttons: [
      { type: 'URL', text: 'Track', url: 'https://shop.example.test/t/{{tracking}}' },
      { type: 'COPY_CODE', text: 'Copy', variable: 'code' },
    ],
  },
  variables: [{ name: 'order' }, { name: 'name' }, { name: 'tracking' }, { name: 'code', maxLength: 30 }],
};

test('template engine: WhatsApp named parameters, header, URL and copy-code buttons', () => {
  assert.deepEqual(engine.templateVariables(waTemplate), ['order', 'name', 'tracking']);
  const { payload, preview } = engine.render(waTemplate, {
    order: 'A-1',
    name: 'Ana\nB\tC',
    tracking: 'T1',
    code: 'SAVE10',
  });
  assert.equal(payload.kind, 'template');
  assert.equal(payload.name, 'order_shipped');
  assert.deepEqual(payload.components[0], {
    type: 'header',
    parameters: [{ type: 'text', parameter_name: 'order', text: 'A-1' }],
  });
  assert.deepEqual(payload.components[1].parameters[0], { type: 'text', parameter_name: 'name', text: 'Ana B C' });
  assert.deepEqual(payload.components[2], {
    type: 'button',
    sub_type: 'url',
    index: '0',
    parameters: [{ type: 'text', text: 'T1' }],
  });
  assert.equal(payload.components[3].parameters[0].coupon_code, 'SAVE10');
  assert.match(preview, /^Order A-1\n\nHi Ana\nB\tC, your order A-1 ships today\.\n\nSynthetic Shop$/);
});

test('template engine: positional parameters and media header', () => {
  const t = {
    channel: 'whatsapp',
    key: 'invoice',
    language: 'en_US',
    parameterFormat: 'positional',
    content: { header: { format: 'DOCUMENT', mediaId: '12345' }, body: 'Invoice {{1}} for {{2}}' },
    variables: [{ name: '1' }, { name: '2' }],
  };
  const { payload } = engine.render(t, { 1: 'INV-9', 2: 42 });
  assert.deepEqual(payload.components[0], {
    type: 'header',
    parameters: [{ type: 'document', document: { id: '12345' } }],
  });
  assert.deepEqual(payload.components[1].parameters, [
    { type: 'text', text: 'INV-9' },
    { type: 'text', text: '42' },
  ]);
});

test('template engine: validation errors are typed', () => {
  assert.throws(
    () => engine.render(waTemplate, { order: 'A', name: 'B', tracking: 'C' }),
    (e) => e.code === 'MISSING_VARIABLE' && e.details.field === 'code'
  );
  assert.throws(
    () => engine.render(waTemplate, { order: 'A', name: 'B', tracking: 'C', code: 'x', extra: 1 }),
    (e) => e.code === 'INVALID_VARIABLE'
  );
  assert.throws(
    () => engine.render(waTemplate, { order: 'A', name: 'B', tracking: 'C', code: 'x'.repeat(31) }),
    (e) => e.code === 'INVALID_VARIABLE' && e.details.field === 'code'
  );
  assert.throws(
    () => engine.render(waTemplate, { order: ' ', name: 'B', tracking: 'C', code: 'x' }),
    (e) => e.code === 'MISSING_VARIABLE'
  );
});

test('template engine: Telegram escapes HTML, SMS counts segments, control characters stripped', () => {
  const tg = engine.render(
    { channel: 'telegram', content: { text: '<b>Hi</b> {{name}}' }, variables: [{ name: 'name' }] },
    { name: '<script>&' }
  );
  assert.equal(tg.payload.text, '<b>Hi</b> &lt;script&gt;&amp;');
  assert.equal(engine.telegramVisibleLength('<b>a</b> &lt;&amp;&#39;'), 5);
  const long = { channel: 'telegram', content: { text: '<b>{{v}}</b>' }, variables: [{ name: 'v', maxLength: 1024 }] };
  assert.throws(
    () => engine.render({ ...long, content: { text: '{{v}}'.repeat(5) } }, { v: '&'.repeat(1000) }),
    (e) => e.code === 'INVALID_VARIABLE'
  );
  assert.equal(engine.render(long, { v: '&'.repeat(1000) }).payload.text.length, 5007);
  const sms = engine.render(
    { channel: 'sms', content: { text: 'Code {{code}}' }, variables: [{ name: 'code' }] },
    { code: '12‮34\u0000' }
  );
  assert.equal(sms.payload.text, 'Code 1234');
  assert.deepEqual(engine.smsSegments('a'.repeat(160)), { encoding: 'GSM-7', characters: 160, segments: 1 });
  assert.equal(engine.smsSegments('a'.repeat(161)).segments, 2);
  assert.equal(engine.smsSegments('{'.repeat(80)).characters, 160);
  assert.deepEqual(engine.smsSegments('ä'.repeat(10) + '€'), { encoding: 'GSM-7', characters: 12, segments: 1 });
  assert.deepEqual(engine.smsSegments('😀'.repeat(35)), { encoding: 'UCS-2', characters: 70, segments: 1 });
  assert.equal(engine.smsSegments('ł'.repeat(71)).segments, 2);
});

test('errors: every code has an HTTP status; MessageGateError is recognisable', () => {
  for (const [code, def] of Object.entries(CODES)) {
    assert.ok(def.status >= 400 && def.status < 600, code);
    assert.ok(def.message, code);
  }
  const error = new MessageGateError('NO_CONSENT');
  assert.equal(isMessageGateError(error), true);
  assert.equal(error.status, 409);
  assert.equal(isMessageGateError(new Error('x')), false);
});
