'use strict';

/**
 * One local HTTP server that imitates the provider APIs used by the adapters:
 *   /meta/<version>/...        WhatsApp Cloud API (Graph)
 *   /telegram/bot<token>/...   Telegram Bot API
 *   /seven/api/...             seven.io
 *   /twilio/2010-04-01/...     Twilio Messaging
 *   /lookup/v2/PhoneNumbers/.. Twilio Lookup v2
 *
 * Responses follow the documented shapes. Tests queue special answers with
 * `fake.queue(route, answer)`; an answer is `{status, json, headers}`,
 * `{hang: true}` (never answers) or `{destroy: true}` (resets the socket).
 */
const http = require('http');

const ROUTES = [
  ['meta.media', 'GET', /^\/meta\/v\d+\.\d\/(9\d{6})$/],
  ['meta.mediaFile', 'GET', /^\/meta-cdn\/([A-Za-z0-9_-]+)$/],
  ['meta.uploadSession', 'POST', /^\/meta\/v\d+\.\d\/(\d+)\/uploads$/],
  ['meta.upload', 'POST', /^\/meta\/v\d+\.\d\/(upload:[A-Za-z0-9_=:.-]+)$/],
  ['telegram.sendPhoto', 'POST', /^\/telegram\/bot[^/]+\/sendPhoto$/],
  ['telegram.sendDocument', 'POST', /^\/telegram\/bot[^/]+\/sendDocument$/],
  ['telegram.getFile', 'POST', /^\/telegram\/bot[^/]+\/getFile$/],
  ['telegram.answerCallback', 'POST', /^\/telegram\/bot[^/]+\/answerCallbackQuery$/],
  ['telegram.file', 'GET', /^\/telegram\/file\/bot[^/]+\/(.+)$/],
  ['seven.hlr', 'GET', /^\/seven\/api\/lookup\/hlr$/],
  ['twilio.content', 'POST', /^\/content\/v1\/Content$/],
  [
    'twilio.media',
    'GET',
    /^\/twilio\/2010-04-01\/Accounts\/AC[0-9a-f]{32}\/Messages\/MM[0-9a-f]{32}\/Media\/(ME[0-9a-f]{32})$/,
  ],
  ['twilio.cdn', 'GET', /^\/twilio-cdn\/([A-Za-z0-9_-]+)$/],
  ['meta.send', 'POST', /^\/meta\/v\d+\.\d\/(\d+)\/messages$/],
  ['meta.info', 'GET', /^\/meta\/v\d+\.\d\/(\d+)$/],
  ['meta.templates', 'GET', /^\/meta\/v\d+\.\d\/(\d+)\/message_templates$/],
  ['meta.submit', 'POST', /^\/meta\/v\d+\.\d\/(\d+)\/message_templates$/],
  ['meta.oauth', 'GET', /^\/meta\/v\d+\.\d\/oauth\/access_token$/],
  ['meta.subscribe', 'POST', /^\/meta\/v\d+\.\d\/(\d+)\/subscribed_apps$/],
  ['meta.register', 'POST', /^\/meta\/v\d+\.\d\/(\d+)\/register$/],
  ['meta.smbSync', 'POST', /^\/meta\/v\d+\.\d\/(\d+)\/smb_app_data$/],
  ['telegram.send', 'POST', /^\/telegram\/bot[^/]+\/sendMessage$/],
  ['telegram.getMe', 'POST', /^\/telegram\/bot[^/]+\/getMe$/],
  ['telegram.getMe', 'GET', /^\/telegram\/bot[^/]+\/getMe$/],
  ['telegram.setWebhook', 'POST', /^\/telegram\/bot[^/]+\/setWebhook$/],
  ['seven.send', 'POST', /^\/seven\/api\/sms$/],
  ['seven.balance', 'GET', /^\/seven\/api\/balance$/],
  ['twilio.send', 'POST', /^\/twilio\/2010-04-01\/Accounts\/(AC[0-9a-f]{32})\/Messages\.json$/],
  ['twilio.account', 'GET', /^\/twilio\/2010-04-01\/Accounts\/(AC[0-9a-f]{32})\.json$/],
  ['twilio.lookup', 'GET', /^\/lookup\/v2\/PhoneNumbers\/([^/?]+)$/],
];

