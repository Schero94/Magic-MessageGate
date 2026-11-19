'use strict';

/**
 * Shared setup for the opt-in live suites in tests/live/ (never part of
 * `npm test`, never run in CI). Values from the credentials file are kept in
 * memory and never printed: messages built here name variables, never values.
 *
 * Credentials: ~/.config/magic-messagegate-live/.env, created by the owner
 * with mode 600. Key names per provider are listed in docs/live-tests.md.
 *
 * LIVE_PROVIDERS picks the providers of a run (comma-separated: telegram,
 * twilio, meta, seven), from the process environment first, then the file.
 * Without it, every provider whose required keys are complete runs.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ENV_FILE = path.join(os.homedir(), '.config', 'magic-messagegate-live', '.env');
const PROVIDERS = ['telegram', 'twilio', 'meta', 'seven'];

/** Required keys per provider (the free, safe part of each suite). */
const REQUIRED = {
  telegram: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'],
  twilio: ['TWILIO_TEST_ACCOUNT_SID', 'TWILIO_TEST_AUTH_TOKEN'],
  meta: ['META_ACCESS_TOKEN', 'META_PHONE_NUMBER_ID', 'META_WABA_ID', 'META_TEST_RECIPIENT'],
  seven: ['SEVEN_API_KEY'],
};

/** Hosts a live suite may reach. Everything else is refused. */
const ALLOWED_HOSTS = new Set([
  'api.telegram.org',
  'api.twilio.com',
  'lookups.twilio.com',
  'content.twilio.com',
  'graph.facebook.com',
  'gateway.seven.io',
]);

/**
 * Reads KEY=value lines (no expansion; surrounding quotes stripped). Refuses
 * a file other users can read.
 *
 * @param {string} [file]
 * @returns {{env: Record<string, string>|null, problem: string|null}}
 */
function readLiveEnv(file = ENV_FILE) {
  if (!fs.existsSync(file)) return { env: null, problem: `${file} does not exist` };
  const mode = fs.statSync(file).mode & 0o777;
  if (mode & 0o077) return { env: null, problem: `${file} must have mode 600 (chmod 600)` };
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return { env, problem: null };
}

/**
 * Loads the credentials and decides which providers run.
 *
 * @param {string} [file] - Credentials file (tests use a temporary one).
 * @returns {{env: Record<string, string>, selectionError: string|null, skipReason: (provider: string) => string|null, flag: (name: string) => boolean, optIn: Function}}
 */
function loadLiveConfig(file = ENV_FILE) {
  const { env, problem } = readLiveEnv(file);
  const values = env || {};
  const missingFor = (provider) => REQUIRED[provider].filter((key) => !values[key]);
  const raw = process.env.LIVE_PROVIDERS ?? values.LIVE_PROVIDERS;
  let selected = PROVIDERS.filter((p) => missingFor(p).length === 0);
  let selectionError = null;
  if (raw !== undefined && String(raw).trim() !== '') {
    const names = String(raw)
      .split(',')
      .map((n) => n.trim().toLowerCase())
      .filter(Boolean);
    const unknown = names.filter((n) => !PROVIDERS.includes(n));
    if (unknown.length) {
      selectionError = `LIVE_PROVIDERS has unknown provider(s) ${unknown.join(', ')}; use ${PROVIDERS.join(', ')}`;
    }
    selected = PROVIDERS.filter((p) => names.includes(p));
  }
  /**
   * @param {string} provider
   * @returns {string|null} Why the provider's tests are skipped, or null.
   */
  const skipReason = (provider) => {
    if (selectionError) return selectionError;
    if (problem) return problem;
    if (!selected.includes(provider))
      return `${provider} not selected (LIVE_PROVIDERS=${selected.join(',') || 'none'})`;
    const missing = missingFor(provider);
    return missing.length ? `${provider}: missing ${missing.join(', ')} in ${file}` : null;
  };
  /**
   * Opt-in switches (LIVE_WEBHOOKS, LIVE_ALLOW_PAID, LIVE_INTERACTIVE): process env first, then the file.
   *
   * @param {string} name
   * @returns {boolean}
   */
  const flag = (name) => (process.env[name] ?? values[name]) === '1';
  /**
   * Skip reason for an opt-in test: the provider's own reason, a missing
   * switch, or missing extra keys.
   *
   * @param {string} provider
   * @param {{flags?: Record<string, string>, keys?: string[]}} need - flag → why it is needed
   * @returns {string|false}
   */
  const optIn = (provider, { flags = {}, keys = [] } = {}) => {
    const base = skipReason(provider);
    if (base) return base;
    for (const [name, why] of Object.entries(flags)) if (!flag(name)) return `${name}=1 not set (${why})`;
    const missing = keys.filter((key) => !values[key]);
    return missing.length ? `missing ${missing.join(', ')} in ${file}` : false;
  };
  return { env: values, selectionError, skipReason, flag, optIn };
}

/**
 * Path for the request log with secrets and ids masked.
 *
 * @param {string} pathname
 * @returns {string}
 */
