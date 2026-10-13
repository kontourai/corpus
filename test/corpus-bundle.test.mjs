import assert from 'node:assert/strict';
import { cpSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { bundleFromCheckout } from '../src/bundle.mjs';
import { bundleShapeError, createCheckoutCache, loadWorkspace } from '../src/mcp.mjs';
import { FIXTURES, scratch } from './helpers.mjs';

test('v2 checkout metadata survives cache refresh and manifest filename changes', async (t) => {
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
  renameSync(file, path.join(root, 'docs-kit.json'));
  assert.equal(cache(root).purpose, raw.purpose);
  writeFileSync(file, JSON.stringify(raw));
  assert.throws(() => cache(root), /both corpus.json and docs-kit.json/);
  assert.equal(first.purpose, bundle.purpose);
});

test('workspace discovers preferred manifests and marks ambiguous pairs unavailable', (t) => {
  const root = scratch(t);
  cpSync(path.join(FIXTURES, 'corpus-v2'), path.join(root, 'sample'), { recursive: true });
  const loaded = loadWorkspace(root);
  assert.equal(loaded.bundles.get('sample').schemaVersion, 2);
  const file = path.join(root, 'sample', 'corpus.json');
  writeFileSync(path.join(root, 'sample', 'docs-kit.json'), readFileSync(file));
  const broken = loadWorkspace(root);
  assert.equal(broken.bundles.size, 0);
  assert.match(broken.unavailable[0].error, /both corpus.json and docs-kit.json/);
});
