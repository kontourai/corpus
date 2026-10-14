import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { commitAll, fixtureRepo, runCli, scratch } from './helpers.mjs';

/** The valid fixture plus extra documents under docs/, listed in the manifest. */
function repoWith(t, docs, { topics = [], titles = {} } = {}) {
  const repo = fixtureRepo(t, 'valid');
  for (const [name, content] of Object.entries(docs)) writeFileSync(path.join(repo, 'docs', name), content);
  const file = path.join(repo, 'corpus.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  for (const name of Object.keys(docs))
    manifest.documents.push({ source: `docs/${name}`, section: 'Reference', ...(titles[name] ? { title: titles[name] } : {}) });
  manifest.topics.push(...topics);
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  commitAll(repo, 'front matter docs');
  return repo;
}

async function build(t, repo) {
  const out = path.join(scratch(t), 'site');
  const result = await runCli(['build', '--root', repo, '--out', out]);
  assert.equal(result.status, 0, result.output);
  const read = (file) => readFileSync(path.join(out, file), 'utf8');
  const bundle = JSON.parse(read('docs-bundle.json'));
  return { read, bundle, doc: (source) => bundle.documents.find((document) => document.source === source) };
}

const FM = '---\ntitle: "Front: Title"\nlayout: page\npermalink: /fm/\n---\n';
const BODY = '\nIntro, see [the section](#section).\n\n## Section\n\nText.\n';

test('leading front matter is stripped from the page, links, anchors, topics, and the bundle markdown', async (t) => {
  const repo = repoWith(t, { 'fm.md': `${FM}${BODY}` }, { topics: [{ id: 'fm-section', title: 'FM section', source: 'docs/fm.md#section' }] });
  const check = await runCli(['check', '--root', repo]);
  assert.equal(check.status, 0, check.output);
  const { read, bundle, doc } = await build(t, repo);
  const page = read('docs/fm.html');
  const article = page.match(/<article class="doc">[\s\S]*?<\/article>/)[0];
  assert.doesNotMatch(article, /<hr|layout|permalink|Front: Title/, 'no front matter in the rendered body');
  assert.match(article, /<a href="#section">the section<\/a>/);
  assert.equal(doc('docs/fm.md').markdown, BODY, 'bundle markdown is the body after the front matter');
  assert.equal(bundle.topics.find((topic) => topic.id === 'fm-section').markdown, '## Section\n\nText.\n');
});

test('title order: manifest override, then H1, then front-matter title, then file name', async (t) => {
  const repo = repoWith(
    t,
    {
      'fm.md': `${FM}${BODY}`,
      'single.md': "---\ntitle: 'It''s single'   # a comment\n...\nBody.\n",
      'h1.md': `${FM}\n# Markdown H1\n`,
      'html.md': `${FM}\n<h1>HTML H1</h1>\n`,
      'override.md': `${FM}\n# Markdown H1\n`,
      'block.md': '---\ntitle: >\n  folded\n---\nBody.\n',
    },
    { titles: { 'override.md': 'From manifest' } },
  );
  const { read, doc } = await build(t, repo);
  assert.equal(doc('docs/fm.md').title, 'Front: Title');
  assert.equal(read('docs/fm.html').match(/<title>([^<]*)<\/title>/)[1], 'Front: Title · Sample');
  assert.match(read('docs/fm.html'), /<a href="fm\.html" aria-current="page">Front: Title<\/a>/);
  assert.equal(doc('docs/single.md').title, "It's single");
  assert.equal(doc('docs/h1.md').title, 'Markdown H1');
  assert.equal(doc('docs/html.md').title, 'HTML H1');
  assert.equal(doc('docs/override.md').title, 'From manifest');
  assert.equal(doc('docs/block.md').title, 'block', 'a non-simple title is ignored');
});

test('check failures report source-file line numbers after front matter is stripped', async (t) => {
  // Five front-matter lines, a blank line, then the broken links on lines 7 and 9.
  const repo = repoWith(t, { 'fm.md': `${FM}\nSee [gone](missing.md).\n\n<a href="also-missing.md">raw</a>\n` });
  const result = await runCli(['check', '--root', repo]);
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /docs\/fm\.md:7: \[gone\]\(missing\.md\) - missing target docs\/missing\.md/);
  assert.match(result.stderr, /docs\/fm\.md:9: .*also-missing\.md/);
});

