'use strict';

/**
 * The live-suite harness itself (tests/helpers/live-env.js), offline: key
 * loading and selection, the host allowlist, log masking, and the webhook
 * server that feeds MessageGate's real controller.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadLiveConfig, installLiveFetch, maskedPath, startWebhookServer, REQUIRED } = require('./helpers/live-env');
const { fakeStrapi } = require('./helpers/strapi');

/**
 * @param {string} content
 * @param {number} mode
 * @returns {string} file path
 */
function envFile(content, mode = 0o600) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-live-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, content, { mode });
  fs.chmodSync(file, mode);
  return file;
}

test('live harness: no file, loose permissions, selection and missing keys', () => {
  const saved = process.env.LIVE_PROVIDERS;
  delete process.env.LIVE_PROVIDERS;
  try {
    const none = loadLiveConfig(path.join(os.tmpdir(), 'mg-live-none', '.env'));
    assert.match(none.skipReason('telegram'), /does not exist/);

    const loose = loadLiveConfig(envFile('TELEGRAM_BOT_TOKEN=x\n', 0o644));
    assert.match(loose.skipReason('telegram'), /mode 600/);

    const file = envFile('# comment\nTELEGRAM_BOT_TOKEN="123:abc"\nTELEGRAM_CHAT_ID=42\nSEVEN_API_KEY=k\n');
    const cfg = loadLiveConfig(file);
    assert.equal(cfg.skipReason('telegram'), null);
    assert.equal(cfg.skipReason('seven'), null);
    assert.match(cfg.skipReason('meta'), /not selected/);
    assert.equal(cfg.env.TELEGRAM_BOT_TOKEN, '123:abc', 'quotes are stripped');
    assert.match(cfg.optIn('seven', { flags: { LIVE_ALLOW_PAID: 'paid' } }), /LIVE_ALLOW_PAID=1 not set/);

    process.env.LIVE_PROVIDERS = 'meta';
    const meta = loadLiveConfig(file);
    assert.equal(meta.skipReason('meta'), `meta: missing ${REQUIRED.meta.join(', ')} in ${file}`);
    assert.match(meta.skipReason('telegram'), /not selected/);
    process.env.LIVE_PROVIDERS = 'telegram,whatsapp';
    assert.match(loadLiveConfig(file).skipReason('telegram'), /unknown provider\(s\) whatsapp/);
  } finally {
    if (saved === undefined) delete process.env.LIVE_PROVIDERS;
    else process.env.LIVE_PROVIDERS = saved;
  }
});

test('live harness: request log masks tokens, account ids and numbers; other hosts are refused', async () => {
  assert.equal(maskedPath('/bot123456:AAsecret/sendMessage'), '/bot<token>/sendMessage');
  assert.equal(
    maskedPath(`/2010-04-01/Accounts/AC${'a'.repeat(32)}/Messages/SM${'b'.repeat(32)}.json`),
    '/2010-04-01/Accounts/<account>/Messages/SM<sid>.json'
  );
  assert.equal(maskedPath('/v2/PhoneNumbers/+4915123456789'), '/v2/PhoneNumbers/<number>');
  assert.equal(maskedPath('/v23.0/1234567890/messages'), '/v23.0/<id>/messages');
  const live = installLiveFetch();
  try {
    await assert.rejects(() => fetch('https://example.test/x'), /host not allowed/);
  } finally {
    live.restore();
  }
});

test('live harness: the webhook server runs the real controller with the raw body', async () => {
  const strapi = await fakeStrapi({ publicUrl: 'https://tunnel.example.test' });
  const account = await strapi.core.accounts.create({
    channel: 'telegram',
    provider: 'telegram',
    name: 'Bot',
    config: { botToken: '123456789:AAsyntheticTokenValue_1234567890abc' },
  });
  const row = await strapi.core.accounts.getRow(account.id);
  const secret = strapi.core.accounts.configOf(row).secretToken;
  const server = await startWebhookServer();
  try {
    const url = `http://127.0.0.1:${server.port}/api/magic-messagegate/webhooks/telegram/${row.webhook_path}`;
    const body = JSON.stringify({
      update_id: 1,
      message: { message_id: 1, date: 1, chat: { id: 5, type: 'private' }, text: 'x' },
    });
    let res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(res.status, 404, 'no strapi yet');
    server.use(strapi);
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
      body,
    });
    assert.equal(res.status, 200);
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(res.status, 401);
    assert.deepEqual(
      server.hits.map((h) => [h.provider, h.status, h.contentType, h.keys.join(',')]),
      [
        ['telegram', 200, 'application/json', 'update_id,message'],
        ['telegram', 401, 'application/json', 'update_id,message'],
      ]
    );
  } finally {
    await server.close();
  }
});
