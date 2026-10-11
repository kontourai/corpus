import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixtureRepo, git, runCli, scratch } from './helpers.mjs';

function setRedirects(repo, redirects) {
  const file = path.join(repo, 'docs-kit.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  manifest.redirects = redirects;
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function build(t, repo) {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '--allow-empty', '-m', 'redirects']);
  const out = path.join(scratch(t), 'site');
  const result = await runCli(['build', '--root', repo, '--out', out]);
  return { result, out, read: (file) => readFileSync(path.join(out, file), 'utf8') };
}

const refreshOf = (html) => html.match(/<meta http-equiv="refresh" content="0; url=([^"]*)">/)?.[1];
const canonicalOf = (html) => html.match(/<link rel="canonical" href="([^"]*)">/)?.[1];
const linkOf = (html) => html.match(/<a href="([^"]*)">/)?.[1];

test('redirects: build writes stubs with relative URLs from each stub depth', async (t) => {
  const repo = fixtureRepo(t, 'valid');
  setRedirects(repo, {
    'workflows.html': 'docs/concepts.md#workflows',
    'adr/0001-old.html': 'docs/reference/cli.md',
    'deep/er/home.html': 'README.md#install',
  });
  const check = await runCli(['check', '--root', repo]);
  assert.equal(check.status, 0, check.output);
  assert.match(check.stdout, /PASS redirects/);

  const { result, out, read } = await build(t, repo);
  assert.equal(result.status, 0, result.output);
  assert.match(result.stdout, /3 redirects/);

  const top = read('workflows.html');
  assert.equal(refreshOf(top), 'docs/concepts.html#workflows');
  assert.equal(linkOf(top), 'docs/concepts.html#workflows');
  assert.equal(canonicalOf(top), 'https://kontourai.github.io/sample/docs/concepts.html');
  assert.match(top, /<meta name="robots" content="noindex">/);
  assert.doesNotMatch(top, /<script/i);

  const nested = read('adr/0001-old.html');
  assert.equal(refreshOf(nested), '../docs/reference/cli.html');
  assert.equal(linkOf(nested), '../docs/reference/cli.html');
  assert.equal(canonicalOf(nested), 'https://kontourai.github.io/sample/docs/reference/cli.html');

  const deep = read('deep/er/home.html');
  assert.equal(refreshOf(deep), '../../index.html#install');
  assert.equal(canonicalOf(deep), 'https://kontourai.github.io/sample/index.html');

  const marker = JSON.parse(read('.docs-kit-build'));
  for (const stub of ['workflows.html', 'adr/0001-old.html', 'deep/er/home.html']) assert.ok(marker.files.includes(stub), stub);
  const bundle = JSON.parse(read('docs-bundle.json'));
  assert.equal(JSON.stringify(bundle).includes('0001-old'), false, 'the bundle does not carry redirects');
  assert.ok(existsSync(path.join(out, 'index.html')));

  // The marker lets the next build replace a directory holding stubs.
  const again = await runCli(['build', '--root', repo, '--out', out]);
  assert.equal(again.status, 0, again.output);
});

test('redirects: docs-bundle.json is unchanged by redirects (same digest and keys)', async (t) => {
  const plain = fixtureRepo(t, 'valid');
  const withRedirects = fixtureRepo(t, 'valid');
  setRedirects(withRedirects, { 'old.html': 'docs/concepts.md' });
  const a = JSON.parse((await build(t, plain)).read('docs-bundle.json'));
  const b = JSON.parse((await build(t, withRedirects)).read('docs-bundle.json'));
  assert.equal(a.digest, b.digest);
  assert.deepEqual(Object.keys(a), Object.keys(b));
});

test('redirects: an absolute https target is written in canonical form', async (t) => {
  const repo = fixtureRepo(t, 'valid');
  setRedirects(repo, { 'docs/moved.html': 'https://example.com/elsewhere/page.html#part' });
  const { result, read } = await build(t, repo);
  assert.equal(result.status, 0, result.output);
  const stub = read('docs/moved.html');
  assert.equal(refreshOf(stub), 'https://example.com/elsewhere/page.html#part');
  assert.equal(linkOf(stub), 'https://example.com/elsewhere/page.html#part');
  assert.equal(canonicalOf(stub), 'https://example.com/elsewhere/page.html#part');
});

