// MessageGate cluster proof, run by scripts/cluster-acceptance.mjs: 8 Strapi
// processes on one PostgreSQL database behind a non-sticky balancer, fake
// providers with a control endpoint. Ports and the database come from the
// MG_CLUSTER_* environment variables set by the runner.
// Synthetic data only. Prints counts and status codes; never prints secrets or tokens.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';

const env = process.env;
const BAL = `http://127.0.0.1:${env.MG_CLUSTER_BALANCER_PORT || 1480}`;
const PORTS = (env.MG_CLUSTER_PORTS || '1491,1492,1493,1494,1495,1496,1497,1498').split(',').map(Number);
const FAKE = `http://127.0.0.1:${env.MG_CLUSTER_FAKE_CONTROL_PORT || 1482}`;
if (!env.MG_CLUSTER_PG_URL) throw new Error('MG_CLUSTER_PG_URL is required');
const db = new pg.Client({ connectionString: env.MG_CLUSTER_PG_URL });
await db.connect();
const N = Number(process.env.N || 500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (list) => list[crypto.randomInt(list.length)];
const report = [];
const log = (line) => {
  console.log(line);
  report.push(line);
};
// Returns rows like `psql -At`: columns joined with "|", rows with newlines.
const sql = async (q) => {
  const { rows } = await db.query(q);
  return rows.map((row) => Object.values(row).join('|')).join('\n');
};

async function pool(items, size, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    })
  );
  return out;
}

// Admin session (JWT is valid on every process: shared secret, sessions in the database).
const admin = { email: 'cluster-admin@example.test', password: 'Rv1!' + crypto.randomBytes(12).toString('base64url') };
// The generated admin password stays in memory; it is never written or printed.
let res = await fetch(`${BAL}/admin/register-admin`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ firstname: 'Cluster', lastname: 'Admin', ...admin }),
});
log(`register-admin ${res.status}`);
res = await fetch(`${BAL}/admin/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(admin),
});
const jwt = (await res.json()).data.token;
const adminApi = async (method, path, body, base = BAL) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) log(`  ! ${method} ${path} ${r.status} ${json?.error?.details?.code || json?.error?.message || ''}`);
  return json.data;
};
const mg = (method, path, body, base) => adminApi(method, `/magic-messagegate${path}`, body, base);

// Accounts with known signing secrets (synthetic).
const appSecret = crypto.randomBytes(24).toString('hex');
const sevenKey = crypto.randomBytes(20).toString('hex');
const wa = await mg('POST', '/accounts', {
  channel: 'whatsapp',
  provider: 'meta',
  name: 'WhatsApp cluster',
  isDefault: true,
  config: {
    accessToken: `EAAsynthetic${crypto.randomBytes(20).toString('hex')}`,
    phoneNumberId: '106540352242922',
    wabaId: '102290129340398',
    appSecret,
  },
});
await mg('POST', '/accounts', {
  channel: 'sms',
  provider: 'seven',
  name: 'SMS cluster',
  isDefault: true,
  config: { apiKey: crypto.randomBytes(20).toString('hex'), signingKey: sevenKey, senderId: 'Shop' },
});
const vars = [
  { name: 'first_name', example: 'Anna' },
  { name: 'order_id', example: 'A-1' },
];
const tplWa = await mg('POST', '/templates', {
  key: 'order_shipped',
  channel: 'whatsapp',
  language: 'de',
  name: 'Bestellung versandt',
  category: 'UTILITY',
  content: { body: 'Hallo {{first_name}}, Bestellung {{order_id}} ist unterwegs.' },
  variables: vars,
});
await mg('POST', '/templates', {
  key: 'order_shipped',
  channel: 'sms',
  language: 'de',
  name: 'Bestellung versandt (SMS)',
  content: { text: 'Bestellung {{order_id}} ist unterwegs, {{first_name}}.' },
  variables: vars,
});
const submitted = await mg('POST', `/templates/${tplWa.id}/submit`, { accountId: wa.id });

const waPath = new URL(wa.webhookUrl).pathname;
const metaHook = async (changes, port = pick(PORTS)) => {
  const raw = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: '102290129340398', time: Math.floor(Date.now() / 1000), changes }],
  });
  const sig = 'sha256=' + crypto.createHmac('sha256', appSecret).update(raw).digest('hex');
  const r = await fetch(`http://127.0.0.1:${port}${waPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig },
    body: raw,
  });
  return r.status;
};
await metaHook([
  {
    field: 'message_template_status_update',
    value: {
      event: 'APPROVED',
      message_template_id: submitted.providerTemplateId,
      message_template_name: 'order_shipped',
      message_template_language: 'de',
    },
  },
]);
const { settings, revision } = await mg('GET', '/settings');
await mg('PUT', '/settings', {
  revision,
  settings: { ...settings, requireConsent: true, routing: { ...settings.routing, defaultChain: ['whatsapp', 'sms'] } },
});

