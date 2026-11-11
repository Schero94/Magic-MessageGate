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

// 6) 1.1: RCS in the chain (WhatsApp 131026 -> RCS 63036 -> SMS, callbacks repeated on
// random processes), attachments with signed SMS links, and dry runs that queue nothing.
const FAKE_API = `http://127.0.0.1:${env.MG_CLUSTER_FAKE_PORT || 1481}`;
const hex32 = () => crypto.randomBytes(16).toString('hex');
const rcsToken = hex32();
const rcsSid = `AC${hex32()}`;
const rcs = await mg('POST', '/accounts', {
  channel: 'rcs',
  provider: 'twilio',
  name: 'RCS cluster',
  isDefault: true,
  config: { accountSid: rcsSid, authToken: rcsToken, messagingServiceSid: `MG${hex32()}` },
});
await mg('POST', '/templates', {
  key: 'order_shipped',
  channel: 'rcs',
  language: 'de',
  name: 'Bestellung versandt (RCS)',
  content: { text: 'Bestellung {{order_id}} ist unterwegs, {{first_name}}.' },
  variables: vars,
});
{
  const current = await mg('GET', '/settings');
  await mg('PUT', '/settings', {
    revision: current.revision,
    settings: {
      ...current.settings,
      routing: { ...current.settings.routing, defaultChain: ['whatsapp', 'rcs', 'sms'] },
    },
  });
}
const rcsPhones = Array.from({ length: 20 }, (_, i) => phone(N + 40 + i));
await pool(rcsPhones, 10, async (p) => {
  for (const channel of ['whatsapp', 'rcs', 'sms'])
    await api('POST', '/consent', { phone: p, channel, status: 'granted' });
});
await fetch(`${FAKE}/queue`, {
  method: 'POST',
  body: JSON.stringify({
    route: 'meta.send',
    answer: { status: 400, json: { error: { code: 131026, message: 'x' } } },
    times: 20,
  }),
});
const smsBefore = (await (await fetch(`${FAKE}/sends`)).json()).filter((x) => x.route === 'seven.send').length;
await pool(rcsPhones, 10, (p, i) => send(p, N + 40 + i, `http://127.0.0.1:${PORTS[i % PORTS.length]}`));
await waitFor(
  async () => Number(await sql(`select count(*) from mg_messages where channel = 'rcs' and status = 'sent'`)) >= 20,
  'RCS sent'
);
const rcsForms = await (await fetch(`${FAKE}/requests?route=twilio.send`)).json();
log(
  `RCS sends: ${rcsForms.length}, all with rcs: prefix and Messaging Service: ${rcsForms.every((f) => f.form.To.startsWith('rcs:') && f.form.MessagingServiceSid)}`
);
const rcsUrl = rcs.webhookUrl;
const twilioSign = (params) =>
  crypto
    .createHmac('sha1', rcsToken)
    .update(
      Buffer.from(
        Object.keys(params)
          .sort()
          .reduce((acc, k) => acc + k + params[k], rcsUrl),
        'utf8'
      )
    )
    .digest('base64');
