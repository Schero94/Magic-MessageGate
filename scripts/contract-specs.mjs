/**
 * Builds the pinned provider contracts in tests/contract/specs/ from the
 * providers' OFFICIAL sources. Run by a maintainer, never by CI (network):
 *
 *   npm run contract:specs           # rewrite the snapshots
 *   npm run contract:specs -- --check  # exit 1 when an upstream source changed
 *
 * - Meta, Twilio and seven.io publish OpenAPI documents in GitHub
 *   repositories; they are downloaded at a pinned commit, their sha256 is
 *   verified, and only the operations MessageGate calls are kept (with every
 *   component they reference), so the snapshots stay small.
 * - Telegram publishes no machine-readable spec. The method and type tables
 *   of https://core.telegram.org/bots/api are converted to JSON Schema. The
 *   page is rendered per request (its hash changes), so the extracted
 *   tables are the pinned artefact and `--check` compares them.
 * - seven.io documents webhook payloads only as JSON examples on
 *   https://docs.seven.io/en/rest-api/webhooks; the examples are extracted.
 * - Twilio documents webhook parameters only on HTML pages; the list in
 *   TWILIO_WEBHOOK below was copied from them by hand (source and date noted)
 *   and is not machine-checked.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'tests/contract/specs');
const check = process.argv.includes('--check');

/** Pinned official OpenAPI sources. Update commit and sha256 together. */
const SOURCES = {
  meta: {
    url: 'https://raw.githubusercontent.com/facebook/openapi/e96a1c9dbf240c2937b6a95920685230458e346b/business-messaging-api_v23.0.yaml',
    repository: 'https://github.com/facebook/openapi',
    commit: 'e96a1c9dbf240c2937b6a95920685230458e346b',
    sha256: '5c1973265369944b7cdfa3fa690985713575249042e2b7edd46be3ef9bd9b09d',
    format: 'yaml',
    operations: [
      ['post', '/{Version}/{Phone-Number-ID}/messages'],
      ['get', '/{Version}/{Phone-Number-ID}'],
      ['get', '/{Version}/{WABA-ID}/message_templates'],
      ['post', '/{Version}/{WABA-ID}/message_templates'],
      ['post', '/{Version}/{WABA-ID}/subscribed_apps'],
      ['post', '/{Version}/{Phone-Number-ID}/register'],
      ['get', '/{Version}/{Media-ID}'],
    ],
    schemas: ['WebhookPayload', 'Entry', 'Change', 'StatusMessageValue', 'Statuses'],
  },
  twilio_api: {
    url: 'https://raw.githubusercontent.com/twilio/twilio-oai/090e1654f5ca1f6a01b6a117fbec5f75c44f44d7/spec/json/twilio_api_v2010.json',
    repository: 'https://github.com/twilio/twilio-oai',
    commit: '090e1654f5ca1f6a01b6a117fbec5f75c44f44d7 (tag 2.11.1)',
    sha256: 'f5efc0ed7078b035f675e04aa2774eaea43a0606c1d699b1fd35759258e5ddc6',
    format: 'json',
    operations: [
      ['post', '/2010-04-01/Accounts/{AccountSid}/Messages.json'],
      ['get', '/2010-04-01/Accounts/{Sid}.json'],
    ],
    schemas: [],
  },
  twilio_lookups: {
    url: 'https://raw.githubusercontent.com/twilio/twilio-oai/090e1654f5ca1f6a01b6a117fbec5f75c44f44d7/spec/json/twilio_lookups_v2.json',
    repository: 'https://github.com/twilio/twilio-oai',
    commit: '090e1654f5ca1f6a01b6a117fbec5f75c44f44d7 (tag 2.11.1)',
    sha256: '94eecebb7c302115f35ce5842c9a82762495943071051f605c8482ab8c735e6b',
    format: 'json',
    operations: [['get', '/v2/PhoneNumbers/{PhoneNumber}']],
    schemas: [],
  },
  twilio_content: {
    url: 'https://raw.githubusercontent.com/twilio/twilio-oai/090e1654f5ca1f6a01b6a117fbec5f75c44f44d7/spec/json/twilio_content_v1.json',
    repository: 'https://github.com/twilio/twilio-oai',
    commit: '090e1654f5ca1f6a01b6a117fbec5f75c44f44d7 (tag 2.11.1)',
    sha256: '3cfc240e5e2031fb3307e8e11dea81d678a9dc75a61eba39db0e1c1cd9cdf7e0',
    format: 'json',
    operations: [['post', '/v1/Content']],
    schemas: [],
  },
  seven: {
    url: 'https://raw.githubusercontent.com/seven-io/api-schemes/0c976749e132089f51fe50fc865004c1294d198f/json/openapi.json',
    repository: 'https://github.com/seven-io/api-schemes',
    commit: '0c976749e132089f51fe50fc865004c1294d198f',
    sha256: 'acbb8831cefcd8206c48acdf2708bb63681c07b1a889b5b78e720dc2a921d7d4',
    format: 'json',
    operations: [
      ['post', '/sms'],
      ['get', '/balance'],
      ['get', '/lookup/hlr'],
      ['post', '/hooks'],
    ],
    schemas: [],
  },
};