// API token for the Content API.
const tok = await adminApi('POST', '/admin/api-tokens', {
  name: `cluster-${Date.now()}`,
  type: 'full-access',
  lifespan: null,
});
const api = async (method, path, body, base = BAL) => {
  const r = await fetch(`${base}/api/magic-messagegate${path}`, {
    method,
    headers: { authorization: `Bearer ${tok.accessKey}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify({ data: body }) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

// 1) Consent + 500 sends spread over all processes, plus 50 replays with the same key.
const phone = (i) => `+49155501${String(i).padStart(5, '0')}`;
const phones = Array.from({ length: N + 20 }, (_, i) => phone(i));
await pool(phones, 25, async (p) => {
  await api('POST', '/consent', { phone: p, channel: 'whatsapp', status: 'granted' });
  await api('POST', '/consent', { phone: p, channel: 'sms', status: 'granted' });
});
log(`consents ${phones.length * 2}`);
const send = (p, i, base) =>
  api(
    'POST',
    '/messages',
    {
      to: p,
      template: 'order_shipped',
      language: 'de',
      variables: { first_name: 'Test', order_id: `A-${i}` },
      idempotencyKey: `order-${i}`,
    },
    base
  );
const t0 = Date.now();
const first = await pool(phones.slice(0, N), 25, (p, i) => send(p, i, `http://127.0.0.1:${PORTS[i % PORTS.length]}`));
const replays = await pool(phones.slice(0, 50), 10, (p, i) =>
  send(p, i, `http://127.0.0.1:${PORTS[(i + 3) % PORTS.length]}`)
);
log(
  `sends: ${first.filter((r) => r.status === 202).length}x202 of ${N}; replays: ${replays.filter((r) => r.status === 200 && r.json?.data?.duplicate).length}x200 duplicate of 50`
);
const bad = first.find((r) => r.status !== 202);
if (bad) log(`  first non-202 send: ${bad.status} ${bad.json?.error?.details?.code || bad.json?.error?.message}`);
const consentCheck = await api('POST', '/consent', { phone: phones[0], channel: 'whatsapp', status: 'granted' });
log(`consent call: ${consentCheck.status}`);
const ids = new Set(first.map((r) => r.json?.data?.id));
log(`distinct message ids ${ids.size}`);

async function waitFor(check, label, ms = 180_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return true;
    await sleep(1000);
  }
  log(`  ! timeout waiting for ${label}`);
  return false;
}
await waitFor(
  async () => Number(await sql(`select count(*) from mg_messages where status in ('sent','delivered','read')`)) >= N,
  'all sent'
);
log(`all ${N} sent after ${Math.round((Date.now() - t0) / 1000)} s`);
let sends = await (await fetch(`${FAKE}/sends`)).json();
const metaSends = sends.filter((s) => s.route === 'meta.send');
const perPhone = new Map();
for (const s of metaSends) perPhone.set(s.to, (perPhone.get(s.to) || 0) + 1);
const dupes = [...perPhone.values()].filter((n) => n > 1).length;
log(`provider received ${metaSends.length} WhatsApp sends for ${perPhone.size} numbers; numbers sent twice: ${dupes}`);
log(
  `messages per process (claimed_by): ${await sql(`select count(distinct claimed_by) from mg_messages where status in ('sent','delivered','read')`)} distinct holders`
);

// 2) Status webhooks in random order to random processes; statuses must end at "read".
const sample = metaSends.slice(0, 200);
if (!sample.length) throw new Error('no WhatsApp sends reached the provider');
const order = ['read', 'sent', 'delivered'];
await pool(sample, 20, async (s) => {
  for (const st of [...order].sort(() => crypto.randomInt(3) - 1)) {
    await metaHook([
      {
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          statuses: [
            {
              id: s.id,
              status: st,
              timestamp: String(Math.floor(Date.now() / 1000)),
              recipient_id: s.to.replace('+', ''),
            },
          ],
        },
      },
    ]);
  }
  // Replay of the same "read" event to another process.
  await metaHook([
    {
      field: 'messages',
      value: { statuses: [{ id: s.id, status: 'read', timestamp: String(Math.floor(Date.now() / 1000)) }] },
    },
  ]);
});
const finalStatuses = await sql(
  `select status, count(*) from mg_messages where provider_message_id in (${sample.map((s) => `'${s.id}'`).join(',')}) group by status`
);
log(`after shuffled status webhooks for ${sample.length} messages: ${finalStatuses.replace(/\n/g, ', ')}`);

// 3) Fallback: 20 messages fail with 131026 -> SMS once each, number marked "not on WhatsApp".
const fbPhones = phones.slice(N, N + 20);
const fb = await pool(fbPhones, 10, (p, i) => send(p, N + i, `http://127.0.0.1:${PORTS[i % PORTS.length]}`));
await waitFor(async () => {
  sends = await (await fetch(`${FAKE}/sends`)).json();
  return sends.filter((s) => s.route === 'meta.send' && fbPhones.includes(s.to)).length >= 20;
}, 'fallback whatsapp sends');
const fbWa = sends.filter((s) => s.route === 'meta.send' && fbPhones.includes(s.to));
await pool(fbWa, 10, (s) =>
  metaHook([
    {
      field: 'messages',
      value: {
        statuses: [
          {
            id: s.id,
            status: 'failed',
            timestamp: String(Math.floor(Date.now() / 1000)),
            errors: [{ code: 131026, title: 'Message undeliverable' }],
          },
        ],
      },
    },
  ])
);
await waitFor(async () => {
  sends = await (await fetch(`${FAKE}/sends`)).json();
  return sends.filter((s) => s.route === 'seven.send').length >= 20;
}, 'sms fallback');
await sleep(3000);
sends = await (await fetch(`${FAKE}/sends`)).json();
const sms = sends.filter((s) => s.route === 'seven.send');
log(
  `fallback: ${fb.filter((r) => r.status === 202).length} sends, ${fbWa.length} WhatsApp failures (131026), ${sms.length} SMS sends, unreachable contacts ${await sql(`select count(*) from mg_contacts where wa_reachability='unreachable'`)}`
);

// 4) STOP on one process, then a WhatsApp-only send on another process.
const stopPhone = phones[0];
await metaHook(
  [
    {
      field: 'messages',
      value: {
        contacts: [{ wa_id: stopPhone.replace('+', '') }],
        messages: [
          {
            from: stopPhone.replace('+', ''),
            id: `wamid.IN${crypto.randomBytes(6).toString('hex')}`,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'text',
            text: { body: 'STOP' },
          },
        ],
      },
    },
  ],
  PORTS[0]
);
const afterStop = await api(
  'POST',
  '/messages',
  {
    to: stopPhone,
    channel: 'whatsapp',
    template: 'order_shipped',
    language: 'de',
    variables: { first_name: 'T', order_id: 'X' },
  },
  `http://127.0.0.1:${PORTS[PORTS.length - 1]}`
);
log(
  `STOP via process ${PORTS[0]}, WhatsApp send via ${PORTS[PORTS.length - 1]}: ${afterStop.status} ${afterStop.json?.error?.details?.code}`
);

// 5) Maintenance lease: exactly one holder.
await sleep(35_000);
log(`leases: ${await sql(`select claim_key, holder from mg_claims order by claim_key`).replace(/\n/g, ', ')}`);

const resultFile = env.MG_CLUSTER_RESULT || path.join(os.tmpdir(), 'messagegate-cluster-result.txt');
fs.writeFileSync(resultFile, report.join('\n') + '\n');
log(`result written to ${resultFile}`);
await adminApi('DELETE', `/admin/api-tokens/${tok.id}`);
await db.end();
