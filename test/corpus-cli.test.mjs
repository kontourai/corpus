import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { FIXTURES, REPO_ROOT, scratch } from './helpers.mjs';

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
test('both manifest names are refused with a deletion instruction', (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, 'docs-kit.json'), readFileSync(path.join(root, 'corpus.json')));
  const result = cli('corpus', ['check', '--root', root]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /delete docs-kit.json.*delete corpus.json/);
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
test('v1 legacy manifests still pass with a stderr deprecation warning', (t) => {
  const root = scratch(t);
  writeFileSync(path.join(root, 'README.md'), '# Sample\n');
  writeFileSync(path.join(root, 'docs-kit.json'), JSON.stringify({ schemaVersion: 1, product: 'sample', title: 'Sample', repo: 'example/sample', documents: [] }));
  const result = cli('docs-kit', ['check', '--root', root]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /v1 is deprecated/);
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
