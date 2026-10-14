import assert from 'node:assert/strict';
import { cpSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { bundleFromCheckout } from '../src/bundle.mjs';
import { bundleShapeError, createCheckoutCache, loadWorkspace } from '../src/mcp.mjs';
import { FIXTURES, scratch } from './helpers.mjs';

test('v2 checkout metadata survives cache refresh, and a retired docs-kit.json appearing mid-session is refused', async (t) => {
  const root = scratch(t);
  cpSync(path.join(FIXTURES, 'corpus-v2'), root, { recursive: true });
  const bundle = bundleFromCheckout(root);
  assert.equal(bundle.schemaVersion, 2);
  assert.equal(bundle.purpose, 'Serve source-bound documentation.');
  assert.deepEqual(bundle.builtOn, []);
  assert.equal(bundleShapeError(bundle), null);
  assert.match(bundleShapeError({ ...bundle, purpose: ' ' }), /purpose/);
  const cache = createCheckoutCache();
  const first = cache(root);
  const file = path.join(root, 'corpus.json');
  const raw = JSON.parse(readFileSync(file));
  raw.purpose = 'Retrieve current source content.';
  writeFileSync(file, JSON.stringify(raw));
  assert.equal(cache(root).purpose, raw.purpose);
  // Outside git, the stat of each manifest name is what changes the cache key.
  const retired = path.join(root, 'docs-kit.json');
  renameSync(file, retired);
  assert.throws(() => cache(root), /docs-kit\.json is a retired v1 manifest and Corpus no longer reads it; rename it to corpus\.json/);
  writeFileSync(file, JSON.stringify(raw));
  assert.throws(() => cache(root), /docs-kit\.json is a retired v1 manifest .* sits next to corpus\.json; delete docs-kit\.json/);
  rmSync(retired);
  assert.equal(cache(root).purpose, raw.purpose);
  assert.equal(first.purpose, bundle.purpose);
});

test('workspace discovers only corpus.json, skips docs-kit.json-only directories, and marks a leftover pair unavailable', (t) => {
  const root = scratch(t);
  cpSync(path.join(FIXTURES, 'corpus-v2'), path.join(root, 'sample'), { recursive: true });
  cpSync(path.join(FIXTURES, 'corpus-v2'), path.join(root, 'old'), { recursive: true });
  renameSync(path.join(root, 'old', 'corpus.json'), path.join(root, 'old', 'docs-kit.json'));
  const retired = [];
  const loaded = loadWorkspace(root, undefined, (_, name) => retired.push(name));
  assert.deepEqual([...loaded.bundles.keys()], ['sample']);
  assert.equal(loaded.bundles.get('sample').schemaVersion, 2);
  assert.deepEqual(loaded.unavailable, [], 'a docs-kit.json-only directory is not a product, so it is not unavailable either');
  assert.deepEqual(retired, ['old']);

  const file = path.join(root, 'sample', 'corpus.json');
  writeFileSync(path.join(root, 'sample', 'docs-kit.json'), readFileSync(file));
  const broken = loadWorkspace(root, undefined, () => {});
  assert.equal(broken.bundles.size, 0);
  assert.match(broken.unavailable[0].error, /docs-kit\.json is a retired v1 manifest .* sits next to corpus\.json/);
});