test('an unclosed or too-long front-matter block is not stripped', async (t) => {
  const unclosed = '---\ntitle: Nope\n\n# Real title\n';
  const filler = Array.from({ length: 1997 }, (_, index) => `key${index}: v`).join('\n');
  // Closing line 2000 is within the limit; closing line 2001 is not.
  const at200 = `---\ntitle: At 2000\n${filler}\n---\nBody.\n`;
  const at201 = `---\ntitle: At 2001\n${filler}\nmore: v\n---\nBody.\n`;
  assert.equal(at200.split('\n').indexOf('---', 1) + 1, 2000);
  assert.equal(at201.split('\n').indexOf('---', 1) + 1, 2001);
  const repo = repoWith(t, { 'unclosed.md': unclosed, 'at200.md': at200, 'at201.md': at201 });
  const { read, doc } = await build(t, repo);
  assert.equal(doc('docs/unclosed.md').markdown, unclosed);
  assert.equal(doc('docs/unclosed.md').title, 'Real title');
  assert.match(read('docs/unclosed.html'), /<hr\b/);
  assert.equal(doc('docs/at200.md').markdown, 'Body.\n');
  assert.equal(doc('docs/at200.md').title, 'At 2000');
  assert.equal(doc('docs/at201.md').markdown, at201);
  assert.equal(doc('docs/at201.md').title, 'at201');
});

test('a leading thematic break and a later --- are content, not front matter, unless the block has a key line', async (t) => {
  const breaks = '---\nIntro.\n\n---\n\nMore prose.\n';
  // Indented `key:` lines and list items are not top-level keys.
  const prose = '---\n- item: one\n  nested: two\nSome *prose*: here\n---\n\n# Kept\n';
  const keyed = '---\n# a YAML comment\nlayout: page\n---\n\n# Stripped\n';
  const repo = repoWith(t, { 'breaks.md': breaks, 'prose.md': prose, 'keyed.md': keyed });
  const { read, doc } = await build(t, repo);
  assert.equal(doc('docs/breaks.md').markdown, breaks, 'nothing is deleted');
  assert.match(read('docs/breaks.html'), /<p data-src-line="2-2">Intro\.<\/p>[\s\S]*<p data-src-line="6-6">More prose\.<\/p>/);
  assert.equal(doc('docs/prose.md').markdown, prose, 'no column-0 key line, so nothing is stripped');
  assert.equal(doc('docs/keyed.md').markdown, '\n# Stripped\n');
});

test('a leading UTF-8 BOM does not block front-matter detection', async (t) => {
  const repo = repoWith(t, { 'bom.md': '\uFEFF---\ntitle: BOM title\n---\n\nSee [gone](missing.md).\n', 'bom-plain.md': '\uFEFF# Plain\n' });
  const check = await runCli(['check', '--root', repo]);
  assert.equal(check.status, 1, check.output);
  assert.match(check.stderr, /docs\/bom\.md:5: \[gone\]\(missing\.md\)/, 'line numbers still match the file');
  writeFileSync(path.join(repo, 'docs', 'bom.md'), '\uFEFF---\ntitle: BOM title\n---\n\nBody.\n');
  commitAll(repo, 'fix link');
  const { read, doc } = await build(t, repo);
  assert.equal(doc('docs/bom.md').markdown, '\nBody.\n');
  assert.equal(doc('docs/bom.md').title, 'BOM title');
  assert.doesNotMatch(read('docs/bom.html').match(/<article class="doc">[\s\S]*?<\/article>/)[0], /<hr|title:/);
  assert.equal(doc('docs/bom-plain.md').title, 'Plain', 'a BOM is dropped without front matter too, so the first line is a heading');
});
