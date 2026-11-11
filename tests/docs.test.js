'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const site = path.join(root, 'docs/site');

test('docs: llms-full.txt matches README.md and AGENTS.md', () => {
  execFileSync(process.execPath, [path.join(root, 'scripts/build-llms-full.mjs'), '--check'], { stdio: 'pipe' });
});

test('docs: every local file the Pages site references exists', () => {
  const html = readFileSync(path.join(site, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|srcset|href)="\.\/([^"#]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length > 10);
  for (const ref of refs) assert.ok(existsSync(path.join(site, ref)), `missing docs/site/${ref}`);
});

test('docs: README images and in-page anchors resolve', () => {
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
  for (const [, file] of readme.matchAll(
    /raw\.githubusercontent\.com\/Schero94\/Magic-MessageGate\/main\/([^)\s]+)/g
  )) {
    assert.ok(existsSync(path.join(root, file)), `README image missing: ${file}`);
  }
  for (const [, file] of readme.matchAll(/\]\(\.\/([^)#]+)\)/g)) {
    assert.ok(existsSync(path.join(root, file)), `README link missing: ${file}`);
  }
  const slug = (h) =>
    h
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s/g, '-');
  const anchors = new Set([...readme.matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1])));
  const html = readFileSync(path.join(site, 'index.html'), 'utf8');
  for (const [, anchor] of html.matchAll(/Magic-MessageGate#([\w-]+)/g)) {
    assert.ok(anchors.has(anchor), `site links to missing README anchor #${anchor}`);
  }
});
