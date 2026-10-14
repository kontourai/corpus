import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { FIXTURES, REPO_ROOT, commitAll, git, scratch } from './helpers.mjs';

function fixture(t, change = {}) {
  const root = scratch(t, 'corpus-cli-');
  cpSync(path.join(FIXTURES, 'corpus-v2'), root, { recursive: true });
  const manifest = { ...JSON.parse(readFileSync(path.join(root, 'corpus.json'))), ...change };
  writeFileSync(path.join(root, 'corpus.json'), JSON.stringify(manifest));
  return root;
}
function cli(bin, args) {
  return spawnSync(process.execPath, [path.join(REPO_ROOT, 'bin', `${bin}.mjs`), ...args], { encoding: 'utf8' });
}
for (const [label, purpose] of [['missing', undefined], ['empty', ''], ['whitespace', '   ']]) {
  test(`v2 ${label} purpose is a CLI configuration error`, (t) => {
    const result = cli('corpus', ['check', '--root', fixture(t, { purpose })]);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /purpose/);
  });
}
for (const [name, change, message] of [
  ['unknown v2 key', { unexpected: true }, /unknown key "unexpected"/],
  ['missing builtOn', { builtOn: undefined }, /builtOn/],
  ['invalid building block', { builtOn: [{ product: 'x', via: 'x', for: '' }] }, /builtOn.*for/],
  ['unknown building-block key', { builtOn: [{ product: 'x', via: 'x', for: 'use', hidden: true }] }, /unknown key "hidden"/],
]) {
  test(`${name} is rejected by the CLI`, (t) => {
    const result = cli('corpus', ['check', '--root', fixture(t, change)]);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, message);
  });
}
/** A v1 manifest exactly as the retired schema had it: no purpose, no builtOn. */
const V1_MANIFEST = { schemaVersion: 1, product: 'sample', title: 'Sample', repo: 'example/sample', documents: [] };
const RETIRED_ONLY = /docs-kit\.json is a retired v1 manifest and Corpus no longer reads it; rename it to corpus\.json, set "schemaVersion": 2, and add "purpose" \(one sentence on what the product is for\) and "builtOn" \(the Kontour products it builds on, or \[\]\)\. Or move it aside and run "corpus init" to scaffold a v2 corpus\.json/;
const RETIRED_BESIDE = /docs-kit\.json is a retired v1 manifest and Corpus no longer reads it, but it sits next to corpus\.json; delete docs-kit\.json/;

function retiredOnly(t, manifest = V1_MANIFEST) {
  const root = scratch(t);
  writeFileSync(path.join(root, 'README.md'), '# Sample\n');
  writeFileSync(path.join(root, 'docs-kit.json'), JSON.stringify(manifest));
  return root;
}

for (const bin of ['corpus', 'docs-kit']) {
  test(`${bin} check and build refuse a repository whose only manifest is docs-kit.json (exit 2)`, (t) => {
    const root = retiredOnly(t);
    const check = cli(bin, ['check', '--root', root]);
    assert.equal(check.status, 2, check.stderr);
    assert.match(check.stderr, RETIRED_ONLY);
    assert.equal(check.stdout, '', 'refused before any gate runs');
    const out = path.join(scratch(t), 'site');
    const build = cli(bin, ['build', '--root', root, '--out', out]);
    assert.equal(build.status, 2, build.stderr);
    assert.match(build.stderr, RETIRED_ONLY);
    assert.ok(!existsSync(out), 'build writes nothing');
  });
}

test('a docs-kit.json is refused even when it is a valid v2 manifest', (t) => {
  const root = fixture(t);
  renameSync(path.join(root, 'corpus.json'), path.join(root, 'docs-kit.json'));
  const result = cli('corpus', ['check', '--root', root]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, RETIRED_ONLY);
});

test('a docs-kit.json next to corpus.json is refused with a deletion instruction (exit 2)', (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, 'docs-kit.json'), JSON.stringify(V1_MANIFEST));
  for (const args of [['check', '--root', root], ['build', '--root', root, '--out', path.join(scratch(t), 'site')]]) {
    const result = cli('corpus', args);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, RETIRED_BESIDE);
    assert.doesNotMatch(result.stderr, /delete corpus\.json/, 'never suggests keeping the v1 file');
  }
});

test('corpus.json with schemaVersion 1 is refused with the v2 remedy (exit 2)', (t) => {
  const root = scratch(t);
  writeFileSync(path.join(root, 'README.md'), '# Sample\n');
  writeFileSync(path.join(root, 'corpus.json'), JSON.stringify(V1_MANIFEST));
  const result = cli('corpus', ['check', '--root', root]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /FAIL manifest\n {4}- corpus\.json: schemaVersion 1 is no longer supported; set "schemaVersion": 2, and add "purpose" .* and "builtOn"/);
  assert.match(result.stderr, /SKIP purpose \(corpus\.json is invalid\)/);
  assert.doesNotMatch(result.stdout + result.stderr, /deprecated|v1 manifest has no/);

  // Even with purpose and builtOn present, version 1 is not a v2 manifest.
  writeFileSync(path.join(root, 'corpus.json'), JSON.stringify({ ...V1_MANIFEST, purpose: 'A fixture.', builtOn: [] }));
  const filled = cli('corpus', ['check', '--root', root]);
  assert.equal(filled.status, 2, filled.stderr);
  assert.match(filled.stderr, /schemaVersion 1 is no longer supported/);
});

test('a v2 corpus.json passes check and build as a child process (exit 0)', (t) => {
  const root = fixture(t);
  const check = cli('corpus', ['check', '--root', root]);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /PASS manifest/);
  assert.match(check.stdout, /PASS purpose/);
  assert.match(check.stdout, /check passed/);
  assert.equal(check.stderr, '', 'no deprecation or other warning');
  git(root, ['init', '-q']);
  commitAll(root, 'v2 fixture');
  const out = path.join(scratch(t), 'site');
  const build = cli('corpus', ['build', '--root', root, '--out', out]);
  assert.equal(build.status, 0, build.stderr);
  const bundle = JSON.parse(readFileSync(path.join(out, 'docs-bundle.json'), 'utf8'));
  assert.equal(bundle.schemaVersion, 2);
  assert.equal(bundle.purpose, 'Serve source-bound documentation.');
});
test('packaged docs-kit alias has corpus byte and exit parity', (t) => {
  // Exercise the bin mappings npm installs, including npx's leading name.
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json')));
  const root = fixture(t);
  for (const [args, status] of [[['--help'], 0], [['--version'], 0], [['check', '--root', root], 0], [['unknown'], 2], [['check', '--root', fixture(t, { purpose: '' })], 2]]) {
    const run = (name) => spawnSync(process.execPath, [path.join(REPO_ROOT, pkg.bin[name]), name, ...args], { encoding: 'utf8' });
    const corpus = run('corpus');
    assert.equal(corpus.status, status, corpus.stderr);
    const alias = run('docs-kit');
    assert.deepEqual([alias.status, alias.stdout, alias.stderr], [corpus.status, corpus.stdout, corpus.stderr]);
  }
});
test('locate CLI reports a source-bound passage and rejects missing quote', (t) => {
  const root = fixture(t);
  const located = cli('corpus', ['locate', '--root', root, '--quote', 'Source-bound documentation']);
  assert.equal(located.status, 0, located.stderr);
  assert.match(located.stdout, /README.md/);
  const missing = cli('corpus', ['locate', '--root', root]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /requires --quote/);
});
