import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { commitAll, fixtureRepo, runCli, scratch } from './helpers.mjs';

function editManifest(repo, edit) {
  const file = path.join(repo, 'corpus.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  edit(manifest);
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function build(t, repo, { commit = true } = {}) {
  if (commit) commitAll(repo, 'title edits');
  const out = path.join(scratch(t), 'site');
  const result = await runCli(['build', '--root', repo, '--out', out]);
  assert.equal(result.status, 0, result.output);
  const read = (file) => readFileSync(path.join(out, file), 'utf8');
  return { read, bundle: JSON.parse(read('docs-bundle.json')) };
}

const titleOf = (html) => html.match(/<title>([^<]*)<\/title>/)[1];
const bundleTitle = (bundle, source) => bundle.documents.find((document) => document.source === source).title;

test('a documents[].title overrides the H1 title in nav, <title>, landing cards, and the bundle', async (t) => {
  const repo = fixtureRepo(t, 'valid');
  editManifest(repo, (manifest) => {
    manifest.documents[1].title = 'Core ideas';
  });
  const check = await runCli(['check', '--root', repo]);
  assert.equal(check.status, 0, check.output);
  const { read, bundle } = await build(t, repo);
  const page = read('docs/concepts.html');
  assert.equal(titleOf(page), 'Core ideas · Sample');
  assert.match(page, /<a href="concepts\.html" aria-current="page">Core ideas<\/a>/);
  assert.match(page, /<h1 id="concepts" data-src-line="1-1">Concepts/, 'the page body keeps its own H1');
  assert.match(read('index.html'), /<a class="card" href="docs\/concepts\.html"><strong>Core ideas<\/strong>/);
  assert.equal(bundleTitle(bundle, 'docs/concepts.md'), 'Core ideas');
  assert.equal(bundleTitle(bundle, 'docs/getting-started.md'), 'Getting started', 'documents without an override keep the H1');
});

test('documents[].title must be a non-empty string (exit 2)', async (t) => {
  for (const [value, message] of [
    ['', /documents\[1\]\.title must be a non-empty string/],
    ['   ', /documents\[1\]\.title must be a non-empty string/],
    [42, /documents\[1\]\.title must be a non-empty string/],
    [null, /documents\[1\]\.title must be a non-empty string/],
    [' Padded', /documents\[1\]\.title must not have leading or trailing whitespace/],
  ]) {
    const repo = fixtureRepo(t, 'valid');
    editManifest(repo, (manifest) => {
      manifest.documents[1].title = value;
    });
    const result = await runCli(['check', '--root', repo]);
    assert.equal(result.status, 2, `${JSON.stringify(value)}: ${result.output}`);
    assert.match(result.stderr, message);
  }
});

test('without a Markdown H1 the title is the first raw-HTML <h1> text, then the file name', async (t) => {
  const repo = fixtureRepo(t, 'valid');
  const docs = path.join(repo, 'docs');
  writeFileSync(
    path.join(docs, 'raw.md'),
    '<p align="center"><img src="assets/diagram.svg" alt="logo"></p>\n\n<h1><img src="assets/diagram.svg" alt="only an image"></h1>\n\n<h1 align="center">\n  Raw &amp; <em>ready</em>\n</h1>\n\nBody text.\n\n## Details\n',
  );
  writeFileSync(path.join(docs, 'both.md'), '<h1>HTML first</h1>\n\n# Markdown wins\n\nText.\n');
  writeFileSync(path.join(docs, 'untitled.md'), 'No heading at all.\n\n> <h1>Quoted</h1>\n');
  editManifest(repo, (manifest) => {
    manifest.documents.push(
      { source: 'docs/raw.md', section: 'Reference' },
      { source: 'docs/both.md', section: 'Reference' },
      { source: 'docs/untitled.md', section: 'Reference' },
    );
  });
  const { read, bundle } = await build(t, repo);
  assert.equal(bundleTitle(bundle, 'docs/raw.md'), 'Raw & ready');
  assert.equal(titleOf(read('docs/raw.html')), 'Raw &amp; ready · Sample');
  assert.match(read('docs/raw.html'), /<a href="raw\.html" aria-current="page">Raw &amp; ready<\/a>/);
  assert.equal(bundleTitle(bundle, 'docs/both.md'), 'Markdown wins');
  assert.equal(bundleTitle(bundle, 'docs/untitled.md'), 'untitled', 'an <h1> inside a blockquote is not a title');
});

test('landing <title> is "<title> — <tagline>" with a tagline, else "<title> documentation"', async (t) => {
  const withTagline = await build(t, fixtureRepo(t, 'valid'), { commit: false });
  assert.equal(titleOf(withTagline.read('index.html')), 'Sample — A fixture product for docs-kit tests');
  assert.equal(titleOf(withTagline.read('docs/concepts.html')), 'Concepts · Sample', 'document pages are unchanged');

  for (const edit of [(manifest) => delete manifest.tagline, (manifest) => (manifest.tagline = '')]) {
    const repo = fixtureRepo(t, 'valid');
    editManifest(repo, edit);
    const { read } = await build(t, repo);
    assert.equal(titleOf(read('index.html')), 'Sample documentation');
  }
});