const maskedPath = (pathname) =>
  pathname
    .replace(/\/bot[^/]+/, '/bot<token>')
    .replace(/AC[0-9a-f]{32}/g, '<account>')
    .replace(/(SM|MM|HX|MG)[0-9a-f]{32}/g, '$1<sid>')
    .replace(/\/PhoneNumbers\/[^/]+/, '/PhoneNumbers/<number>')
    .replace(/\/\d{6,}/g, '/<id>');

/**
 * Replaces global fetch: only ALLOWED_HOSTS (plus `extraHosts`) are
 * reachable, and a log without secrets is kept (host, method, masked path,
 * status).
 *
 * @param {{extraHosts?: RegExp[]}} [options] - e.g. Meta media CDN hosts.
 * @returns {{results: object[], restore: () => void}}
 */
function installLiveFetch({ extraHosts = [] } = {}) {
  const results = [];
  const original = global.fetch;
  global.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (!ALLOWED_HOSTS.has(url.hostname) && !extraHosts.some((re) => re.test(url.hostname))) {
      throw new TypeError(`live suite: host not allowed (${url.hostname})`);
    }
    const response = await original(input, init);
    results.push({
      host: url.hostname,
      method: String(init.method || 'GET').toUpperCase(),
      path: maskedPath(url.pathname),
      status: response.status,
    });
    return response;
  };
  return {
    results,
    restore: () => {
      global.fetch = original;
    },
  };
}

/**
 * Local HTTP server that feeds requests into MessageGate's real webhook
 * controller (raw body kept for the signature check), like Strapi does. The
 * strapi instance is set later with `use()`, because its public URL is the
 * tunnel URL, which exists only after the server listens.
 *
 * @returns {Promise<{port: number, hits: object[], use: (strapi: object) => void, close: () => Promise<void>}>}
 */
async function startWebhookServer() {
  const { makeCtx } = require('./strapi');
  let controller = null;
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const url = new URL(req.url, 'http://localhost');
      const match = /^\/api\/magic-messagegate\/webhooks\/([a-z]+)\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
      if (!match || !controller) {
        res.writeHead(404).end();
        return;
      }
      const raw = Buffer.concat(chunks);
      const headers = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v])
      );
      const ctx = makeCtx({
        method: req.method,
        params: { provider: match[1], path: match[2] },
        query: Object.fromEntries(url.searchParams),
        headers,
        raw: req.method === 'POST' ? raw : undefined,
        path: url.pathname,
      });
      ctx.originalUrl = `${url.pathname}${url.search}`;
      await controller.receive(ctx);
      // Keys only, never values: what arrived, how it was encoded, the answer.
      let keys;
      try {
        keys = Object.keys(JSON.parse(raw.toString('utf8')) || {});
      } catch {
        keys = [...new URLSearchParams(raw.toString('utf8')).keys()];
      }
      hits.push({
        provider: match[1],
        method: req.method,
        contentType: String(headers['content-type'] || '').split(';')[0],
        keys,
        status: ctx.status,
      });
      res.writeHead(ctx.status, { 'content-type': 'text/plain' }).end(ctx.body ? String(ctx.body) : '');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    hits,
    use: (strapi) => {
      controller = require('../../server/src/controllers/webhooks')({ strapi });
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * Runs `fn` with a webhook server behind a cloudflared quick tunnel and
 * always stops both.
 *
 * @template T
 * @param {(io: {url: string, hits: object[], use: (strapi: object) => void}) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withTunnel(fn) {
  const server = await startWebhookServer();
  let tunnel = null;
  try {
    tunnel = await startTunnel(server.port);
    return await fn({ url: tunnel.url, hits: server.hits, use: server.use });
  } finally {
    if (tunnel) tunnel.close();
    await server.close();
  }
}

/**
 * Starts a cloudflared quick tunnel (https://<random>.trycloudflare.com) to a
 * local port. Needs `cloudflared` on PATH.
 *
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<{url: string, close: () => void}>}
 */
function startTunnel(port, timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    const child = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill();
      reject(new Error('cloudflared did not report a tunnel URL'));
    }, timeoutMs);
    const onData = (chunk) => {
      const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(String(chunk));
      if (match && !done) {
        done = true;
        clearTimeout(timer);
        // The URL is printed before the edge accepts requests; give it time.
        setTimeout(() => resolve({ url: match[0], close: () => child.kill() }), 5000);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * Polls `check` until it returns a truthy value or the time is up.
 *
 * @template T
 * @param {() => Promise<T>} check
 * @param {number} timeoutMs
 * @param {number} [everyMs]
 * @returns {Promise<T|null>}
 */
async function waitFor(check, timeoutMs, everyMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return null;
}

module.exports = {
  ENV_FILE,
  readLiveEnv,
  PROVIDERS,
  REQUIRED,
  ALLOWED_HOSTS,
  loadLiveConfig,
  installLiveFetch,
  maskedPath,
  startWebhookServer,
  startTunnel,
  withTunnel,
  waitFor,
};