test('redirects: a missing or unpublished target fails the redirects gate (exit 1)', async (t) => {
  const repo = fixtureRepo(t, 'valid');
  setRedirects(repo, {
    'gone.html': 'docs/missing.md',
    'plan.html': 'docs/plans/roadmap.md',
    'fine.html': 'docs/concepts.md',
  });
  const result = await runCli(['check', '--root', repo]);
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /FAIL redirects/);
  assert.match(result.stderr, /redirects\["gone\.html"\]: target "docs\/missing\.md" does not exist/);
  assert.match(result.stderr, /redirects\["plan\.html"\]: target "docs\/plans\/roadmap\.md" is not published/);
  assert.doesNotMatch(result.stderr, /fine\.html/);
  const built = await build(t, repo);
  assert.equal(built.result.status, 1, built.result.output);
  assert.match(built.result.stderr, /refusing to build until check passes/);
});

test('redirects: a target anchor that does not resolve fails (exit 1)', async (t) => {
  const repo = fixtureRepo(t, 'valid');
  setRedirects(repo, { 'w.html': 'docs/concepts.md#no-such-heading', 'ok.html': 'docs/concepts.md#workflows' });
  const result = await runCli(['check', '--root', repo]);
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /redirects\["w\.html"\]: target "docs\/concepts\.md#no-such-heading" - missing anchor #no-such-heading in docs\/concepts\.md/);
  assert.doesNotMatch(result.stderr, /ok\.html/);
});

test('redirects: a key that collides with a generated file, or repeats, fails (exit 1)', async (t) => {
  const repo = fixtureRepo(t, 'valid');
  setRedirects(repo, {
    'docs/concepts.html': 'README.md',
    'index.html': 'docs/concepts.md',
    'Docs/Getting-Started.html': 'README.md',
    'index.html/inner.html': 'README.md',
    'unrelated.html': 'README.md',
  });
  // JSON.parse would silently keep only the last of two equal keys.
  const file = path.join(repo, 'docs-kit.json');
  writeFileSync(file, readFileSync(file, 'utf8').replace('"unrelated.html": "README.md"', '"unrelated.html": "README.md", "unrelated.html": "docs/concepts.md"'));
  const result = await runCli(['check', '--root', repo]);
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /redirects\["docs\/concepts\.html"\] would overwrite the page generated for docs\/concepts\.md/);
  assert.match(result.stderr, /redirects\["index\.html"\] would overwrite the page generated for README\.md/);
  assert.match(result.stderr, /redirects\["Docs\/Getting-Started\.html"\] would overwrite the page generated for docs\/getting-started\.md/);
  assert.match(result.stderr, /redirects\["index\.html\/inner\.html"\] needs a directory where docs-kit writes the page generated for README\.md/);
  assert.match(result.stderr, /redirects\["unrelated\.html"\] appears more than once/);
});

test('redirects: malformed keys and targets are manifest errors (exit 2)', async (t) => {
  const repo = fixtureRepo(t, 'valid');
  setRedirects(repo, {
    '/abs.html': 'README.md',
    'up/../x.html': 'README.md',
    'q.html?x': 'README.md',
    'frag.html#a': 'README.md',
    'page.md': 'README.md',
    'plain.html': 'http://example.com/',
    'scheme.html': 'javascript:alert(1)',
    'notmd.html': 'docs/assets/diagram.svg',
    'empty.html': 'docs/concepts.md#',
    'num.html': 7,
  });
  const result = await runCli(['check', '--root', repo]);
  assert.equal(result.status, 2, result.output);
  for (const pattern of [
    /redirects\["\/abs\.html"\]: key must be site-relative/,
    /redirects\["up\/\.\.\/x\.html"\]: key must not contain "\.\."/,
    /redirects\["q\.html\?x"\]: key must not contain "#" or "\?"/,
    /redirects\["frag\.html#a"\]: key must not contain "#" or "\?"/,
    /redirects\["page\.md"\]: key must end in "\.html"/,
    /redirects\["plain\.html"\]: target must be a published source path or an absolute https:\/\/ URL/,
    /redirects\["scheme\.html"\]: target must be a published source path or an absolute https:\/\/ URL/,
    /redirects\["notmd\.html"\]: target must be a published \.md source/,
    /redirects\["empty\.html"\]: target has an empty #anchor/,
    /redirects\["num\.html"\]: target must be a non-empty string/,
    /SKIP redirects/,
  ])
    assert.match(result.stderr, pattern);

  setRedirects(repo, ['old.html']);
  const array = await runCli(['check', '--root', repo]);
  assert.equal(array.status, 2, array.output);
  assert.match(array.stderr, /redirects must be an object/);
});

