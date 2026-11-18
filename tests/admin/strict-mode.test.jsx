/**
 * StrictMode checks of every Magic MessageGate admin entry point: the plugin page with its seven
 * sections (messages, inbox list and conversation, templates and the template editor, contacts,
 * accounts, analytics, settings), the homepage widget, and the dialogs the sections open (message
 * details, send message, contact details, number check, account wizard). See harness/index.jsx
 * for what each assertion counts.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { act } from 'react';
import { Route, Routes } from 'react-router-dom';
import { checkStrictEntry, network, permission, renderStrict, settle, snapshotResources } from './harness/index.jsx';
import App from '../../admin/src/pages/App';
import OverviewWidget from '../../admin/src/components/widgets/OverviewWidget';

const require = createRequire(import.meta.url);
const { DEFAULTS } = require('../../server/src/core/settings.js');

const PLUGIN = 'magic-messagegate';
const BASE = `/plugins/${PLUGIN}`;
const API = `/${PLUGIN}`;
const ACTIONS = [
  'accounts.read',
  'accounts.manage',
  'templates.read',
  'templates.manage',
  'templates.submit',
  'messages.read',
  'messages.send',
  'messages.manage',
  'contacts.read',
  'contacts.manage',
  'contacts.export',
  'inbound.read',
  'inbound.manage',
  'analytics.read',
  'settings.read',
  'settings.update',
];
const ALL = ACTIONS.map((action) => permission(`plugin::${PLUGIN}.${action}`));
const NOW = Date.now();
const iso = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();

/** The plugin page as Strapi mounts it: below `plugins/magic-messagegate/*`. */
const Plugin = () => (
  <Routes>
    <Route path={`${BASE}/*`} element={<App />} />
  </Routes>
);

const pagination = (total) => ({ page: 1, pageSize: 25, total, pageCount: total ? 1 : 0 });

const message = (overrides = {}) => ({
  id: 'msg000000001',
  recipient: { phoneMasked: '+49 151 •••• 0189' },
  channel: 'whatsapp',
  templateKey: 'order_shipped',
  status: 'failed',
  phase: 'done',
  errorCode: '131026',
  hasPayload: true,
  createdAt: iso(30),
  sentAt: iso(29),
  deliveredAt: null,
  readAt: null,
  notAfter: iso(-600),
  attempts: 1,
  maxAttempts: 5,
  transactional: false,
  source: 'api',
  fallbackOf: null,
  fallbacks: [],
  timeline: [
    { type: 'queued', at: iso(30), code: null },
    { type: 'failed', at: iso(29), code: '131026' },
  ],
  ...overrides,
});

const template = (overrides = {}) => ({
  id: 'tpl000000001',
  key: 'order_shipped',
  name: 'Order shipped',
  channel: 'whatsapp',
  language: 'en',
  category: 'UTILITY',
  approvalStatus: 'approved',
  isActive: true,
  version: 1,
  body: 'Hello {{first_name}}, order {{order_id}} is on its way.',
  variables: ['first_name', 'order_id'],
  ...overrides,
});

const contact = (overrides = {}) => ({
  id: 'ct0000000001',
  phoneMasked: '+49 151 •••• 0189',
  locale: 'en',
  telegramLinked: false,
  whatsapp: { reachability: 'unknown' },
  rcs: { capability: 'unknown' },
  consent: { whatsapp: { status: 'granted', at: iso(600) } },
  suppressions: [],
  createdAt: iso(6000),
  ...overrides,
});

const account = (overrides = {}) => ({
  id: 'acc000000001',
  name: 'Support number',
  channel: 'whatsapp',
  provider: 'meta',
  isActive: true,
  isDefault: true,
  priority: 0,
  webhookUrl: 'https://cms.example.test/api/magic-messagegate/webhooks/meta/acc000000001',
  config: { phoneNumberId: '100000000000001', wabaId: '200000000000002' },
  health: { status: 'ok', code: null, at: iso(5) },
  ...overrides,
});

const rate = { total: 10, sent: 10, failed: 1, deliveryRate: 90, readRate: 50 };
const analytics = {
  totals: { ...rate },
  byChannel: [{ channel: 'whatsapp', ...rate }],
  byTemplate: [{ template_key: 'order_shipped', ...rate }],
  failures: [{ code: '131026', total: 1 }],
  fallbacks: { total: 0, byChannel: {} },
  costCategories: {},
  queue: { queued: 0, uncertain: 0 },
};

