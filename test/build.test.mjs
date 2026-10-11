import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixtureRepo, git, runCli, scratch } from './helpers.mjs';

async function buildValid(t, extraArgs = []) {
  const repo = fixtureRepo(t, 'valid', { as: 'sample' });
  const out = path.join(scratch(t), 'site');
  const result = await runCli(['build', '--root', repo, '--out', out, ...extraArgs]);
  assert.equal(result.status, 0, result.output);
  const sha = git(repo, ['rev-parse', 'HEAD']);
  const read = (file) => readFileSync(path.join(out, file), 'utf8');
  return { repo, out, sha, read, result };
}

test('build renders the landing page, one page per document, assets and .nojekyll', async (t) => {
  const { out, read } = await buildValid(t);
  for (const file of ['index.html', 'docs/getting-started.html', 'docs/concepts.html', 'docs/reference/cli.html', 'docs-kit.css', '.nojekyll', 'docs/assets/diagram.svg', 'docs-bundle.json'])
    assert.ok(existsSync(path.join(out, file)), `${file} is generated`);
  assert.ok(!existsSync(path.join(out, 'docs/plans/roadmap.html')), 'excluded docs are not published');

  const index = read('index.html');
  assert.match(index, /<h1 id="sample">Sample/);
  assert.match(index, /href="https:\/\/kontourai\.github\.io\/">All Kontour docs</, 'links back to the hub');
  assert.match(index, /href="https:\/\/github\.com\/kontourai\/sample">GitHub</, 'links to the repo');
  assert.match(index, /<img src="docs\/assets\/diagram\.svg" alt="Architecture"/);

  const nav = read('docs/concepts.html').match(/<nav class="site-nav"[\s\S]*?<\/nav>/)[0];
  const order = [...nav.matchAll(/<h2>([^<]+)<\/h2>/g)].map((match) => match[1]);
  assert.deepEqual(order, ['Overview', 'Start Here', 'Understand Sample', 'Reference'], 'sections in manifest order');
  assert.match(nav, /<a href="concepts\.html" aria-current="page">Concepts<\/a>/);
  assert.match(nav, /<a href="reference\/cli\.html">CLI reference<\/a>/);
});

test('build rewrites links between published docs and sends unpublished files to GitHub at the sha', async (t) => {
  const { read, sha } = await buildValid(t);
  const gettingStarted = read('docs/getting-started.html');
  assert.match(gettingStarted, /<a href="reference\/cli\.html#sample-run">CLI reference<\/a>/);
  assert.match(gettingStarted, /<a href="concepts\.html#workflows">workflows<\/a>/);
  assert.match(gettingStarted, /<a href="\.\.\/index\.html">overview<\/a>/, 'a link to the landing page goes to index.html');
  assert.match(gettingStarted, /<a href="#run-it-1">jump<\/a>/);
  assert.match(gettingStarted, /<h2 id="run-it-1">/);

  const cli = read('docs/reference/cli.html');
  assert.ok(cli.includes(`<a href="https://github.com/kontourai/sample/blob/${sha}/src/cli/main.js">main source</a>`), 'repo file -> blob');
  assert.ok(cli.includes(`<a href="https://github.com/kontourai/sample/blob/${sha}/docs/plans/roadmap.md">roadmap</a>`), 'excluded doc -> blob');

  const index = read('index.html');
  assert.ok(index.includes(`<a href="https://github.com/kontourai/sample/blob/${sha}/CONTRIBUTING.md">CONTRIBUTING</a>`));
  assert.ok(index.includes(`<a href="https://github.com/kontourai/sample/tree/${sha}/src/cli">source tree</a>`), 'directory -> tree');
  assert.match(index, /<a href="docs\/concepts\.html#workflows">concepts<\/a>/);
});

