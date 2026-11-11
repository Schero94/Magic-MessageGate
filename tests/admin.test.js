'use strict';

/**
 * Admin logic tests: pure utils, i18n completeness in five locales and a
 * source contract for the Design System rules (no hex colours, no CSS
 * variables, no window.confirm, every translation key defined).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { IntlMessageFormat } = require('intl-messageformat');

const ADMIN = path.join(__dirname, '..', 'admin', 'src');
const LOCALES = ['en', 'de', 'fr', 'es', 'pt'];
const load = (rel) => import(path.join(ADMIN, rel));
const read = (locale) => JSON.parse(fs.readFileSync(path.join(ADMIN, 'translations', `${locale}.json`), 'utf8'));

/** @returns {string[]} Admin source files. */
function sources() {
  const walk = (dir) =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  return walk(ADMIN).filter((f) => /\.(jsx?|mjs)$/.test(f));
}

/** @returns {Map<string, string>} Translation keys used in code with their default text. */
function usedKeys() {
  const keys = new Map();
  const patterns = [
    /\bt\(\s*'([^']+)'\s*,\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/gs,
    /getTranslation\('([^']+)'\)\s*,\s*defaultMessage:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/gs,
    /id:\s*`\$\{PLUGIN_ID\}\.([^`]+)`\s*,\s*defaultMessage:\s*'((?:[^'\\]|\\.)*)'/gs,
  ];
  for (const file of sources()) {
    const src = fs.readFileSync(file, 'utf8');
    for (const re of patterns) for (const m of src.matchAll(re)) keys.set(m[1], (m[2] ?? m[3]).replace(/\\'/g, "'"));
  }
  return keys;
}

/** @param {string} message @returns {string[]} ICU argument names. */
const args = (message) => [...message.matchAll(/\{\s*([a-zA-Z_]+)\s*[,}]/g)].map((m) => m[1]).sort();

test('i18n: every key used in code exists in en.json with the same default text', () => {
  const en = read('en');
  const used = usedKeys();
  assert.ok(used.size > 400, `expected many keys, found ${used.size}`);
  for (const [key, text] of used) {
    assert.ok(key in en, `missing in en.json: ${key}`);
    assert.equal(en[key], text, `en.json differs from the code default for ${key}`);
  }
});

test('i18n: all five locales have the same keys, valid ICU and the same arguments', () => {
  const en = read('en');
  for (const locale of LOCALES) {
    const messages = read(locale);
    assert.deepEqual(Object.keys(messages).sort(), Object.keys(en).sort(), `${locale}.json keys differ from en.json`);
    for (const [key, text] of Object.entries(messages)) {
      assert.ok(text.trim(), `${locale}:${key} is empty`);
      assert.doesNotThrow(() => new IntlMessageFormat(text, locale), `${locale}:${key} is not valid ICU`);
      assert.deepEqual(args(text), args(en[key]), `${locale}:${key} arguments differ`);
    }
  }
});

test('i18n: German text uses no forms of address', () => {
  const de = read('de');
  const address = /\b(Sie|Ihnen|Ihr|Ihre|Ihren|Ihrem|Ihrer|du|dich|dir|dein|deine|deinen|deinem|deiner)\b/;
  for (const [key, text] of Object.entries(de)) assert.doesNotMatch(text, address, `de:${key} addresses the reader`);
});

test('source contract: Design System tokens only, native dialogs, no CSS variables or window.confirm', () => {
  for (const file of sources()) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ADMIN, file);
    assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b(?![^\n]*@)/, `${rel} contains a hex colour`);
    assert.doesNotMatch(src, /var\(--/, `${rel} uses a CSS variable`);
    assert.doesNotMatch(src, /window\.(confirm|alert|prompt)\(/, `${rel} uses a browser dialog`);
    assert.doesNotMatch(src, /\bas=\{/, `${rel} uses "as" on a DS component (use "tag")`);
    assert.doesNotMatch(src, /rgba?\(/, `${rel} uses an rgb colour`);
    assert.doesNotMatch(src, /\bconsole\.(log|debug)\(/, `${rel} logs to the console`);
  }
});

test('source contract: narrow Grid items stack on phones (DS uses col below 520 px unless xs is set)', () => {
  for (const file of sources()) {
    if (file.includes('widgets')) continue;
    const src = fs.readFileSync(file, 'utf8');
    for (const tag of src.match(/<Grid\.Item\b[^>]*>/g) || []) {
      const col = /col=\{(\d+)\}/.exec(tag);
      if (col && col[1] !== '12') assert.match(tag, /xs=/, `${path.relative(ADMIN, file)}: ${tag}`);
    }
  }
});

test('source contract: sections are RBAC gated and destructive actions use ConfirmAction', () => {
  const app = fs.readFileSync(path.join(ADMIN, 'pages', 'App.jsx'), 'utf8');
  for (const group of ['messages', 'templates', 'contacts', 'accounts', 'analytics', 'settings'])
    assert.match(app, new RegExp(`rbac\\.${group}\\.read`), `App does not gate ${group}`);
  for (const rel of [
    'pages/Accounts/index.jsx',
    'pages/Templates/index.jsx',
    'pages/Messages/MessageDetailModal.jsx',
    'pages/Contacts/ContactDetailModal.jsx',
  ])
    assert.match(fs.readFileSync(path.join(ADMIN, rel), 'utf8'), /<ConfirmAction/, `${rel} has no ConfirmAction`);
  for (const rel of ['pages/Settings/index.jsx', 'pages/Templates/TemplateEditor.jsx'])
    assert.match(
      fs.readFileSync(path.join(ADMIN, rel), 'utf8'),
      /<UnsavedBlocker/,
      `${rel} has no unsaved-changes blocker`
    );
});

test('permissions: the admin uses exactly the 16 server actions', () => {
  const src = fs.readFileSync(path.join(ADMIN, 'permissions.js'), 'utf8');
  const actions = [...src.matchAll(/action\('([a-z.]+)'\)/g)].map((m) => m[1]).sort();
  const { ACTIONS } = require('../server/src/permissions.js');
  assert.equal(actions.length, 16);
  assert.deepEqual(actions, ACTIONS.map((a) => a.uid).sort());
});

test('permissions: registered actions match the Strapi 5 action-provider schema', async () => {
  const { registerActions } = require('../server/src/permissions.js');
  let registered;
  const strapi = {
    service: () => ({ actionProvider: { registerMany: async (list) => (registered = list) } }),
  };
  await registerActions(strapi);
  assert.equal(registered.length, 16);
  const allowed = new Set(['uid', 'section', 'pluginName', 'displayName', 'subCategory']);
  for (const a of registered) {
    assert.equal(a.section, 'plugins');
    assert.match(a.uid, /^[a-z]([a-z|.|-]+)[a-z]$/);
    for (const key of Object.keys(a)) assert.ok(allowed.has(key), `unexpected key ${key} (category is settings-only)`);
  }
});

test('utils: list entries, template preview and SMS segments', async () => {
  const { validateListEntry } = await load('utils/lists.mjs');
  assert.equal(validateListEntry('country', 'DE', []), null);
  assert.equal(validateListEntry('country', 'de', []), 'invalid');
  assert.equal(validateListEntry('keyword', 'stop', ['STOP']), 'duplicate');
  assert.equal(validateListEntry('templateKey', '', []), 'required');

  const p = await load('utils/templatePreview.mjs');
  assert.deepEqual(p.placeholders('Hi {{name}}, {{ order }} {{name}}'), ['name', 'order']);
  assert.deepEqual(p.placeholders('Hi {{1}} {{2}}', 'positional'), ['1', '2']);
  assert.equal(p.renderText('Hi {{name}}', {}, { name: 'Ada' }), 'Hi Ada');
  assert.equal(p.renderText('Hi {{name}}', {}, {}), 'Hi {{name}}');
  assert.deepEqual(p.smsSegments('a'.repeat(160)), { encoding: 'GSM-7', characters: 160, segments: 1 });
  assert.equal(p.smsSegments('a'.repeat(161)).segments, 2);
  assert.equal(p.smsSegments('€'.repeat(80)).characters, 160);
  assert.equal(p.smsSegments('😀'.repeat(36)).encoding, 'UCS-2');
  assert.equal(p.smsSegments('😀'.repeat(36)).segments, 2);
  assert.equal(p.keyFromName('Bestellung versandt – Größe'), 'bestellung_versandt_grosse');
  assert.equal(p.keyFromName('123 Order'), 'order');
  assert.deepEqual(
    p.templateVariables({
      channel: 'whatsapp',
      content: {
        header: { format: 'TEXT', text: '{{a}}' },
        body: '{{b}}',
        buttons: [{ type: 'URL', url: 'https://x/{{c}}' }],
      },
    }),
    ['a', 'b', 'c']
  );
});

test('utils: template editor model mirrors the server limits', async () => {
  const m = await load('utils/templates.mjs');
  const draft = { ...m.emptyTemplate('whatsapp'), name: 'Order', key: 'order', content: { body: 'Hi {{name}}' } };
  assert.deepEqual(m.validateTemplate(draft), {});
  assert.deepEqual(m.validateTemplate(draft, { forSubmit: true }), { 'variables.name.example': 'example' });
  assert.equal(m.validateTemplate({ ...draft, key: 'Order' }).key, 'invalid');
  assert.equal(m.validateTemplate({ ...draft, content: { body: 'x'.repeat(1025) } })['content.body'], 'tooLong');
  assert.equal(
    m.validateTemplate({ ...draft, content: { body: 'x', buttons: [{ type: 'URL', text: 'Go', url: 'http://a' }] } })[
      'content.buttons.0.url'
    ],
    'https'
  );
  const vars = m.syncVariables({ ...draft, variables: [{ name: 'name', example: 'Ada' }, { name: 'gone' }] });
  assert.deepEqual(vars, [{ required: true, maxLength: 256, name: 'name', example: 'Ada' }]);
  const payload = m.templatePayload(
    { ...draft, content: { body: 'Hi {{name}}', header: { format: 'NONE' }, footer: ' ' } },
    false
  );
  assert.deepEqual(payload.content, { body: 'Hi {{name}}' });
  assert.equal(payload.key, undefined);
  assert.equal(m.templatePayload(draft, true).key, 'order');
  assert.deepEqual(m.switchChannel(draft, 'sms').content, { text: 'Hi {{name}}' });
  assert.equal(
    m.validateTemplate({ ...m.emptyTemplate('sms'), name: 'x', key: 'x', content: { text: 'y'.repeat(1601) } })[
      'content.text'
    ],
    'tooLong'
  );
});

test('utils: provider credentials, send form, settings, messages, contacts, format', async () => {
  const pr = await load('utils/providers.mjs');
  assert.deepEqual(pr.validateCredentials('telegram', {}), { botToken: 'required' });
  assert.deepEqual(pr.validateCredentials('telegram', { botToken: '123456:abc' }), { botToken: 'invalid' });
  assert.deepEqual(pr.validateCredentials('telegram', {}, { botToken: true }), {});
  assert.equal(
    pr.validateCredentials('twilio', { accountSid: `AC${'a'.repeat(32)}`, authToken: 'b'.repeat(32) }).from,
    'required'
  );
  assert.deepEqual(pr.credentialPayload('seven', { apiKey: ' k ', signingKey: '', senderId: 'Shop' }), {
    apiKey: 'k',
    senderId: 'Shop',
  });

  const { validateSend } = await load('utils/send.mjs');
  assert.deepEqual(validateSend({ to: '', isText: true, text: '' }), { to: 'required', text: 'required' });
  assert.deepEqual(validateSend({ to: 'abc', isText: false, template: '' }), { to: 'phone', template: 'content' });
  assert.deepEqual(
    validateSend({ to: '+49 151 2345678', isText: false, template: 't', variables: {} }, [
      { name: 'a' },
      { name: 'b', required: false },
    ]),
    { 'var.a': 'required' }
  );

  const s = await load('utils/settings.mjs');
  const valid = {
    defaultCountry: 'DE',
    routing: { defaultChain: ['whatsapp'], rules: [] },
    fallback: { emailEnabled: false, emailTemplateReferenceId: null },
    lookup: { enabled: false, accountId: null, cacheDays: 30, monthlyBudget: 500 },
    retention: { messageDays: 90, receiptDays: 7 },
  };
  assert.deepEqual(s.validateSettings(valid), {});
  assert.equal(
    s.validateSettings({ ...valid, retention: { messageDays: 0, receiptDays: 91 } })['retention.receiptDays'],
    'range'
  );
  assert.equal(
    s.validateSettings({ ...valid, lookup: { ...valid.lookup, enabled: true } })['lookup.accountId'],
    'required'
  );
  assert.deepEqual(s.moveInChain(['a', 'b', 'c'], 0, 1), ['b', 'a', 'c']);
  assert.deepEqual(s.moveInChain(['a', 'b'], 0, -1), ['a', 'b']);
  assert.equal(s.newRule([{ id: 'rule_1' }]).id, 'rule_2');

  const msg = await load('utils/messages.mjs');
  assert.deepEqual(msg.messageActions({ status: 'uncertain', hasPayload: true }), {
    retry: true,
    retryBlockedBy: null,
    retryNeedsConfirm: true,
    discard: true,
    markSent: true,
  });
  assert.equal(msg.messageActions({ status: 'failed', hasPayload: false }).retryBlockedBy, 'payload');
  assert.equal(msg.messageActions({ status: 'queued', phase: 'sending' }).discard, false);
  assert.equal(msg.messageActions({ status: 'delivered' }).retry, false);
  assert.deepEqual(
    msg.progressSteps({ sentAt: 1, deliveredAt: 2, readAt: null }).map((x) => x.done),
    [true, true, false]
  );

  const c = await load('utils/contacts.mjs');
  assert.equal(c.lastActivityAt({ lastActivity: { inboundAt: 5, deliveredAt: 9, readAt: null } }), 9);
  assert.equal(c.lastActivityAt({}), null);
  assert.equal(c.channelState({ whatsapp: { reachability: 'unreachable' } }, 'whatsapp'), 'unreachable');
  assert.equal(c.channelState({ suppressions: [{ channel: 'sms', until: null }] }, 'sms'), 'blocked');
  assert.equal(c.channelState({ consent: { sms: { status: 'granted' } } }, 'sms'), 'ok');
  assert.equal(
    c.exportFileName({ id: 'abc123' }, Date.UTC(2026, 10, 11)),
    'messagegate-contact-abc123-2026-11-11.json'
  );

  const f = await load('utils/format.mjs');
  assert.equal(f.formatRate(0.875, 'en'), '87.5%');
  assert.equal(f.formatRate(null), '–');
  const r = f.rangeFor('7d', Date.UTC(2026, 10, 11, 12));
  assert.ok(r.to > r.from && r.to - r.from > 6 * 86_400_000);
});
