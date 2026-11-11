'use strict';

/**
 * Release pipeline contract: semantic-release configuration, the local
 * plugin that folds the hand-written [Unreleased] section into the notes and
 * strips co-author trailers, and the release/CI workflows.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, writeFile, rm } = require('node:fs/promises');
const { readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const root = join(__dirname, '..');
const loadPlugin = () => import('../scripts/release-unreleased.mjs');
const readText = (file) => readFileSync(join(root, file), 'utf8');

const SAMPLE = `# Changelog

## [Unreleased]

### Migration

* Do the thing.
`;

test('releases use their own tag format, so the old magic-whatsapp tags are ignored and the first release is 1.0.0', () => {
  const config = JSON.parse(readText('.releaserc.json'));
  assert.equal(config.tagFormat, 'messagegate-v${version}');
  assert.deepEqual(config.branches, ['main']);
  const names = config.plugins.map((p) => (Array.isArray(p) ? p[0] : p));
  const npm = config.plugins.find((p) => (Array.isArray(p) ? p[0] : p) === '@semantic-release/npm');
  assert.ok(!Array.isArray(npm) || npm[1].npmPublish !== false, 'npm publishing is enabled');
  assert.ok(
    names.indexOf('./scripts/release-unreleased.mjs') > names.indexOf('@semantic-release/release-notes-generator')
  );
  assert.ok(names.indexOf('./scripts/release-unreleased.mjs') < names.indexOf('@semantic-release/changelog'));
});

test('the release plugin moves [Unreleased] into the notes and keeps the changelog title', async () => {
  const { generateNotes, prepare, splitUnreleased } = await loadPlugin();
  assert.equal(splitUnreleased(SAMPLE).body, '### Migration\n\n* Do the thing.');
  const cwd = await mkdtemp(join(tmpdir(), 'mg-release-'));
  try {
    await writeFile(join(cwd, 'CHANGELOG.md'), SAMPLE);
    assert.equal(await generateNotes({}, { cwd }), '### Migration\n\n* Do the thing.');
    await prepare({}, { cwd, logger: { log() {} } });
    const after = await readFile(join(cwd, 'CHANGELOG.md'), 'utf8');
    assert.ok(!after.includes('[Unreleased]'));
    assert.ok(after.startsWith('# Changelog'));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('release notes and the CHANGELOG carry no co-author trailers', async () => {
  const { prepare, stripCoAuthorTrailers } = await loadPlugin();
  const notes =
    '### BREAKING CHANGES\n\n* old transport removed.\n\nCo-Authored-By: Someone <a@example.test>\n\n* other\nco-authored-by: x <y@example.test>\n';
  assert.equal(stripCoAuthorTrailers(notes), '### BREAKING CHANGES\n\n* old transport removed.\n\n* other\n');
  const cwd = await mkdtemp(join(tmpdir(), 'mg-release-'));
  try {
    await writeFile(join(cwd, 'CHANGELOG.md'), '# Changelog\n');
    const nextRelease = { notes };
    await prepare({}, { cwd, logger: { log() {} }, nextRelease });
    assert.doesNotMatch(nextRelease.notes, /co-authored-by/i);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
  assert.doesNotMatch(readText('CHANGELOG.md'), /co-authored-by/i);
  const count = (readText('CHANGELOG.md').match(/^## \[Unreleased\]/gm) || []).length;
  assert.ok(count <= 1);
});

const SHA_PIN = /uses:\s*[\w.-]+\/[\w.-]+(?:\/[\w.-]+)?@[0-9a-f]{40}\b/;

test('every workflow pins actions to a commit SHA and keeps the token read-only by default', () => {
  for (const file of ['release.yml', 'ci.yml', 'pages.yml', 'dependency-auto-merge.yml']) {
    const text = readText(`.github/workflows/${file}`);
    const uses = text.split('\n').filter((line) => /^\s*-?\s*uses:/.test(line));
    assert.ok(uses.length > 0, `${file} uses actions`);
    for (const line of uses) assert.match(line, SHA_PIN, `${file}: ${line.trim()}`);
    assert.match(text, /^permissions:\n {2}contents: read/m, `${file} defaults to read-only`);
  }
});

test('the release job runs the full gate and publishes with OIDC, a token fallback and provenance', () => {
  const text = readText('.github/workflows/release.yml');
  for (const step of [
    'npm ci --ignore-scripts',
    'npm run lint',
    'npm run format:check',
    'npm run build',
    'npm test',
    'npm run verify',
    'npm audit --omit=dev',
    'npm install --global npm@11',
  ]) {
    assert.ok(text.includes(step), `release.yml runs ${step}`);
  }
  assert.match(text, /id-token: write/);
  assert.match(text, /NPM_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
  assert.match(text, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
  assert.match(text, /NPM_CONFIG_PROVENANCE: 'true'/);
  assert.ok(text.indexOf('npm audit --omit=dev') < text.indexOf('npx --no-install semantic-release'));
});

test('CI covers Node 22 and 24 and a digest-pinned PostgreSQL 16 service for test:pg', () => {
  const text = readText('.github/workflows/ci.yml');
  assert.match(text, /node: \['22', '24'\]/);
  assert.match(text, /image: postgres:16[\w.-]*@sha256:[0-9a-f]{64}/);
  assert.ok(text.includes('npm run test:pg'));
  assert.ok(text.includes('MG_TEST_PG_URL'));
  for (const step of [
    'npm run lint',
    'npm run format:check',
    'npm test',
    'npm run verify',
    'npm pack --dry-run',
    'npm audit --omit=dev',
  ]) {
    assert.ok(text.includes(step), `ci.yml runs ${step}`);
  }
});

test('Dependabot waits before proposing releases and never proposes versions the Strapi admin cannot run', () => {
  const text = readText('.github/dependabot.yml');
  assert.match(text, /package-ecosystem: npm/);
  assert.match(text, /package-ecosystem: github-actions/);
  assert.match(text, /semver-major-days: 14/);
  assert.match(text, /semver-minor-days: 7/);
  assert.match(text, /semver-patch-days: 7/);
  for (const name of [
    'react',
    'react-dom',
    'react-intl',
    'react-router-dom',
    'styled-components',
    '@strapi/*',
    '@strapi/design-system',
    '@strapi/icons',
    'typescript',
  ]) {
    assert.ok(text.includes(`dependency-name: '${name}'`), `ignores ${name}`);
  }
});