/**
 * A success toast (Strapi NotificationsProvider, sonner 2.0.7) adds a `visibilitychange` listener
 * to `document` and removes it from `window` (sonner `useIsDocumentHidden`), so every toast leaves
 * one listener behind. Library code, not the plugin.
 */
const TOAST_LISTENER = {
  match: /^listener document:visibilitychange lib:sonner\//,
  reason: 'sonner 2.0.7 (bundled by @strapi/admin) removes its toast listener from the wrong target',
};

/** Routes the plugin page reads on every section (the Inbox tab badge). */
const pageRoutes = () => {
  network.on('GET', `${API}/inbound/unread`, { data: { unread: 2 } });
};

/**
 * Clicks an element inside `act` (Design System buttons and Radix triggers handle `click`;
 * Radix menus also need pointerdown).
 * @param {Element | null | undefined} element - Element.
 */
const click = async (element) => {
  assert.ok(element, 'element to click exists');
  await act(async () => {
    element.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    element.click();
  });
  await settle(4, 10);
};

/**
 * Finds a button by its accessible label or text anywhere in the document (dialogs render in
 * portals).
 * @param {string} label - Label or text.
 * @returns {HTMLElement | null} Button.
 */
const button = (label) =>
  document.querySelector(`button[aria-label="${label}"]`) ||
  [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === label) ||
  null;

/** @param {Array<object>} calls - Recorded calls. @returns {Array<object>} Plugin mutations. */
const mutations = (calls) => calls.filter((call) => call.fromPlugin && call.method !== 'GET');

/**
 * Live (not aborted) requests to one path.
 * @param {Array<object>} calls - Recorded calls.
 * @param {string} pathname - Path without query.
 * @returns {Array<object>} Calls.
 */
const live = (calls, pathname) => calls.filter((call) => call.pathname === pathname && !call.aborted);

test('messages section: StrictMode mount, one live list request, detail and send dialogs', async () => {
  pageRoutes();
  network.on('GET', `${API}/messages`, { data: { results: [message()], pagination: pagination(1) } });
  network.on('GET', `${API}/messages/msg000000001`, { data: message() });
  network.on('GET', `${API}/templates`, { data: [template()] });
  const result = await checkStrictEntry(<Plugin />, {
    path: BASE,
    permissions: ALL,
    async whileMounted() {
      assert.match(document.body.textContent, /\+49 151 •••• 0189/);
      await click(button('Open details'));
      assert.match(document.body.textContent, /Message details/);
      assert.match(document.body.textContent, /Timeline/);
      await click(button('Close'));
      await click(button('Send message'));
      assert.match(document.body.textContent, /Send a message/);
    },
  });
  assert.equal(live(result.mountCalls, `${API}/messages`).length, 1, 'one list request survives');
  assert.equal(live(result.calls, `${API}/messages/msg000000001`).length, 1);
  assert.equal(mutations(result.calls).length, 0, 'no mutation');
});