const twilioPost = (params, port) =>
  fetch(`http://127.0.0.1:${port}${new URL(rcsUrl).pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSign(params) },
    body: new URLSearchParams(params).toString(),
  }).then((r) => r.status);
const callbackStatuses = [];
await pool(rcsForms, 10, async (f) => {
  const params = { AccountSid: rcsSid, MessageSid: f.answer.sid, MessageStatus: 'undelivered', ErrorCode: '63036' };
  callbackStatuses.push(
    ...(await Promise.all([
      twilioPost(params, pick(PORTS)),
      twilioPost(params, pick(PORTS)),
      twilioPost(params, pick(PORTS)),
    ]))
  );
});
log(
  `RCS 63036 callbacks: ${callbackStatuses.length} posts (3 per message, random processes), statuses ${[...new Set(callbackStatuses)].join(',')}`
);
await waitFor(async () => {
  const s = (await (await fetch(`${FAKE}/sends`)).json()).filter((x) => x.route === 'seven.send').length;
  return s - smsBefore >= 20;
}, 'SMS after RCS');
await sleep(3000);
const smsAfter = (await (await fetch(`${FAKE}/sends`)).json()).filter((x) => x.route === 'seven.send').slice(smsBefore);
const smsPer = new Map();
for (const x of smsAfter) smsPer.set(x.to, (smsPer.get(x.to) || 0) + 1);
log(`fallback WhatsApp -> RCS -> SMS: ${smsPer.size} numbers got SMS, max per number ${Math.max(...smsPer.values())}`);
log(
  `contacts marked not RCS capable: ${await sql(`select count(*) from mg_contacts where rcs_capability = 'not_capable'`)}`
);

const messagesBefore = Number(await sql('select count(*) from mg_messages'));
const dry = await pool(PORTS, 8, (port) =>
  api(
    'POST',
    '/messages',
    {
      to: rcsPhones[0],
      channel: 'sms',
      text: 'Rechnung',
      attachment: { url: 'https://cdn.example.test/invoice.pdf', mimeType: 'application/pdf' },
      dryRun: true,
    },
    `http://127.0.0.1:${port}`
  )
);
log(
  `dry runs on 8 processes: ${dry.filter((r) => r.status === 200 && r.json?.data?.dryRun && r.json.data.valid).length}x valid, messages created: ${Number(await sql('select count(*) from mg_messages')) - messagesBefore}`
);
const attachPhones = rcsPhones.slice(0, 5);
await pool(attachPhones, 5, (p, i) =>
  api(
    'POST',
    '/messages',
    {
      to: p,
      channel: 'sms',
      text: 'Ihre Rechnung',
      attachment: { url: 'https://cdn.example.test/invoice.pdf', mimeType: 'application/pdf' },
      idempotencyKey: `attach-${i}`,
    },
    `http://127.0.0.1:${PORTS[i]}`
  )
);
await sleep(4000);
const sevenForms = await (await fetch(`${FAKE}/requests?route=seven.send`)).json();
const links = sevenForms
  .map((f) => /\/api\/magic-messagegate\/files\/(\S+)/.exec(f.form?.text || '')?.[1])
  .filter(Boolean);
const linkChecks = await Promise.all(
  links.map((t, i) =>
    fetch(`http://127.0.0.1:${PORTS[(i + 5) % PORTS.length]}/api/magic-messagegate/files/${t}`, {
      redirect: 'manual',
    }).then((r) => `${r.status}:${r.headers.get('location') === 'https://cdn.example.test/invoice.pdf'}`)
  )
);
const forged = await fetch(
  `${BAL}/api/magic-messagegate/files/${links[0]?.replace(/.$/, (c) => (c === '0' ? '1' : '0'))}`,
  { redirect: 'manual' }
);
log(
  `attachment SMS: ${links.length} signed links; opened on other processes: ${[...new Set(linkChecks)].join(',')}; tampered link: ${forged.status}`
);
log(
  `attachment references stored without content: ${await sql(`select count(*) from mg_attachment_links where ref_sealed like 'g1:%'`)}`
);