test('redirects: the generated-site check verifies stub links and the refresh URL (exit 1)', async (t) => {
  const repo = fixtureRepo(t, 'valid');
  // A name anchor on a <span> passes check, but the sanitizer keeps name only on <a>.
  appendFileSync(path.join(repo, 'docs/concepts.md'), '\n<span name="legacy">Legacy</span>\n');
  setRedirects(repo, { 'old/legacy.html': 'docs/concepts.md#legacy' });
  const check = await runCli(['check', '--root', repo]);
  assert.equal(check.status, 0, check.output);
  const { result } = await build(t, repo);
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /old\/legacy\.html: href="\.\.\/docs\/concepts\.html#legacy" - missing anchor #legacy/);
  assert.match(result.stderr, /old\/legacy\.html: refresh="\.\.\/docs\/concepts\.html#legacy" - missing anchor #legacy/);
});

test('redirects: build refuses a stub that would overwrite a copied asset (exit 1)', async (t) => {
  const repo = fixtureRepo(t, 'valid');
  mkdirSync(path.join(repo, 'docs/legacy.html'));
  copyFileSync(path.join(repo, 'docs/assets/diagram.svg'), path.join(repo, 'docs/legacy.html/diagram.svg'));
  appendFileSync(path.join(repo, 'docs/concepts.md'), '\n![diagram](legacy.html/diagram.svg)\n');
  setRedirects(repo, { 'docs/legacy.html': 'docs/concepts.md' });
  const { result } = await build(t, repo);
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /redirects\["docs\/legacy\.html"\] would overwrite the copied asset docs\/legacy\.html\/diagram\.svg/);
});

test('redirects: a non-canonical https target is emitted normalized, never raw', async (t) => {
  const repo = fixtureRepo(t, 'valid');
  setRedirects(repo, { 'x.html': 'HTTPS:///evil.com/a/../x' });
  const { result, read } = await build(t, repo);
  assert.equal(result.status, 0, result.output);
  const stub = read('x.html');
  assert.equal(refreshOf(stub), 'https://evil.com/x');
  assert.equal(linkOf(stub), 'https://evil.com/x');
  assert.equal(canonicalOf(stub), 'https://evil.com/x');
  assert.doesNotMatch(stub, /HTTPS:|\/\/\/evil/);
});

test('redirects: keys that differ only in Unicode normalization collide (exit 1)', async (t) => {
  const repo = fixtureRepo(t, 'valid');
  const nfc = 'caf\u00e9.html';
  const nfd = 'cafe\u0301.html';
  // The generated page side too: an NFD key against an NFC page path.
  mkdirSync(path.join(repo, 'docs'), { recursive: true });
  writeFileSync(path.join(repo, 'docs/r\u00e9sum\u00e9.md'), '# Resume\n');
  const file = path.join(repo, 'docs-kit.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  manifest.documents.push({ source: 'docs/r\u00e9sum\u00e9.md', section: 'Reference' });
  manifest.redirects = { [nfc]: 'README.md', [nfd]: 'README.md', ['docs/re\u0301sume\u0301.html']: 'README.md' };
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  const result = await runCli(['check', '--root', repo]);
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /differs only in case or Unicode normalization/);
  assert.match(result.stderr, /would overwrite the page generated for docs\/r\u00e9sum\u00e9\.md/);
});
