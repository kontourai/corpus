import assert from 'node:assert/strict';
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { BIN, REPO_ROOT, commitAll, fixtureRepo, git, runCli, scratch } from './helpers.mjs';

async function buildSelection(t, { edit } = {}) {
  const repo = fixtureRepo(t, 'selection', { as: 'sample' });
  if (edit) {
    edit(repo);
    commitAll(repo, 'edit');
  }
  const out = path.join(scratch(t), 'site');
  const result = await runCli(['build', '--root', repo, '--out', out]);
  assert.equal(result.status, 0, result.output);
  return { repo, out, sha: git(repo, ['rev-parse', 'HEAD']), read: (file) => readFileSync(path.join(out, file), 'utf8') };
}

/** [line attribute, the start of the element's text] for every annotated element, in page order. */
function annotated(html) {
  return [...html.matchAll(/<([a-z0-9]+)[^>]*\sdata-src-line="([^"]*)"[^>]*>([\s\S]*?)<\/\1>/g)].map(([, tag, line, inner]) => [
    tag,
    line,
    inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 24),
  ]);
}

test('build annotates top-level blocks, list items, and table rows with source-file lines, after front matter', async (t) => {
  const { read } = await buildSelection(t);
  // Line numbers counted by hand from test/fixtures/selection/docs/guide.md,
  // whose four-line front matter is stripped before rendering.
  assert.deepEqual(annotated(read('docs/guide.html')), [
    ['h1', '6-6', 'Guide#'],
    ['p', '8-9', 'The guide explains how S'],
    ['h2', '11-11', 'Setup#'],
    ['li', '13-13', 'Install the CLI with npm'],
    ['li', '14-15', 'Run sample init in your '],
    ['li', '16-16', 'Commit the config.'],
    ['li', '18-18', 'First numbered step.'],
    ['li', '19-19', 'Second numbered step.'],
    ['tr', '21-21', 'Option Meaning'],
    ['tr', '23-23', '--fast Skip the slow che'],
    ['tr', '24-24', '--dry-run Print what wou'],
    ['pre', '26-29', 'sample run --fast sample'],
    ['blockquote', '31-32', 'A gate holds until the e'],
    ['h2', '34-34', 'Hostile text#'],
    ['p', '36-36', 'The literal text &lt;img'],
    ['h2', '42-42', 'Long passage#'],
    ['p', '44-44', 'Long start: evidence sou'],
  ]);
  const source = readFileSync(path.join(REPO_ROOT, 'test/fixtures/selection/docs/guide.md'), 'utf8').split('\n');
  assert.equal(source[8 - 1], 'The guide explains how **Sample** runs a `workflow` end to end,', 'the fixture line the test counted');
  assert.equal(source[31 - 1], '> A gate holds until the evidence arrives.');
});

test('line ranges follow the file for CRLF line endings and for a document without front matter', async (t) => {
  const { read } = await buildSelection(t, {
    edit: (repo) => writeFileSync(path.join(repo, 'docs', 'twins.md'), '# Twins\r\n\r\nOne\r\ntwo.\r\n\r\n- a\r\n- b\r\n'),
  });
  assert.deepEqual(annotated(read('docs/twins.html')), [
    ['h1', '1-1', 'Twins#'],
    ['p', '3-4', 'One two.'],
    ['li', '6-6', 'a'],
    ['li', '7-7', 'b'],
  ]);
});

test('<main> carries the page provenance once; raw HTML cannot set data-src-line or other data-* attributes', async (t) => {
  const { read, sha } = await buildSelection(t);
  const html = read('docs/guide.html');
  const main = html.match(/<main [^>]*>/)[0];
  assert.equal(
    main,
    `<main id="main" class="content" data-src-path="docs/guide.md" data-src-sha="${sha}" data-repo="kontourai/sample" data-product="sample" data-title="Sample" data-branch="trunk" data-selection-primary="ask">`,
  );
  assert.equal((html.match(/data-src-path=/g) ?? []).length, 1);
  assert.match(html, /<p>Raw HTML paragraph with spoofed attributes\.<\/p>/, 'the author-written data-src-line and data-foo are removed');
  assert.doesNotMatch(html, /999-999|data-foo/);
  assert.match(read('index.html'), /<main [^>]*data-src-path="README\.md"/);
});

