#!/usr/bin/env node
/**
 * 8-process acceptance run for Magic MessageGate.
 *
 * Starts fake providers, a non-sticky round-robin balancer and eight Strapi
 * processes (two groups of four) of an existing Strapi 5.61 app that uses one
 * PostgreSQL database, then runs scripts/cluster/proof.mjs: 500 sends, exactly
 * once, shuffled status webhooks, fallback on error 131026, STOP across
 * processes and the maintenance lease. Everything is stopped afterwards.
 *
 * Usage (see CONTRIBUTING.md):
 *   node scripts/cluster-acceptance.mjs --app ../mg-cluster-app \
 *     --pg postgres://strapi@127.0.0.1:5440/mg_cluster [--reset] [--write-config] [--base 1480]
 *
 * Safety:
 * - secrets (APP_KEYS, JWT secrets, encryption keys) are random per run, kept
 *   in memory and never printed;
 * - outgoing network is blocked in every process (block-egress.cjs);
 * - reserved workbench ports and busy ports are refused;
 * - the database name must start with "mg_"; --reset drops and recreates its
 *   public schema;
 * - the app folder must be outside this repository.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const RESERVED = new Set([1337, 1338, 1340, 1345, 1351, 1352, 1353, 1354, 1355, 1356]);
for (let p = 1371; p <= 1388; p += 1) RESERVED.add(p);

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const fail = (message) => {
  console.error(`cluster-acceptance: ${message}`);
  process.exit(1);
};

const appDir = path.resolve(option('app', process.env.MG_CLUSTER_APP || ''));
const pgUrl = option('pg', process.env.MG_CLUSTER_PG_URL || '');
const base = Number(option('base', '1480'));
if (!option('app', process.env.MG_CLUSTER_APP)) fail('--app <Strapi app folder> is required');
if (!pgUrl) fail('--pg <postgres url> is required');
if (appDir === repo || appDir.startsWith(repo + path.sep)) fail('the app folder must be outside this repository');
if (!fs.existsSync(path.join(appDir, 'package.json'))) fail(`no Strapi app at ${appDir}`);
const dbName = new URL(pgUrl).pathname.slice(1);
if (!/^mg_[a-z0-9_]+$/.test(dbName)) fail('the database name must start with "mg_" (it is reset between runs)');

const ports = {
  balancer: base,
  fake: base + 1,
  control: base + 2,
  strapi: Array.from({ length: 8 }, (_, i) => base + 11 + i),
};
const allPorts = [ports.balancer, ports.fake, ports.control, ...ports.strapi];
for (const p of allPorts) if (RESERVED.has(p)) fail(`port ${p} is reserved; choose another --base`);

const isFree = (port) =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
for (const p of allPorts) if (!(await isFree(p))) fail(`port ${p} is busy`);

if (flag('write-config')) {
  const target = path.join(appDir, 'config');
  fs.mkdirSync(target, { recursive: true });
  for (const file of fs.readdirSync(path.join(here, 'cluster', 'app-config'))) {
    fs.copyFileSync(path.join(here, 'cluster', 'app-config', file), path.join(target, file));
  }
  console.log(`wrote the cluster config into ${target}`);
}

if (flag('reset')) {
  const db = new pg.Client({ connectionString: pgUrl });
  await db.connect();
  await db.query('DROP SCHEMA IF EXISTS public CASCADE');
  await db.query('CREATE SCHEMA public');
  await db.end();
  console.log(`reset database ${dbName}`);
}

const secret = () => crypto.randomBytes(24).toString('base64');
const runEnv = {
  ...process.env,
  NODE_ENV: 'production',
  // Quoted: NODE_OPTIONS splits on spaces, and checkouts may live in folders with spaces.
  NODE_OPTIONS: `-r "${path.join(here, 'cluster', 'block-egress.cjs')}"`,
  DATABASE_CLIENT: 'postgres',
  DATABASE_URL: pgUrl,
  APP_KEYS: [secret(), secret()].join(','),
  ADMIN_JWT_SECRET: secret(),
  API_TOKEN_SALT: secret(),
  TRANSFER_TOKEN_SALT: secret(),
  ENCRYPTION_KEY: secret(),
  JWT_SECRET: secret(),
  MG_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
  MG_SIGNUP_SECRET: secret(),
  MG_SIGNUP_VERIFY: secret(),
  MG_CLUSTER_BALANCER_PORT: String(ports.balancer),
  MG_CLUSTER_FAKE_PORT: String(ports.fake),
  MG_CLUSTER_FAKE_CONTROL_PORT: String(ports.control),
  MG_CLUSTER_PORTS: ports.strapi.join(','),
  MG_CLUSTER_PG_URL: pgUrl,
};

const children = [];
const logDir = fs.mkdtempSync(path.join(appDir, '.mg-cluster-logs-'));
const start = (name, command, commandArgs, extraEnv = {}, cwd = appDir) => {
  const out = fs.openSync(path.join(logDir, `${name}.log`), 'w');
  const child = spawn(command, commandArgs, { cwd, env: { ...runEnv, ...extraEnv }, stdio: ['ignore', out, out] });
  children.push(child);
  return child;
};
const stopAll = () => {
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
};
process.on('SIGINT', () => {
  stopAll();
  process.exit(130);
});

const waitHealthy = async (port, ms = 180_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/_health`);
      if (res.status === 204 || res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`process on ${port} did not become healthy (logs in ${logDir})`);
};

let code = 1;
try {
  start('fake', process.execPath, [path.join(here, 'cluster', 'fake-server.cjs')]);
  start('balancer', process.execPath, [path.join(here, 'cluster', 'balancer.cjs')]);
  const strapiBin = path.join(appDir, 'node_modules', '.bin', 'strapi');
  // The first process creates the schema alone: Strapi core does not coordinate schema sync.
  start(`strapi-${ports.strapi[0]}`, strapiBin, ['start'], { PORT: String(ports.strapi[0]) });
  await waitHealthy(ports.strapi[0]);
  for (const p of ports.strapi.slice(1)) start(`strapi-${p}`, strapiBin, ['start'], { PORT: String(p) });
  for (const p of ports.strapi.slice(1)) await waitHealthy(p);
  console.log(`8 processes healthy on ${ports.strapi.join(', ')}; balancer on ${ports.balancer}`);
  const proof = spawn(process.execPath, [path.join(here, 'cluster', 'proof.mjs')], {
    cwd: repo,
    env: runEnv,
    stdio: 'inherit',
  });
  code = await new Promise((resolve) => proof.on('exit', (exitCode) => resolve(exitCode ?? 1)));
} catch (error) {
  console.error(`cluster-acceptance: ${error.message}`);
} finally {
  stopAll();
  console.log(`process logs: ${logDir}`);
}
process.exit(code);