const TELEGRAM_URL = 'https://core.telegram.org/bots/api';
const TELEGRAM_METHODS = [
  'getMe',
  'sendMessage',
  'sendPhoto',
  'sendDocument',
  'getFile',
  'answerCallbackQuery',
  'setWebhook',
];
const TELEGRAM_TYPES = [
  'Update',
  'Message',
  'User',
  'Chat',
  'CallbackQuery',
  'PhotoSize',
  'Document',
  'Audio',
  'Voice',
  'Video',
  'Sticker',
  'Location',
  'Venue',
  'File',
  'MessageEntity',
  'LinkPreviewOptions',
  'InlineKeyboardMarkup',
  'InlineKeyboardButton',
  'ResponseParameters',
];

const SEVEN_WEBHOOKS_URL = 'https://docs.seven.io/en/rest-api/webhooks';

/**
 * Twilio messaging webhook parameters, copied from
 * https://www.twilio.com/docs/messaging/guides/webhook-request (inbound) and
 * https://www.twilio.com/docs/messaging/guides/track-outbound-message-status
 * (status callbacks), plus OptOutType from
 * https://support.twilio.com/hc/en-us/articles/31560110671259 . Read
 * 2026-11-20. Twilio publishes no machine-readable list.
 */
const TWILIO_WEBHOOK = {
  retrieved: '2026-11-20',
  sources: [
    'https://www.twilio.com/docs/messaging/guides/webhook-request',
    'https://www.twilio.com/docs/messaging/guides/track-outbound-message-status',
    'https://support.twilio.com/hc/en-us/articles/31560110671259',
  ],
  machineReadable: false,
  contentType: 'application/x-www-form-urlencoded',
  signatureHeader: 'X-Twilio-Signature',
  inbound: [
    'MessageSid',
    'SmsSid',
    'SmsMessageSid',
    'AccountSid',
    'MessagingServiceSid',
    'From',
    'To',
    'Body',
    'NumMedia',
    'NumSegments',
    'MediaUrl{N}',
    'MediaContentType{N}',
    'ButtonPayload',
    'ButtonText',
    'ButtonType',
    'InteractiveData',
    'FlowData',
    'ChannelMetadata',
    'Latitude',
    'Longitude',
    'Address',
    'Label',
    'FromCity',
    'FromState',
    'FromZip',
    'FromCountry',
    'ToCity',
    'ToState',
    'ToZip',
    'ToCountry',
    'ProfileName',
    'WaId',
    'Forwarded',
    'FrequentlyForwarded',
    'OriginalRepliedMessageSender',
    'OriginalRepliedMessageSid',
    'OptOutType',
    'SmsStatus',
    'ApiVersion',
  ],
  // The status callback page lists these and says the request also carries
  // a subset of the standard inbound properties (To, ApiVersion, …).
  statusCallback: [
    'AccountSid',
    'From',
    'To',
    'ApiVersion',
    'MessageSid',
    'MessageStatus',
    'SmsSid',
    'SmsStatus',
    'MessagingServiceSid',
    'ErrorCode',
    'RawDlrDoneDate',
    'ChannelInstallSid',
    'ChannelStatusMessage',
    'ChannelPrefix',
    'EventType',
  ],
  optOutTypes: ['STOP', 'START', 'HELP'],
};

