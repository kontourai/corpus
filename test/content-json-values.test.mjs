import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { commitAll, fixtureRepo, runCli, scratch } from './helpers.mjs';

const hash = (text) => createHash('sha256').update(text).digest('hex');
function fixture(t) {
  const root = scratch(t, 'corpus-value-review-');
  const data = { products: { workspace: { version: '1.0.0', label: 'Workspace' }, other: { version: '9.0.0' } } };
  const entry = { path: 'status.json', pointer: '/products/workspace', sha256: hash('{"label":"Workspace","version":"1.0.0"}') };
  const manifest = { schemaVersion: 1, repository: 'example/site', reviews: [{ id: 'workspace', reviewedAt: '2026-11-05T00:00:00Z', note: 'Reviewed this product section independently of other package metadata.', limits: 'Synthetic selected-value consistency only.', inputs: [entry], outputs: [{ path: 'policy.md', sha256: hash('# Policy\n') }] }] };
  writeFileSync(path.join(root, 'policy.md'), '# Policy\n');
  const run = () => {
    writeFileSync(path.join(root, 'status.json'), JSON.stringify(data, null, 2));
    writeFileSync(path.join(root, 'corpus-content.json'), JSON.stringify(manifest));
    return runCli(['content', 'check', '--root', root]);
  };
  return { root, data, entry, manifest, run };
}

test('an unrelated package release preserves the scoped review; changing the owned value fails', async (t) => {
  const f = fixture(t);
  f.data.products.other.version = '9.1.0';
  let result = await f.run();
  assert.equal(result.status, 0, result.output);
  f.data.products.workspace.version = '1.1.0';
  result = await f.run();
  assert.equal(result.status, 1, result.output);
  assert.match(JSON.parse(result.stdout).failures[0], /status.json#\/products\/workspace/);
});

test('object key order is canonical recursively and array order remains meaningful', async (t) => {
  const f = fixture(t);
  f.data.products.workspace = { rows: [{ z: 2, a: 1 }, { z: 4, a: 3 }], a: null };
  f.entry.sha256 = hash('{"a":null,"rows":[{"a":1,"z":2},{"a":3,"z":4}]}');
  let result = await f.run();
  assert.equal(result.status, 0, result.output);
  f.data.products.workspace.rows.reverse();
  result = await f.run();
  assert.equal(result.status, 1, result.output);
});

test('explicit null is a value while a missing key remains unavailable', async (t) => {
  const f = fixture(t);
  f.data.products.workspace = null;
  f.entry.sha256 = hash('null');
  let result = await f.run();
  assert.equal(result.status, 0, result.output);
  delete f.data.products.workspace;
  result = await f.run();
  assert.equal(result.status, 2, result.output);
  assert.match(result.stderr, /does not resolve/);
});

test('RFC 6901 escapes and an empty pointer select the intended values', async (t) => {
  const f = fixture(t);
  f.data['a/b'] = { '~key': 5 };
  f.entry.pointer = '/a~1b/~0key';
  f.entry.sha256 = hash('5');
  let result = await f.run();
  assert.equal(result.status, 0, result.output);
  f.entry.pointer = '';
  f.entry.sha256 = hash('{"a/b":{"~key":5},"products":{"other":{"version":"9.0.0"},"workspace":{"label":"Workspace","version":"1.0.0"}}}');
  result = await f.run();
  assert.equal(result.status, 0, result.output);
});

for (const pointer of ['products/workspace', '/products/~2', '/toString', '/items/length', '/items/01']) test(`invalid or non-JSON property selection is unavailable: ${pointer}`, async (t) => {
  const f = fixture(t);
  f.data.items = [1, 2];
  f.entry.pointer = pointer;
  const result = await f.run();
  assert.equal(result.status, 2, result.output);
  assert.match(result.stderr, /NOT_VERIFIED/);
});

test('different values in one file are allowed; duplicate selections are refused', async (t) => {
  const f = fixture(t);
  f.manifest.reviews[0].inputs.push({ path: 'status.json', pointer: '/products/other', sha256: hash('{"version":"9.0.0"}') });
  let result = await f.run();
  assert.equal(result.status, 0, result.output);
  f.manifest.reviews[0].inputs.push({ ...f.entry });
  result = await f.run();
  assert.equal(result.status, 2, result.output);
  assert.match(result.stderr, /duplicate file/);
});

test('invalid UTF-8 is not replaced into a matching JSON string', async (t) => {
  const f = fixture(t);
  f.entry.sha256 = hash('"\ufffd"');
  writeFileSync(path.join(f.root, 'corpus-content.json'), JSON.stringify(f.manifest));
  writeFileSync(path.join(f.root, 'status.json'), Buffer.concat([Buffer.from('{"products":{"workspace":"'), Buffer.from([255]), Buffer.from('"}}')]));
  const result = await runCli(['content', 'check', '--root', f.root]);
  assert.equal(result.status, 2, result.output);
  assert.match(result.stderr, /valid UTF-8 JSON/);
});

for (const literal of ['1e999', '9007199254740993']) test(`unsafe numeric selection is unavailable rather than normalized: ${literal}`, async (t) => {
  const f = fixture(t);
  f.entry.sha256 = hash(JSON.stringify(JSON.parse(literal)));
  writeFileSync(path.join(f.root, 'corpus-content.json'), JSON.stringify(f.manifest));
  writeFileSync(path.join(f.root, 'status.json'), `{"products":{"workspace":${literal}}}`);
  const result = await runCli(['content', 'check', '--root', f.root]);
  assert.equal(result.status, 2, result.output);
  assert.match(result.stderr, /finite safe range/);
});

test('a partial JSON review cannot clear whole-file covers freshness', async (t) => {
  const root = fixtureRepo(t, 'valid');
  const source = 'src/cli/settings.json';
  writeFileSync(path.join(root, source), '{"visible":true,"hidden":1}');
  const base = commitAll(root, 'baseline with JSON source');
  writeFileSync(path.join(root, source), '{"visible":true,"hidden":2}');
  const docs = ['docs/getting-started.md', 'docs/reference/cli.md'];
  writeFileSync(path.join(root, 'corpus-content.json'), JSON.stringify({ schemaVersion: 1, repository: 'example/sample', reviews: [{ id: 'partial', reviewedAt: '2026-11-05T00:00:00Z', note: 'Only the visible field was inspected.', limits: 'Does not review the other source change.', inputs: [{ path: source, pointer: '/visible', sha256: hash('true') }], outputs: docs.map((file) => ({ path: file, sha256: hash(readFileSync(path.join(root, file))) })) }] }));
  commitAll(root, 'partial review of a whole-file change');
  const result = await runCli(['check', '--root', root, '--base', base]);
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /is stale/);
});