test('every page loads the toolbar script and CSS from the template, and document content never carries them', async (t) => {
  const { out, read } = await buildSelection(t);
  const pages = readdirSync(out, { recursive: true }).filter((file) => file.endsWith('.html'));
  assert.deepEqual(pages.sort(), ['docs/guide.html', 'docs/twins.html', 'index.html']);
  for (const page of pages) {
    const html = read(page);
    const head = html.slice(0, html.indexOf('</head>'));
    const toRoot = '../'.repeat(page.split('/').length - 1);
    assert.equal((html.match(/<script\b/g) ?? []).length, 1, `${page}: only the toolbar script`);
    assert.ok(head.includes(`<script src="${toRoot}docs-kit.js" defer></script>`), `${page}: toolbar script in <head>`);
    assert.ok(head.includes(`<link rel="stylesheet" href="${toRoot}docs-kit.css">`));
    const article = html.match(/<article class="doc">[\s\S]*?<\/article>/)[0];
    assert.doesNotMatch(article, /<script|docs-kit\.js|dk-toolbar|__pwned/i, `${page}: content has no script`);
  }
  assert.equal(read('docs-kit.js'), readFileSync(path.join(REPO_ROOT, 'src/site-client.js'), 'utf8'));
  const css = read('docs-kit.css');
  for (const rule of ['.dk-toolbar {', '.dk-toast {', '.dk-dialog {', '@media (prefers-reduced-motion: reduce)', '@media (pointer: coarse)', '@media (prefers-color-scheme: dark)'])
    assert.ok(css.includes(rule), `docs-kit.css has ${rule}`);
  const marker = JSON.parse(read('.docs-kit-build'));
  assert.ok(marker.files.includes('docs-kit.js'), 'the toolbar script is a generated file');
});

test('the sanitizer still strips scripts and event handlers from content', async (t) => {
  const { read } = await buildSelection(t, {
    edit: (repo) =>
      writeFileSync(
        path.join(repo, 'docs', 'twins.md'),
        '# Twins\n\n<script>window.pwned = 1</script>\n\n<p onclick="x()" data-src-line="77-77">click</p>\n\n<img src="https://example.com/x.png" onerror="alert(1)" alt="i">\n',
      ),
  });
  const html = read('docs/twins.html');
  const article = html.match(/<article class="doc">[\s\S]*?<\/article>/)[0];
  assert.doesNotMatch(article, /<script|pwned|onclick|onerror|77-77/);
  assert.match(article, /<p>click<\/p>/);
});

test('branch and selectionActions are validated strictly (exit 2) and default to main and ask', async (t) => {
  const cases = [
    [{ branch: 'has space' }, /branch "has space" must not contain whitespace/],
    [{ branch: '../x' }, /branch "\.\.\/x" must not contain "\.\."/],
    [{ branch: 7 }, /branch must be a non-empty string/],
    [{ branch: 'x.lock' }, /must not have a component that starts with "\." or ends with "\.lock"/],
    [{ selectionActions: { primary: 'edit' } }, /selectionActions\.primary must be one of "ask", "challenge-issue" \(got "edit"\)/],
    [{ selectionActions: { primary: 'ask', extra: true } }, /selectionActions: unknown key "extra" \(allowed: primary\)/],
    [{ selectionActions: {} }, /selectionActions: missing required key "primary"/],
    [{ selectionActions: 'ask' }, /selectionActions must be an object/],
  ];
  for (const [patch, message] of cases) {
    const repo = fixtureRepo(t, 'selection');
    const file = path.join(repo, 'corpus.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ...patch }));
    const result = await runCli(['check', '--root', repo]);
    assert.equal(result.status, 2, `${JSON.stringify(patch)}: ${result.output}`);
    assert.match(result.stderr, message);
  }

  const { read } = await buildSelection(t, {
    edit: (repo) => {
      const file = path.join(repo, 'corpus.json');
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      delete manifest.branch;
      writeFileSync(file, JSON.stringify(manifest));
    },
  });
  assert.match(read('index.html'), /data-branch="main" data-selection-primary="ask">/);
  const challenge = await buildSelection(t, {
    edit: (repo) => {
      const file = path.join(repo, 'corpus.json');
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), branch: 'release/1.x', selectionActions: { primary: 'challenge-issue' } }));
    },
  });
  assert.match(challenge.read('index.html'), /data-branch="release\/1\.x" data-selection-primary="challenge-issue">/);
});