let counter = 0;
const hex = (n) => n.toString(16).padStart(32, '0');

/** Small valid files for media downloads. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPEG_WITH_EXIF = Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  Buffer.from([0xff, 0xe1, 0x00, 0x0d]),
  Buffer.from('Exif\u0000\u0000GPS!!', 'latin1'),
  Buffer.from([0xff, 0xdb, 0x00, 0x04, 0x00, 0x00]),
  Buffer.from([0xff, 0xda, 0x00, 0x02, 0x11, 0x22]),
  Buffer.from([0xff, 0xd9]),
]);

/** Default (successful) answers, shaped like the providers' documentation. */
const DEFAULTS = {
  'meta.media': (req) => ({
    status: 200,
    json: {
      messaging_product: 'whatsapp',
      url: `http://${req.headers.host}/meta-cdn/${req.match[1]}`,
      mime_type: 'image/jpeg',
      sha256: 'x',
      file_size: JPEG_WITH_EXIF.length,
      id: req.match[1],
    },
  }),
  'meta.mediaFile': () => ({ status: 200, body: JPEG_WITH_EXIF, type: 'image/jpeg' }),
  'meta.uploadSession': () => ({ status: 200, json: { id: 'upload:MTphdHRhY2htZW50' } }),
  'meta.upload': () => ({ status: 200, json: { h: '4::aW1hZ2UvanBlZw==:ARZ' } }),
  'telegram.sendPhoto': () => ({ status: 200, json: { ok: true, result: { message_id: ++counter } } }),
  'telegram.sendDocument': () => ({ status: 200, json: { ok: true, result: { message_id: ++counter } } }),
  'telegram.getFile': (req) => ({
    status: 200,
    json: { ok: true, result: { file_id: req.json?.file_id, file_path: 'photos/file_1.png', file_size: PNG.length } },
  }),
  'telegram.answerCallback': () => ({ status: 200, json: { ok: true, result: true } }),
  'telegram.file': () => ({ status: 200, body: PNG, type: 'image/png' }),
  'seven.hlr': (req) => {
    const number = new URL(`http://x${req.url}`).searchParams.get('number');
    const inactive = number === '4915550000008';
    return {
      status: 200,
      json: {
        status: true,
        status_message: 'success',
        lookup_outcome: true,
        international_format_number: number,
        valid_number: inactive ? 'not_valid' : 'valid',
        reachable: inactive ? 'bad_number' : 'reachable',
        ported: 'assumed_not_ported',
        roaming: 'not_roaming',
        current_carrier: { network_code: '26203', name: 'Synthetic Mobile', country: 'DE', network_type: 'mobile' },
      },
    };
  },
  'twilio.content': () => ({ status: 201, json: { sid: `HX${hex(++counter)}` } }),
  'twilio.media': (req) => ({
    status: 302,
    headers: { location: `http://${req.headers.host}/twilio-cdn/${req.match[1]}` },
    json: undefined,
  }),
  'twilio.cdn': () => ({ status: 200, body: PNG, type: 'image/png' }),
  'meta.send': (req) => ({
    status: 200,
    json: {
      messaging_product: 'whatsapp',
      contacts: [{ input: req.json?.to, wa_id: req.json?.to }],
      messages: [{ id: `wamid.FAKE${++counter}` }],
    },
  }),
  'meta.info': () => ({
    status: 200,
    json: {
      display_phone_number: '+49 30 000000',
      verified_name: 'Synthetic Shop',
      quality_rating: 'GREEN',
      id: '1234567890',
    },
  }),
  'meta.templates': () => ({ status: 200, json: { data: [], paging: {} } }),
  'meta.submit': () => ({
    status: 200,
    json: { id: String(900000 + ++counter), status: 'PENDING', category: 'UTILITY' },
  }),
  'meta.oauth': () => ({
    status: 200,
    json: { access_token: 'EAAsynthetic-business-token-0001', token_type: 'bearer' },
  }),
  'meta.subscribe': () => ({ status: 200, json: { success: true } }),
  'meta.register': () => ({ status: 200, json: { success: true } }),
  'meta.smbSync': () => ({ status: 200, json: { success: true } }),
  'telegram.send': (req) => ({
    status: 200,
    json: { ok: true, result: { message_id: ++counter, chat: { id: Number(req.json?.chat_id) }, date: 1 } },
  }),
  'telegram.getMe': () => ({
    status: 200,
    json: { ok: true, result: { id: 1, is_bot: true, username: 'synthetic_test_bot' } },
  }),
  'telegram.setWebhook': () => ({ status: 200, json: { ok: true, result: true } }),
  'seven.send': () => ({
    status: 200,
    json: {
      success: '100',
      total_price: 0.075,
      balance: 10,
      messages: [{ id: String(77000 + ++counter), success: true, error: null }],
    },
  }),
  'seven.balance': () => ({ status: 200, json: { amount: 12.5, currency: 'EUR' } }),
  'twilio.send': () => ({ status: 201, json: { sid: `SM${hex(++counter)}`, status: 'queued' } }),
  'twilio.account': () => ({ status: 200, json: { status: 'active' } }),
  'twilio.lookup': (req) => ({
    status: 200,
    json: {
      phone_number: decodeURIComponent(req.match[1]),
      valid: true,
      line_type_intelligence: { type: 'mobile', error_code: null },
    },
  }),
};