/**
 * @param {string} url
 * @returns {Promise<Buffer>}
 */
async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Collects every local `$ref` reachable from `value`.
 *
 * @param {object} doc
 * @param {*} value
 * @param {Set<string>} seen
 */
function collectRefs(doc, value, seen) {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(doc, item, seen);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === '$ref' && typeof child === 'string' && child.startsWith('#/')) {
      if (seen.has(child)) continue;
      seen.add(child);
      collectRefs(doc, resolvePointer(doc, child), seen);
    } else if (key === 'mapping' && child && typeof child === 'object') {
      for (const ref of Object.values(child)) {
        if (typeof ref === 'string' && ref.startsWith('#/') && !seen.has(ref)) {
          seen.add(ref);
          collectRefs(doc, resolvePointer(doc, ref), seen);
        }
      }
    } else collectRefs(doc, child, seen);
  }
}

/**
 * @param {object} doc
 * @param {string} pointer - `#/a/b`
 * @returns {*}
 */
function resolvePointer(doc, pointer) {
  return pointer
    .slice(2)
    .split('/')
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((node, key) => (node === undefined ? undefined : node[key]), doc);
}

/**
 * Keeps the listed operations and every component they reference.
 *
 * @param {object} doc
 * @param {object} source
 * @returns {object}
 */
function extractOpenApi(doc, source) {
  const paths = {};
  for (const [method, p] of source.operations) {
    const item = doc.paths?.[p];
    if (!item?.[method]) throw new Error(`${source.url}: ${method.toUpperCase()} ${p} not found`);
    paths[p] = paths[p] || {};
    paths[p][method] = item[method];
    if (item.parameters) paths[p].parameters = item.parameters;
  }
  const seen = new Set();
  collectRefs(doc, paths, seen);
  for (const name of source.schemas) {
    const ref = `#/components/schemas/${name}`;
    if (!resolvePointer(doc, ref)) throw new Error(`${source.url}: schema ${name} not found`);
    seen.add(ref);
    collectRefs(doc, resolvePointer(doc, ref), seen);
  }
  const components = {};
  for (const ref of [...seen].sort()) {
    const [, , kind, ...rest] = ref.split('/');
    const name = rest.join('/');
    components[kind] = components[kind] || {};
    components[kind][name] = resolvePointer(doc, ref);
  }
  return {
    openapi: doc.openapi || doc.swagger,
    info: { title: doc.info?.title, version: doc.info?.version },
    servers: doc.servers || [],
    paths,
    components,
  };
}