test('the bundle records each document repoPath and its front-matter lineOffset', async (t) => {
  const { read } = await buildSelection(t);
  const bundle = JSON.parse(read('docs-bundle.json'));
  assert.deepEqual(
    bundle.documents.map(({ source, repoPath, lineOffset }) => [source, repoPath, lineOffset]),
    [
      ['README.md', 'README.md', 0],
      ['docs/guide.md', 'docs/guide.md', 4],
      ['docs/twins.md', 'docs/twins.md', 0],
    ],
  );
});

async function connect(t, args) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp', ...args], stderr: 'pipe' });
  const client = new Client({ name: 'docs-kit-test', version: '0.0.0' });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

async function locate(client, args) {
  const result = await client.callTool({ name: 'locate', arguments: args });
  return { isError: Boolean(result.isError), data: JSON.parse(result.content[0].text) };
}

test('mcp locate finds an exact quote with file lines, heading, anchor, context, and blob URL', async (t) => {
  const repo = fixtureRepo(t, 'selection', { as: 'sample' });
  const sha = git(repo, ['rev-parse', 'HEAD']);
  const client = await connect(t, ['--repo', repo]);
  const { isError, data } = await locate(client, { product: 'sample', quote: 'A gate holds until the evidence arrives.' });
  assert.equal(isError, false, JSON.stringify(data));
  assert.deepEqual(data, {
    product: 'sample',
    sha,
    confidence: 1,
    source: 'docs/guide.md',
    repoPath: 'docs/guide.md',
    startLine: 31,
    endLine: 31,
    heading: 'Setup',
    anchor: 'setup',
    url: 'https://kontourai.github.io/sample/docs/guide.html#setup',
    blobUrl: `https://github.com/kontourai/sample/blob/${sha}/docs/guide.md#L31-L31`,
    markdown: '> A gate holds until the evidence arrives.\n> It never times out on its own.\n',
    match: 'verbatim',
  });
});

test('mcp locate tolerates whitespace, Markdown formatting, and punctuation differences', async (t) => {
  const repo = fixtureRepo(t, 'selection', { as: 'sample' });
  const client = await connect(t, ['--repo', repo]);
  const cases = [
    // Rendered text of a paragraph: bold and code marks gone, line break collapsed.
    ['The guide explains how Sample runs a workflow end to end, and why each step records its evidence.', 'docs/guide.md', 8, 9, 'Guide'],
    // A selection across list items: the rendered text has no bullets.
    ['Run sample init in your repository.\nThe command writes a starter config.\nCommit the config.', 'docs/guide.md', 14, 16, 'Setup'],
    // A table row as the browser copies it (tab separated).
    ['--dry-run\tPrint what would change.', 'docs/guide.md', 24, 24, 'Setup'],
    // Curly punctuation and a dash instead of a line break.
    ['A gate holds until the evidence arrives — it never times out on its own', 'docs/guide.md', 31, 32, 'Setup'],
    // Ordered-list numbers are not part of a rendered selection.
    ['First numbered step. Second numbered step.', 'docs/guide.md', 18, 19, 'Setup'],
  ];
  for (const [quote, source, startLine, endLine, heading] of cases) {
    const { isError, data } = await locate(client, { product: 'sample', quote });
    assert.equal(isError, false, `${quote}: ${JSON.stringify(data)}`);
    assert.deepEqual([data.source, data.startLine, data.endLine, data.heading], [source, startLine, endLine, heading], quote);
    assert.equal(data.match, 'normalized', quote);
    assert.equal(data.confidence, 0.9, quote);
    assert.equal(data.ambiguous, undefined);
  }
});

test('mcp locate reports an ambiguous quote with lower confidence and the alternatives', async (t) => {
  const repo = fixtureRepo(t, 'selection', { as: 'sample' });
  const sha = git(repo, ['rev-parse', 'HEAD']);
  const client = await connect(t, ['--repo', repo]);
  const { isError, data } = await locate(client, { product: 'sample', quote: 'The same sentence appears twice in this document.' });
  assert.equal(isError, false, JSON.stringify(data));
  assert.equal(data.ambiguous, true);
  assert.equal(data.confidence, 0.5);
  assert.deepEqual([data.source, data.startLine, data.heading, data.anchor], ['docs/twins.md', 5, 'First', 'first']);
  assert.equal(data.matchCount, 2);
  assert.equal(data.alternatives.length, 1);
  const [other] = data.alternatives;
  assert.deepEqual([other.source, other.startLine, other.endLine, other.heading, other.anchor], ['docs/twins.md', 9, 9, 'Second', 'second']);
  assert.equal(other.blobUrl, `https://github.com/kontourai/sample/blob/${sha}/docs/twins.md#L9-L9`);
  const scoped = await locate(client, { product: 'sample', quote: 'gate holds', source: 'README.md' });
  assert.equal(scoped.isError, true, 'source limits the search');
});