test('inbox list and conversation: StrictMode mount and clean unmount', async () => {
  pageRoutes();
  network.on('GET', `${API}/inbound`, {
    data: {
      results: [
        {
          id: 'in0000000001',
          contactId: 'ct0000000001',
          contact: { phoneMasked: '+49 151 •••• 0189' },
          channel: 'whatsapp',
          kind: 'text',
          text: 'Where is my parcel?',
          receivedAt: iso(3),
          seenAt: null,
          processedAt: null,
        },
      ],
      pagination: pagination(1),
    },
  });
  const list = await checkStrictEntry(<Plugin />, { path: `${BASE}/inbox`, permissions: ALL });
  assert.match(list.html, /Where is my parcel\?/);
  assert.equal(live(list.mountCalls, `${API}/inbound`).length, 1);

  pageRoutes();
  network.on('GET', `${API}/conversations/ct0000000001`, {
    data: {
      contactId: 'ct0000000001',
      contact: contact(),
      items: [
        {
          id: 'in0000000001',
          direction: 'inbound',
          channel: 'whatsapp',
          kind: 'text',
          text: 'Where is my parcel?',
          at: iso(3),
          processedAt: null,
          replyTo: null,
        },
      ],
    },
  });
  const conversation = await checkStrictEntry(<Plugin />, {
    path: `${BASE}/inbox/ct0000000001`,
    permissions: ALL,
    async whileMounted() {
      network.on('POST', `${API}/inbound/in0000000001/processed`, {
        data: { id: 'in0000000001', processedAt: iso(0), alreadyProcessed: false },
      });
      await click(button('Mark processed'));
    },
    allowLeaks: [TOAST_LISTENER],
    allowDuplicateGets: [
      {
        path: `${API}/inbound/unread`,
        reason: 'the tab badge counts again after the conversation load marked its messages read',
      },
    ],
  });
  const order = conversation.mountCalls.filter((call) => !call.aborted && call.fromPlugin).map((call) => call.pathname);
  // The second badge request follows the conversation load (notifyInboxSeen), not the remount.
  assert.equal(order.lastIndexOf(`${API}/inbound/unread`) > order.indexOf(`${API}/conversations/ct0000000001`), true);
  assert.match(conversation.html, /Where is my parcel\?/);
  // Loading the conversation marks it read on the server: one live load, not two.
  assert.equal(live(conversation.mountCalls, `${API}/conversations/ct0000000001`).length, 1);
  const processed = conversation.calls.filter((call) => call.pathname === `${API}/inbound/in0000000001/processed`);
  assert.equal(processed.length, 1, 'one POST per click');
});

test('inbox tab badge: one 30 s poll and one window listener while mounted, none after', async () => {
  pageRoutes();
  network.on('GET', `${API}/messages`, { data: { results: [], pagination: pagination(0) } });
  const before = snapshotResources();
  const handle = await renderStrict(<Plugin />, { path: BASE, permissions: ALL });
  const { resources } = globalThis.__strictHarness;
  const polls = [...resources.intervals.entries()].filter(
    ([id, entry]) => !before.intervals.has(id) && entry.delay === 30_000
  );
  assert.equal(polls.length, 1, 'exactly one unread poll interval');
  const seen = [...resources.listeners.values()].filter(
    (entry) => entry.target === 'window' && entry.type === `${PLUGIN}:inbox-seen`
  );
  assert.equal(seen.length, 1, 'exactly one inbox-seen listener');
  await handle.unmount();
  assert.equal([...resources.intervals.keys()].filter((id) => !before.intervals.has(id)).length, 0);
  assert.equal([...resources.listeners.values()].filter((entry) => entry.type === `${PLUGIN}:inbox-seen`).length, 0);
});

test('templates section and template editor: StrictMode mount and clean unmount', async () => {
  pageRoutes();
  network.on('GET', `${API}/templates`, { data: [template()] });
  const list = await checkStrictEntry(<Plugin />, { path: `${BASE}/templates`, permissions: ALL });
  assert.match(list.html, /order_shipped/);
  assert.equal(live(list.mountCalls, `${API}/templates`).length, 1);

  pageRoutes();
  network.on('GET', `${API}/templates/tpl000000001`, { data: template() });
  network.on('GET', `${API}/accounts`, { data: [account()] });
  const editor = await checkStrictEntry(<Plugin />, {
    path: `${BASE}/templates/tpl000000001`,
    permissions: ALL,
  });
  assert.match(editor.html, /order_shipped/);
  assert.equal(live(editor.mountCalls, `${API}/templates/tpl000000001`).length, 1);
  assert.equal(mutations(editor.calls).length, 0);

  pageRoutes();
  network.on('GET', `${API}/accounts`, { data: [account()] });
  await checkStrictEntry(<Plugin />, { path: `${BASE}/templates/new`, permissions: ALL });
});

test('contacts section: contact details and number check dialogs', async () => {
  pageRoutes();
  network.on('GET', `${API}/contacts`, { data: { results: [contact()], pagination: pagination(1) } });
  network.on('GET', `${API}/contacts/ct0000000001`, { data: contact() });
  network.on('GET', `${API}/lookup/budget`, { data: { used: 3, limit: 500, remaining: 497 } });
  const result = await checkStrictEntry(<Plugin />, {
    path: `${BASE}/contacts`,
    permissions: ALL,
    async whileMounted() {
      assert.match(document.body.textContent, /\+49 151 •••• 0189/);
      await click(button('Open contact'));
      assert.ok(document.querySelector('[role="dialog"]'), 'contact dialog is open');
      await click(button('Close'));
      await click(button('Check a number'));
      assert.equal(document.querySelectorAll('[role="dialog"] h2').length, 1);
    },
  });
  assert.equal(live(result.mountCalls, `${API}/contacts`).length, 1);
  assert.equal(live(result.calls, `${API}/contacts/ct0000000001`).length, 1);
  assert.equal(mutations(result.calls).length, 0);
});