/**
 * @returns {Promise<{url: string, requests: object[], queue: Function, count: Function, reset: Function, close: Function}>}
 */
async function startFakeProviders() {
  const queues = new Map();
  const requests = [];
  const hanging = [];
  const state = { delayMs: 0 };
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const path = req.url.split('?')[0];
      let route = null;
      let match = null;
      for (const [name, method, pattern] of ROUTES) {
        const m = pattern.exec(path);
        if (m && method === req.method) {
          route = name;
          match = m;
          break;
        }
      }
      let json;
      try {
        json = raw ? JSON.parse(raw) : null;
      } catch {
        json = null;
      }
      const form = (req.headers['content-type'] || '').includes('x-www-form-urlencoded')
        ? Object.fromEntries(new URLSearchParams(raw))
        : null;
      const record = { route, method: req.method, url: req.url, headers: req.headers, raw, json, form, match };
      requests.push(record);
      if (!route) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"not found"}');
        return;
      }
      const queued = queues.get(route);
      const answer = queued && queued.length ? queued.shift() : DEFAULTS[route](record);
      if (answer.hang) {
        hanging.push(res);
        return;
      }
      if (answer.destroy) {
        req.socket.destroy();
        return;
      }
      const reply = () => {
        if (answer.body) {
          res.writeHead(answer.status, {
            'content-type': answer.type || 'application/octet-stream',
            'content-length': String(answer.body.length),
            ...(answer.headers || {}),
          });
          res.end(answer.body);
          return;
        }
        res.writeHead(answer.status, { 'content-type': 'application/json', ...(answer.headers || {}) });
        res.end(answer.json === undefined ? '' : JSON.stringify(answer.json));
      };
      const delay = answer.delayMs ?? state.delayMs;
      if (delay) setTimeout(reply, delay);
      else reply();
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    requests,
    providers: {
      meta: { baseUrl: `${url}/meta`, timeoutMs: 1500 },
      telegram: { baseUrl: `${url}/telegram`, timeoutMs: 1500 },
      seven: { baseUrl: `${url}/seven`, timeoutMs: 1500 },
      twilio: {
        baseUrl: `${url}/twilio`,
        lookupBaseUrl: `${url}/lookup`,
        contentBaseUrl: `${url}/content`,
        timeoutMs: 1500,
      },
    },
    /** @param {string} route @param {object} answer */
    queue(route, answer) {
      if (!queues.has(route)) queues.set(route, []);
      queues.get(route).push(answer);
    },
    /** @param {number} ms - Latency for every default answer. */
    setDelay(ms) {
      state.delayMs = ms;
    },
    /** Hung requests (for tests that kill a process mid-request). */
    hanging,
    count: (route) => requests.filter((r) => r.route === route).length,
    of: (route) => requests.filter((r) => r.route === route),
    reset() {
      queues.clear();
      requests.length = 0;
      state.delayMs = 0;
    },
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

module.exports = { startFakeProviders, PNG, JPEG_WITH_EXIF };