// 7) 1.1: inbound messages posted 3 times each to random processes: one row, one event
// (counted at the outgoing webhook receiver), one media download each; replies route back.
{
  const current = await mg('GET', '/settings');
  await mg('PUT', '/settings', {
    revision: current.revision,
    settings: {
      ...current.settings,
      outgoingWebhook: { enabled: true, url: `${FAKE_API}/hook`, events: ['message.received', 'media.ready'] },
    },
  });
}
const { secret: hookSecret } = await mg('POST', '/settings/webhook-secret');
const inboundPhones = phones.slice(1, 41);
const inboundIds = inboundPhones.map(() => `wamid.IN11${crypto.randomBytes(8).toString('hex')}`);
const contextFor = new Map(metaSends.map((x) => [x.to, x.id]));
const inboundMessage = (p, i) => {
  const base = { from: p.replace('+', ''), id: inboundIds[i], timestamp: String(Math.floor(Date.now() / 1000)) };
  const context = contextFor.get(p.replace('+', ''))
    ? { context: { from: '4930000000', id: contextFor.get(p.replace('+', '')) } }
    : {};
  if (i < 10)
    return {
      ...base,
      type: 'image',
      image: { id: `9${String(200000 + i)}`, mime_type: 'image/jpeg', caption: 'Foto' },
      ...context,
    };
  if (i < 20)
    return {
      ...base,
      type: 'interactive',
      interactive: { type: 'button_reply', button_reply: { id: 'confirm_yes', title: 'Ja' } },
      ...context,
    };
  return { ...base, type: 'text', text: { body: `Frage ${i}` }, ...context };
};
const posts = [];
await pool(inboundPhones, 10, async (p, i) => {
  const change = [
    {
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { phone_number_id: '106540352242922' },
        messages: [inboundMessage(p, i)],
      },
    },
  ];
  posts.push(
    ...(await Promise.all([
      metaHook(change, pick(PORTS)),
      metaHook(change, pick(PORTS)),
      metaHook(change, pick(PORTS)),
    ]))
  );
});
log(`inbound webhooks: ${inboundPhones.length} messages posted 3 times each to random processes`);
await waitFor(
  async () => (await (await fetch(`${FAKE}/requests?route=hook.receive`)).json()).length >= 50,
  'outgoing webhook deliveries',
  120_000
);
await sleep(8000);
const inboundRows = Number(await sql(`select count(*) from mg_inbound where provider_key like 'meta:wamid.IN11%'`));
const hooks = await (await fetch(`${FAKE}/requests?route=hook.receive`)).json();
const bodies = hooks.map((h) => ({
  body: JSON.parse(h.raw),
  sigOk:
    h.headers['x-messagegate-signature'] ===
    `v1=${crypto.createHmac('sha256', hookSecret).update(`${h.headers['x-messagegate-timestamp']}.${h.raw}`).digest('hex')}`,
}));
const received = bodies.filter((b) => b.body.event === 'message.received');
const readyHooks = bodies.filter((b) => b.body.event === 'media.ready');
log(`inbound rows: ${inboundRows} for ${inboundPhones.length} messages`);
log(
  `message.received deliveries: ${received.length}, distinct inbound ids: ${new Set(received.map((b) => b.body.data.inboundId)).size}, distinct delivery ids: ${new Set(received.map((b) => b.body.id)).size}`
);
log(
  `media: downloads ${(await (await fetch(`${FAKE}/requests?route=meta.mediaFile`)).json()).length} for 10 images, media.ready deliveries ${readyHooks.length}, stored ${await sql(`select count(*) from mg_inbound where media_status = 'ready'`)}`
);
log(
  `outgoing webhook signatures valid: ${bodies.every((b) => b.sigOk)}; no phone numbers in deliveries: ${!hooks.some((h) => /\+?49155/.test(h.raw))}`
);
log(
  `replies linked to our message: ${await sql(`select count(*) from mg_inbound where provider_key like 'meta:wamid.IN11%' and reply_to_message_id is not null`)}`
);
const firstInbound = received[0]?.body.data.inboundId;
const reply = await api(
  'POST',
  `/inbound/${firstInbound}/reply`,
  { text: 'Danke, wir kümmern uns.' },
  `http://127.0.0.1:${pick(PORTS)}`
);
const processedA = await api('POST', `/inbound/${firstInbound}/processed`, {}, `http://127.0.0.1:${PORTS[0]}`);
const processedB = await api('POST', `/inbound/${firstInbound}/processed`, {}, `http://127.0.0.1:${PORTS[1]}`);
log(
  `reply via Content API: ${reply.status} on ${reply.json?.data?.channel}; markProcessed on two processes: alreadyProcessed ${processedA.json?.data?.alreadyProcessed}/${processedB.json?.data?.alreadyProcessed}`
);

// 5) Maintenance lease: exactly one holder.
await sleep(35_000);
log(`leases: ${await sql(`select claim_key, holder from mg_claims order by claim_key`).replace(/\n/g, ', ')}`);

const resultFile = env.MG_CLUSTER_RESULT || path.join(os.tmpdir(), 'messagegate-cluster-result.txt');
fs.writeFileSync(resultFile, report.join('\n') + '\n');
log(`result written to ${resultFile}`);
await adminApi('DELETE', `/admin/api-tokens/${tok.id}`);
await db.end();