test('accounts section: account cards and the connect wizard', async () => {
  pageRoutes();
  network.on('GET', `${API}/accounts`, { data: [account()] });
  network.on('GET', `${API}/accounts/embedded-signup`, {
    data: { enabled: false, appId: null, configId: null, graphVersion: 'v24.0' },
  });
  const result = await checkStrictEntry(<Plugin />, {
    path: `${BASE}/accounts`,
    permissions: ALL,
    async whileMounted() {
      assert.match(document.body.textContent, /Support number/);
      await click(button('Connect a channel'));
    },
  });
  assert.equal(live(result.mountCalls, `${API}/accounts`).length, 1);
  assert.equal(mutations(result.calls).length, 0);
});

test('analytics and settings sections: StrictMode mount and clean unmount', async () => {
  pageRoutes();
  network.on('GET', `${API}/analytics`, { data: analytics });
  const stats = await checkStrictEntry(<Plugin />, { path: `${BASE}/analytics`, permissions: ALL });
  assert.match(stats.html, /order_shipped/);
  assert.equal(live(stats.mountCalls, `${API}/analytics`).length, 1);

  pageRoutes();
  network.on('GET', `${API}/settings`, {
    data: {
      settings: structuredClone(DEFAULTS),
      revision: 3,
      magicMailInstalled: false,
      sandbox: true,
      webhookSecretSet: false,
      publicUrl: 'https://cms.example.test',
      embeddedSignup: { enabled: false },
    },
  });
  network.on('GET', `${API}/accounts`, { data: [account()] });
  network.on('GET', `${API}/lookup/budget`, { data: { used: 3, limit: 500, remaining: 497 } });
  network.on('PUT', `${API}/settings`, (call) => ({
    data: { value: call.json().settings, revision: call.json().revision + 1 },
  }));
  const settings = await checkStrictEntry(<Plugin />, {
    path: `${BASE}/settings`,
    permissions: ALL,
    async whileMounted() {
      await click(document.querySelector('input[name="requireConsent"]'));
      await click(button('Save'));
    },
    allowLeaks: [TOAST_LISTENER],
  });
  assert.equal(live(settings.mountCalls, `${API}/settings`).length, 1);
  const saves = mutations(settings.calls);
  assert.equal(saves.length, 1, 'one PUT per save');
  assert.deepEqual(JSON.parse(saves[0].body), {
    settings: { ...structuredClone(DEFAULTS), requireConsent: false },
    revision: 3,
  });
});

test('plugin page: no permission and unknown section mount without section requests', async () => {
  const none = await checkStrictEntry(<Plugin />, { path: BASE, permissions: [] });
  assert.equal(none.mountCalls.filter((call) => call.fromPlugin).length, 0);

  pageRoutes();
  const unknown = await checkStrictEntry(<Plugin />, { path: `${BASE}/unknown`, permissions: ALL });
  assert.equal(
    unknown.mountCalls.filter((call) => call.fromPlugin && call.pathname !== `${API}/inbound/unread`).length,
    0
  );
});

test('homepage widget: data, empty and error states', async () => {
  network.on('GET', `${API}/analytics`, { data: analytics });
  const full = await checkStrictEntry(<OverviewWidget />, { permissions: ALL });
  assert.match(full.html, /Messages today/);
  assert.equal(live(full.mountCalls, `${API}/analytics`).length, 1);

  network.on('GET', `${API}/analytics`, { data: { ...analytics, totals: { ...rate, total: 0 } } });
  const empty = await checkStrictEntry(<OverviewWidget />, { permissions: ALL });
  assert.match(empty.html, /No messages sent today/);

  network.on('GET', `${API}/analytics`, { status: 500, body: { error: { status: 500 } } });
  const failed = await checkStrictEntry(<OverviewWidget />, { permissions: ALL });
  assert.match(failed.html, /could not be loaded/);
});