test('mcp locate finds text inside code as the page shows it, and caps the alternatives it lists', async (t) => {
  const repo = fixtureRepo(t, 'selection', { as: 'sample' });
  // Fifteen more copies make 17 candidates for one quote.
  appendFileSync(path.join(repo, 'docs', 'twins.md'), '\nThe same sentence appears twice in this document.\n'.repeat(15));
  commitAll(repo, 'many copies');
  const client = await connect(t, ['--repo', repo]);
  // `<dir>` sits in a code span, so the page shows it; it is not an HTML tag there.
  const code = await locate(client, { product: 'sample', quote: 'then run docs-kit build --root <dir>.' });
  assert.equal(code.isError, false, JSON.stringify(code.data));
  assert.deepEqual([code.data.source, code.data.startLine, code.data.endLine], ['docs/twins.md', 11, 11]);
  const fence = await locate(client, { product: 'sample', quote: 'sample run --fast\nsample report' });
  assert.deepEqual([fence.data.startLine, fence.data.endLine, fence.data.match, fence.data.confidence], [27, 28, 'verbatim', 1]);
  const many = await locate(client, { product: 'sample', quote: 'The same sentence appears twice in this document.' });
  assert.equal(many.data.matchCount, 17);
  assert.equal(many.data.alternatives.length, 10, 'at most ten alternatives are listed');
  assert.equal(many.data.confidence, 0.06);
});

test('an out-of-range numeric entity renders as U+FFFD instead of crashing build or locate; fences in lists and blockquotes end where they should', async (t) => {
  const repo = fixtureRepo(t, 'selection', { as: 'sample' });
  writeFileSync(
    path.join(repo, 'docs', 'twins.md'),
    [
      '# Twins &#1114112;', // 1
      '', // 2
      '- ```js', // 3: a fence opened on a list line
      '  let a = 1;', // 4
      '  ```', // 5
      '', // 6
      'After the list <b>bold</b> words here.', // 7
      '', // 8
      '> ```', // 9: a fence closed by the end of the blockquote
      '> code', // 10
      '', // 11
      'After the quote <b>bold</b> words here.', // 12
      '',
    ].join('\n'),
  );
  commitAll(repo, 'edge cases');
  const out = path.join(scratch(t), 'site');
  const build = await runCli(['build', '--root', repo, '--out', out]);
  assert.equal(build.status, 0, build.output);
  assert.match(readFileSync(path.join(out, 'docs', 'twins.html'), 'utf8'), /<h1 id="twins-" data-src-line="1-1">Twins \uFFFD/);
  const client = await connect(t, ['--repo', repo]);
  for (const [quote, line] of [
    ['After the list bold words here.', 7],
    ['After the quote bold words here.', 12],
  ]) {
    const { isError, data } = await locate(client, { product: 'sample', quote });
    assert.equal(isError, false, `${quote}: ${JSON.stringify(data)}`);
    assert.deepEqual([data.source, data.startLine], ['docs/twins.md', line], quote);
  }
});

test('mcp locate returns an error for no match, a too-short quote, and an unknown source', async (t) => {
  const repo = fixtureRepo(t, 'selection', { as: 'sample' });
  const sha = git(repo, ['rev-parse', 'HEAD']);
  const client = await connect(t, ['--repo', repo]);
  const none = await locate(client, { product: 'sample', quote: 'This sentence is nowhere in the docs.' });
  assert.equal(none.isError, true);
  assert.deepEqual(none.data, { error: 'no match for the quote in sample', documentsSearched: 3, sha });
  const short = await locate(client, { product: 'sample', quote: ' . a ' });
  assert.equal(short.isError, true);
  assert.match(short.data.error, /quote is too short/);
  const unknown = await locate(client, { product: 'sample', quote: 'gate holds', source: 'docs/nope.md' });
  assert.equal(unknown.isError, true);
  assert.match(unknown.data.error, /unknown document "docs\/nope\.md"/);
  assert.ok(unknown.data.availableDocuments.includes('docs/guide.md'));
});