/** @param {string} html @returns {string} */
const text = (html) =>
  html
    .replace(/<br\s*\/?>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Table rows after the heading with anchor `name`.
 *
 * @param {string} html
 * @param {string} name
 * @returns {string[][]}
 */
function tableAfter(html, name) {
  const start = html.indexOf(`<a class="anchor" name="${name.toLowerCase()}"`);
  if (start < 0) throw new Error(`Telegram: section ${name} not found`);
  const next = html.slice(start + 10).search(/<h[34]>/);
  const section = html.slice(start, next < 0 ? undefined : start + 10 + next);
  const table = /<table class="table">([\s\S]*?)<\/table>/.exec(section);
  if (!table) return [];
  return [...table[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
    .map((row) => [...row[1].matchAll(/<td>([\s\S]*?)<\/td>/g)].map((cell) => text(cell[1])))
    .filter((cells) => cells.length);
}

/**
 * Telegram type text ("Integer or String", "Array of PhotoSize", "True") to JSON Schema.
 *
 * @param {string} type
 * @returns {object}
 */
function telegramType(type) {
  const t = type.trim();
  if (/ or /.test(t) && !/^Array of/.test(t)) return { anyOf: t.split(/ or /).map(telegramType) };
  const array = /^Array of (.+)$/.exec(t);
  if (array) return { type: 'array', items: telegramType(array[1]) };
  if (t === 'Integer') return { type: 'integer' };
  if (t === 'Float' || t === 'Float number') return { type: 'number' };
  if (t === 'String') return { type: 'string' };
  if (t === 'Boolean') return { type: 'boolean' };
  if (t === 'True') return { const: true };
  if (t === 'InputFile') return { type: 'string', description: 'InputFile (MessageGate sends URLs)' };
  if (/^[A-Z][A-Za-z]+$/.test(t)) return TELEGRAM_TYPES.includes(t) ? { $ref: `#/types/${t}` } : { type: 'object' };
  return {};
}

/**
 * @param {string} html
 * @returns {object}
 */
function extractTelegram(html) {
  const version = /<strong>Bot API ([\d.]+)<\/strong>/.exec(html)?.[1];
  const methods = {};
  for (const name of TELEGRAM_METHODS) {
    const rows = tableAfter(html, name);
    const properties = {};
    const required = [];
    for (const [param, type, req, description] of rows) {
      properties[param] = { ...telegramType(type), description };
      if (req === 'Yes') required.push(param);
    }
    methods[name] = { type: 'object', properties, required, additionalProperties: false };
  }
  const types = {};
  for (const name of TELEGRAM_TYPES) {
    const rows = tableAfter(html, name);
    const properties = {};
    const required = [];
    for (const [field, type, description] of rows) {
      properties[field] = { ...telegramType(type), description };
      if (!/^Optional\./.test(description)) required.push(field);
    }
    types[name] = { type: 'object', properties, required };
  }
  return { botApiVersion: version, methods, types };
}

/**
 * JSON examples on the seven.io webhooks page, by the heading before them.
 *
 * @param {string} html
 * @returns {Record<string, object>}
 */
function extractSevenExamples(html) {
  const plain = html
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, '&');
  const out = {};
  for (const [label, key] of [
    ['Incoming SMS (sms_mo)', 'sms_mo'],
    ['SMS status change (dlr)', 'dlr'],
  ]) {
    const at = plain.indexOf(label);
    if (at < 0) throw new Error(`seven.io: example ${label} not found`);
    const open = plain.indexOf('{', at);
    let depth = 0;
    let end = open;
    for (; end < plain.length; end += 1) {
      if (plain[end] === '{') depth += 1;
      if (plain[end] === '}') depth -= 1;
      if (depth === 0) break;
    }
    out[key] = JSON.parse(plain.slice(open, end + 1));
  }
  return out;
}

/** Sorted, stable JSON for diffs. */
const stable = (value) =>
  `${JSON.stringify(
    value,
    (_, v) =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, v[k]])
          )
        : v,
    2
  )}\n`;

const files = {};
for (const [id, source] of Object.entries(SOURCES)) {
  const bytes = await download(source.url);
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== source.sha256) {
    console.error(`${id}: sha256 ${sha} does not match the pinned ${source.sha256} (${source.url})`);
    process.exit(1);
  }
  const doc = source.format === 'yaml' ? YAML.parse(bytes.toString('utf8')) : JSON.parse(bytes.toString('utf8'));
  files[`${id}.json`] = {
    source: { url: source.url, repository: source.repository, commit: source.commit, sha256: source.sha256 },
    spec: extractOpenApi(doc, source),
  };
}

const telegramHtml = (await download(TELEGRAM_URL)).toString('utf8');
files['telegram.json'] = {
  source: {
    url: TELEGRAM_URL,
    machineReadable: false,
    note: 'Method and type tables of the official HTML page converted to JSON Schema by scripts/contract-specs.mjs',
  },
  spec: extractTelegram(telegramHtml),
};

const sevenHtml = (await download(SEVEN_WEBHOOKS_URL)).toString('utf8');
files['seven-webhooks.json'] = {
  source: { url: SEVEN_WEBHOOKS_URL, machineReadable: false, note: 'Official JSON examples from the docs page' },
  examples: extractSevenExamples(sevenHtml),
};

files['twilio-webhooks.json'] = TWILIO_WEBHOOK;

let changed = 0;
mkdirSync(outDir, { recursive: true });
for (const [name, value] of Object.entries(files)) {
  const target = path.join(outDir, name);
  const next = stable(value);
  let current;
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    current = '';
  }
  if (current === next) continue;
  changed += 1;
  if (check) console.error(`${name}: the official source changed; run npm run contract:specs and review the diff`);
  else writeFileSync(target, next);
}
if (check && changed) process.exit(1);
console.log(check ? 'contract specs are current' : `contract specs written (${changed} changed)`);
