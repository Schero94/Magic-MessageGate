'use strict';

// The Strapi marketplace and npm render the README that ships in the package,
// outside GitHub. Relative links and images resolve against their host there
// and break, and a table without a delimiter row renders as literal pipes.
// These tests keep the README portable.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const PAGES_IMG = 'https://schero94.github.io/Magic-MessageGate/img/';
const REPO = 'https://github.com/Schero94/Magic-MessageGate/';
const MAX_README_IMAGES = 8;

/**
 * Removes fenced code blocks and inline code spans, so example code is not
 * parsed as Markdown links, images or tables.
 * @param {string} markdown
 * @returns {string}
 */
const stripCode = (markdown) => markdown.replace(/^```[\s\S]*?^```/gm, '').replace(/`[^`\n]*`/g, '');

/**
 * Collects every link and image target of a Markdown document: Markdown
 * `](url)` targets and HTML `src` / `href` attributes.
 * @param {string} markdown
 * @returns {{ url: string, image: boolean }[]}
 */
const collectTargets = (markdown) => {
  const text = stripCode(markdown);
  const targets = [];
  // Image targets first, by the position of their `](`, so a badge nested in a
  // link (`[![alt](img)](href)`) yields both the image and the link target.
  const imageAt = new Set();
  for (const m of text.matchAll(/!\[[^\]]*\]\(/g)) imageAt.add(m.index + m[0].length - 2);
  for (const m of text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    targets.push({ url: m[1], image: imageAt.has(m.index) });
  }
  for (const m of text.matchAll(/<(img|a)\b[^>]*?\b(src|href)\s*=\s*"([^"]*)"/gi)) {
    targets.push({ url: m[3], image: m[1].toLowerCase() === 'img' });
  }
  return targets;
};

/**
 * GitHub-style heading slug.
 * @param {string} heading
 * @returns {string}
 */
const slug = (heading) =>
  heading
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s/g, '-');

const readme = readFileSync(path.join(root, 'README.md'), 'utf8');

test('readme: collectTargets finds Markdown, nested badge and HTML targets', () => {
  const sample = [
    '[![b](https://img.example/b.svg)](./LICENSE)',
    '![a](pics/a.png) [x](#top)',
    '<img src="docs/x.png" alt="" />',
    '```md\n[ignored](./ignored.md)\n```',
    '`[ignored](./inline.md)`',
  ].join('\n');
  assert.deepEqual(
    collectTargets(sample).map((t) => t.url),
    ['https://img.example/b.svg', './LICENSE', 'pics/a.png', '#top', 'docs/x.png']
  );
});

test('readme: every link and image is an absolute https URL or an in-page anchor', () => {
  const targets = collectTargets(readme);
  assert.ok(targets.length > 20, 'expected the README to have links');
  const bad = targets.filter(({ url, image }) =>
    image ? !url.startsWith('https://') : !/^https?:\/\//.test(url) && !url.startsWith('#')
  );
  assert.deepEqual(bad, [], 'relative links break on the Strapi marketplace and npm');
});

test('readme: in-page anchors resolve to a heading', () => {
  const anchors = new Set([...stripCode(readme).matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1])));
  for (const { url } of collectTargets(readme).filter((t) => t.url.startsWith('#'))) {
    assert.ok(anchors.has(url.slice(1)), `missing README anchor ${url}`);
  }
});

test('readme: images come from the GitHub Pages site, exist there and stay few', () => {
  const images = collectTargets(readme).filter((t) => t.image && !t.url.startsWith('https://img.shields.io/'));
  assert.ok(images.length >= 3, 'expected a hero and screenshots');
  assert.ok(
    images.length <= MAX_README_IMAGES,
    `README shows ${images.length} images; keep at most ${MAX_README_IMAGES} and link the gallery`
  );
  for (const { url } of images) {
    assert.ok(url.startsWith(PAGES_IMG), `README image not served from Pages: ${url}`);
    const file = path.join(root, 'docs/site/img', url.slice(PAGES_IMG.length));
    assert.ok(existsSync(file), `README image missing from docs/site/img: ${url}`);
  }
});

test('readme: links into this repository point at files that exist', () => {
  for (const { url } of collectTargets(readme)) {
    const m = url.match(/^https:\/\/github\.com\/Schero94\/Magic-MessageGate\/(?:blob|tree)\/main\/([^#?]+)/);
    if (!m) continue;
    assert.ok(url.startsWith(REPO));
    assert.ok(existsSync(path.join(root, decodeURIComponent(m[1]))), `README links to missing ${m[1]}`);
  }
});

test('readme: every table has a delimiter row after its header', () => {
  const lines = stripCode(readme).split('\n');
  const isRow = (line) => /^\s*\|.*\|\s*$/.test(line);
  const isDelimiter = (line) => /^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(line);
  for (let i = 0; i < lines.length; i += 1) {
    if (!isRow(lines[i]) || (i > 0 && isRow(lines[i - 1]))) continue;
    assert.ok(
      isDelimiter(lines[i + 1] ?? ''),
      `table at README line ${i + 1} has no delimiter row and renders as plain text`
    );
  }
});
