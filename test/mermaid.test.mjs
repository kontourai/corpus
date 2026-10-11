import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { commitAll, fixtureRepo, runCli, scratch } from './helpers.mjs';

// Pinned literally so a silent change to the template's pin fails here.
const MERMAID_TAG =
  '<script src="https://cdn.jsdelivr.net/npm/mermaid@12.1.0/dist/mermaid.min.js" integrity="sha384-EbBpjO7rlR6eqZEcG7GaPpyk9H9WrMyPWX4d3KvPYltgt8Z8l0z6R56B1qP40pR4" crossorigin="anonymous"></script>';

const DIAGRAM = '```mermaid\ngraph TD\n  A[<b>Start</b>] --> B & C\n```\n';

async function buildWith(t, edits) {
  const repo = fixtureRepo(t, 'valid');
  for (const [file, append] of Object.entries(edits)) {
    const target = path.join(repo, file);
    writeFileSync(target, `${readFileSync(target, 'utf8')}\n${append}`);
  }
  commitAll(repo, 'mermaid edits');
  const out = path.join(scratch(t), 'site');
  const build = await runCli(['build', '--root', repo, '--out', out]);
  assert.equal(build.status, 0, build.output);
  return { repo, read: (file) => readFileSync(path.join(out, file), 'utf8') };
}

test('a page with a mermaid fence renders <pre class="mermaid"> and loads the pinned, SRI-checked Mermaid', async (t) => {
  const { repo, read } = await buildWith(t, { 'docs/concepts.md': DIAGRAM });
  const html = read('docs/concepts.html');
  assert.ok(html.includes('<pre class="mermaid">graph TD\n  A[&lt;b&gt;Start&lt;/b&gt;] --&gt; B &amp; C</pre>'), 'diagram source is escaped text, not a code block');
  assert.doesNotMatch(html, /language-mermaid/);
  assert.equal(html.split(MERMAID_TAG).length - 1, 1, 'exactly one pinned Mermaid script with integrity and crossorigin');
  assert.match(html, /<script>mermaid\.initialize\(\{ startOnLoad: true, securityLevel: 'strict', theme: window\.matchMedia\('\(prefers-color-scheme: dark\)'\)\.matches \? 'dark' : 'default' \}\);<\/script>/);

  // The bundle keeps the Markdown as written.
  const bundle = JSON.parse(read('docs-bundle.json'));
  const concepts = bundle.documents.find((document) => document.source === 'docs/concepts.md');
  assert.equal(concepts.markdown, readFileSync(path.join(repo, 'docs', 'concepts.md'), 'utf8'));
  assert.ok(concepts.markdown.includes(DIAGRAM));
});

test('pages without a mermaid fence load no script, and other fences stay code', async (t) => {
  const { read } = await buildWith(t, { 'docs/concepts.md': DIAGRAM, 'docs/getting-started.md': '```js\nconst mermaid = 1;\n```\n' });
  for (const page of ['index.html', 'docs/getting-started.html', 'docs/reference/cli.html']) {
    const html = read(page);
    assert.doesNotMatch(html, /<script/, `${page} has no script`);
    assert.doesNotMatch(html, /class="mermaid"|jsdelivr/, `${page} does not reference Mermaid`);
  }
  assert.match(read('docs/getting-started.html'), /<pre><code class="language-js">const mermaid = 1;/);
});

test('a <script> written in Markdown is still stripped, on mermaid pages and elsewhere', async (t) => {
  const hostile = `<script>alert('pwned')</script>\n\n${MERMAID_TAG}\n\n<script>mermaid.initialize({ securityLevel: 'loose' })</script>\n`;
  const { read } = await buildWith(t, { 'docs/concepts.md': `${DIAGRAM}\n${hostile}`, 'docs/getting-started.md': hostile });
  const withDiagram = read('docs/concepts.html');
  assert.doesNotMatch(withDiagram, /pwned|loose/);
  assert.equal(withDiagram.match(/<script/g).length, 2, 'only the template\'s two scripts');
  assert.equal(withDiagram.split(MERMAID_TAG).length - 1, 1, 'the Markdown copy of the Mermaid tag was stripped');
  const article = withDiagram.match(/<article class="doc">[\s\S]*?<\/article>/)[0];
  assert.doesNotMatch(article, /<script/i, 'no script inside the document content');

  const without = read('docs/getting-started.html');
  assert.doesNotMatch(without, /<script|pwned|loose|jsdelivr/i);
});
