import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { BIN, commitAll, fixtureRepo, git, runCli, scratch } from './helpers.mjs';

const SITE = 'https://kontourai.github.io/sample/';

function editManifest(repo, edit) {
  const file = path.join(repo, 'docs-kit.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  edit(manifest);
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function build(t, repo) {
  const out = path.join(scratch(t), 'site');
  const result = await runCli(['build', '--root', repo, '--out', out]);
  return { result, out, read: (file) => readFileSync(path.join(out, file), 'utf8') };
}

test('publish: false puts a document in the bundle with a blob URL and absolute links, but renders no page', async (t) => {
  const repo = fixtureRepo(t, 'bundle-only');
  const sha = git(repo, ['rev-parse', 'HEAD']);
  const blob = (file) => `https://github.com/kontourai/sample/blob/${sha}/${file}`;

  const check = await runCli(['check', '--root', repo]);
  assert.equal(check.status, 0, check.output);
  for (const gate of ['links', 'reachability', 'topics', 'paths', 'covers']) assert.match(check.stdout, new RegExp(`PASS ${gate}`));

  const { result, out, read } = await build(t, repo);
  assert.equal(result.status, 0, result.output);
  assert.match(result.stdout, /2 pages/);
  assert.equal(existsSync(path.join(out, 'docs/manual.html')), false, 'no page for a bundle-only document');
  const marker = JSON.parse(read('.docs-kit-build'));
  assert.deepEqual(marker.files.filter((file) => file.endsWith('.html')).sort(), ['docs/guide.html', 'index.html']);

  // Navigation and landing cards list only pages.
  const index = read('index.html');
  assert.doesNotMatch(index, /manual\.html|Agent manual</);
  assert.doesNotMatch(index, /<h3>Agents<\/h3>/);

  const bundle = JSON.parse(read('docs-bundle.json'));
  assert.deepEqual(bundle.documents.map((document) => document.source), ['README.md', 'docs/guide.md', 'docs/manual.md']);
  const manual = bundle.documents.find((document) => document.source === 'docs/manual.md');
  assert.equal(manual.url, blob('docs/manual.md'));
  assert.equal(manual.section, 'Agents');
  assert.equal(manual.title, 'Agent manual');
  const md = manual.markdown;
  assert.match(md, new RegExp(`\\[usage guide\\]\\(${SITE}docs/guide\\.html#usage\\)`), 'published target -> page URL');
  assert.match(md, new RegExp(`\\[home\\]\\(${SITE}index\\.html\\)`), 'landing -> index.html');
  assert.ok(md.includes(`[the script](${blob('scripts/run.sh')})`), 'unpublished file -> blob URL');
  assert.ok(md.includes(`[all scripts](https://github.com/kontourai/sample/tree/${sha}/scripts)`), 'directory -> tree URL');
  assert.ok(md.includes(`[notes](${blob('docs/manual.md')}#notes)`), 'own fragment -> own blob URL');
  assert.ok(md.includes(`[ref]: ${SITE}docs/guide.html#usage "Usage"`), 'reference definition rewritten');
  assert.ok(md.includes(`<a href="${SITE}docs/guide.html">raw HTML</a>`), 'raw HTML href rewritten');
  assert.ok(md.includes('`[code](guide.md)`'), 'code spans are left as written');
  assert.ok(md.includes('cat [fenced](guide.md)'), 'fenced code is left as written');
  assert.ok(md.includes('[links](https://example.com/x)'), 'external links are left as written');

  // Published documents keep their Markdown as written.
  const guide = bundle.documents.find((document) => document.source === 'docs/guide.md');
  assert.equal(guide.url, `${SITE}docs/guide.html`);
  assert.match(guide.markdown, /\[agent manual\]\(manual\.md\)/);
});

test('publish: false: a topic may point into it and gets the blob URL and rewritten Markdown', async (t) => {
  const repo = fixtureRepo(t, 'bundle-only');
  const sha = git(repo, ['rev-parse', 'HEAD']);
  const { result, read } = await build(t, repo);
  assert.equal(result.status, 0, result.output);
  const topic = JSON.parse(read('docs-bundle.json')).topics.find((entry) => entry.id === 'manual-setup');
  assert.equal(topic.url, `https://github.com/kontourai/sample/blob/${sha}/docs/manual.md#setup`);
  assert.match(topic.markdown, /^## Setup\n/);
  assert.ok(topic.markdown.includes(`[usage guide](${SITE}docs/guide.html#usage)`), topic.markdown);
  assert.ok(topic.markdown.includes(`[notes](https://github.com/kontourai/sample/blob/${sha}/docs/manual.md#notes)`), topic.markdown);
  const prose = topic.markdown.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  assert.doesNotMatch(prose, /\]\((?!https:\/\/)/, 'no relative link survives outside code in the topic');
});

test('publish: false: mcp --repo serves the rewritten document and topic from a checkout', async (t) => {
  const repo = fixtureRepo(t, 'bundle-only', { as: 'sample' });
  const sha = git(repo, ['rev-parse', 'HEAD']);
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp', '--repo', repo], stderr: 'pipe' });
  const client = new Client({ name: 'docs-kit-test', version: '0.0.0' });
  await client.connect(transport);
  t.after(() => client.close());
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  const { document } = await call('get_document', { product: 'sample', source: 'docs/manual.md' });
  assert.equal(document.url, `https://github.com/kontourai/sample/blob/${sha}/docs/manual.md`);
  assert.ok(document.markdown.includes(`[the script](https://github.com/kontourai/sample/blob/${sha}/scripts/run.sh)`), document.markdown);
  const { topic } = await call('get_topic', { product: 'sample', id: 'manual-setup' });
  assert.ok(topic.markdown.includes(`[usage guide](${SITE}docs/guide.html#usage)`), topic.markdown);
});

test('publish: false: published pages link to it on GitHub, like any unpublished repo file', async (t) => {
  const repo = fixtureRepo(t, 'bundle-only');
  const sha = git(repo, ['rev-parse', 'HEAD']);
  const { result, read } = await build(t, repo);
  assert.equal(result.status, 0, result.output);
  assert.match(read('docs/guide.html'), new RegExp(`<a href="https://github.com/kontourai/sample/blob/${sha}/docs/manual\\.md">agent manual</a>`));
  assert.match(read('index.html'), new RegExp(`<a href="https://github.com/kontourai/sample/blob/${sha}/docs/manual\\.md#setup">manual setup</a>`));
});

test('publish: false: the digest identifies content, not publication or links (same digest as publish: true)', async (t) => {
  const bundleOnly = fixtureRepo(t, 'bundle-only');
  const published = fixtureRepo(t, 'bundle-only');
  editManifest(published, (manifest) => delete manifest.documents[1].publish);
  commitAll(published, 'publish the manual');
  const a = JSON.parse((await build(t, bundleOnly)).read('docs-bundle.json'));
  const b = JSON.parse((await build(t, published)).read('docs-bundle.json'));
  assert.notEqual(a.documents[2].markdown, b.documents[2].markdown);
  assert.equal(a.digest, b.digest);
});

test('publish: false: a redirect to it is refused by the redirects gate (exit 1)', async (t) => {
  const repo = fixtureRepo(t, 'bundle-only');
  editManifest(repo, (manifest) => {
    manifest.redirects = { 'manual.html': 'docs/manual.md#setup', 'ok.html': 'docs/guide.md' };
  });
  const result = await runCli(['check', '--root', repo]);
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /FAIL redirects/);
  assert.match(result.stderr, /redirects\["manual\.html"\]: target "docs\/manual\.md" is bundle-only \(publish: false\) and has no page/);
  assert.doesNotMatch(result.stderr, /ok\.html/);
});

test('publish: false: links, topics, and covers gates still apply to it (exit 1)', async (t) => {
  const repo = fixtureRepo(t, 'bundle-only');
  appendFileSync(path.join(repo, 'docs/manual.md'), '\nA [broken link](missing.md) and a [bad anchor](guide.md#nowhere).\n');
  editManifest(repo, (manifest) => {
    manifest.topics.push({ id: 'ghost', title: 'Ghost', source: 'docs/manual.md#ghost' });
    manifest.documents[1].covers = ['tools/**'];
  });
  const result = await runCli(['check', '--root', repo]);
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /docs\/manual\.md:\d+: \[broken link\]\(missing\.md\) - missing target docs\/missing\.md/);
  assert.match(result.stderr, /\[bad anchor\]\(guide\.md#nowhere\) - missing anchor #nowhere in docs\/guide\.md/);
  assert.match(result.stderr, /topic "ghost": #ghost does not match a heading in docs\/manual\.md/);
  assert.match(result.stderr, /docs\/manual\.md: covers "tools\/\*\*" matches no tracked file/);
});

test('publish must be a boolean (exit 2)', async (t) => {
  const repo = fixtureRepo(t, 'bundle-only');
  editManifest(repo, (manifest) => {
    manifest.documents[1].publish = 'no';
  });
  const result = await runCli(['check', '--root', repo]);
  assert.equal(result.status, 2, result.output);
  assert.match(result.stderr, /documents\[1\]\.publish must be a boolean \(got "no"\)/);
});