test('build writes docs-bundle.json with the contract fields', async (t) => {
  const { read, sha } = await buildValid(t);
  const bundle = JSON.parse(read('docs-bundle.json'));
  assert.deepEqual(Object.keys(bundle), ['schemaVersion', 'product', 'title', 'tagline', 'repo', 'sha', 'builtAt', 'siteUrl', 'digest', 'documents', 'topics']);
  assert.equal(bundle.schemaVersion, 1);
  assert.equal(bundle.product, 'sample');
  assert.equal(bundle.tagline, 'A fixture product for docs-kit tests');
  assert.equal(bundle.repo, 'kontourai/sample');
  assert.equal(bundle.sha, sha);
  assert.ok(!Number.isNaN(Date.parse(bundle.builtAt)) && bundle.builtAt.endsWith('Z'));
  assert.equal(bundle.siteUrl, 'https://kontourai.github.io/sample/');

  assert.deepEqual(
    bundle.documents.map(({ source, section, title, url }) => ({ source, section, title, url })),
    [
      { source: 'docs/getting-started.md', section: 'Start Here', title: 'Getting started', url: 'https://kontourai.github.io/sample/docs/getting-started.html' },
      { source: 'docs/concepts.md', section: 'Understand Sample', title: 'Concepts', url: 'https://kontourai.github.io/sample/docs/concepts.html' },
      { source: 'docs/reference/cli.md', section: 'Reference', title: 'CLI reference', url: 'https://kontourai.github.io/sample/docs/reference/cli.html' },
    ],
  );
  assert.equal(bundle.documents[1].markdown, readFileSync(path.join(import.meta.dirname, 'fixtures/valid/docs/concepts.md'), 'utf8'));

  const workflows = bundle.topics.find((topic) => topic.id === 'workflows');
  assert.equal(workflows.url, 'https://kontourai.github.io/sample/docs/concepts.html#workflows');
  assert.equal(workflows.markdown, '## Workflows\n\nA workflow is an ordered list of steps.\n\n### Steps\n\nEach step names its evidence.\n', 'section stops at the next same-level heading and keeps deeper ones');
  const install = bundle.topics.find((topic) => topic.id === 'install');
  assert.equal(install.url, 'https://kontourai.github.io/sample/index.html#install');
  assert.ok(install.markdown.startsWith('## Install\n') && !install.markdown.includes('# Sample'));
  const whole = bundle.topics.find((topic) => topic.id === 'getting-started');
  assert.equal(whole.markdown, bundle.documents[0].markdown, 'a topic without an anchor is the whole document');

  const canonical = JSON.stringify({
    documents: bundle.documents.map(({ source, section, title, markdown }) => ({ source, section, title, markdown })),
    topics: bundle.topics.map(({ id, title, source, markdown }) => ({ id, title, source, markdown })),
  });
  assert.equal(bundle.digest, createHash('sha256').update(canonical).digest('hex'));
});

test('build honors --base-url and keeps the digest independent of it', async (t) => {
  const first = await buildValid(t);
  const second = await buildValid(t, ['--base-url', 'https://docs.example.test/sample']);
  const a = JSON.parse(first.read('docs-bundle.json'));
  const b = JSON.parse(second.read('docs-bundle.json'));
  assert.equal(b.siteUrl, 'https://docs.example.test/sample/');
  assert.equal(b.documents[0].url, 'https://docs.example.test/sample/docs/getting-started.html');
  assert.equal(a.digest, b.digest);
});

test('build fails when the generated site would contain a broken link (exit 1)', async (t) => {
  const repo = fixtureRepo(t, 'broken-generated-link');
  const check = await runCli(['check', '--root', repo]);
  assert.equal(check.status, 0, 'the Markdown gates pass; only the generated site is broken');
  const out = path.join(scratch(t), 'site');
  const result = await runCli(['build', '--root', repo, '--out', out]);
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /generated site has 1 broken internal link/);
  assert.match(result.stderr, /docs\/a\.html: href="missing-page\.html" - missing generated target/);
});

test('build refuses to build when check fails', async (t) => {
  const repo = fixtureRepo(t, 'broken-link');
  const out = path.join(scratch(t), 'site');
  const result = await runCli(['build', '--root', repo, '--out', out]);
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /refusing to build until check passes/);
  assert.ok(!existsSync(path.join(out, 'index.html')));
});

test('build refuses an --out that would delete the sources', async (t) => {
  const repo = fixtureRepo(t, 'valid');
  for (const out of [repo, path.join(repo, 'docs')]) {
    const result = await runCli(['build', '--root', repo, '--out', out]);
    assert.equal(result.status, 2, result.output);
    assert.match(result.stderr, /refusing to delete it/);
  }
  assert.ok(existsSync(path.join(repo, 'docs', 'concepts.md')));
});

test('build rejects a non-http --base-url (exit 2)', async (t) => {
  const repo = fixtureRepo(t, 'valid');
  const result = await runCli(['build', '--root', repo, '--out', path.join(scratch(t), 'site'), '--base-url', 'ftp://example.test/']);
  assert.equal(result.status, 2, result.output);
  assert.match(result.stderr, /--base-url must be an http\(s\) URL/);
});

test('build neutralizes javascript: links', async (t) => {
  const repo = fixtureRepo(t, 'valid');
  writeFileSync(path.join(repo, 'docs', 'concepts.md'), `${readFileSync(path.join(repo, 'docs', 'concepts.md'), 'utf8')}\n[click](javascript:alert(1))\n`);
  const out = path.join(scratch(t), 'site');
  const result = await runCli(['build', '--root', repo, '--out', out]);
  assert.equal(result.status, 0, result.output);
  const html = readFileSync(path.join(out, 'docs/concepts.html'), 'utf8');
  assert.doesNotMatch(html, /javascript:/);
});
