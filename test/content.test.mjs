import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { commitAll, git, runCli, scratch } from './helpers.mjs';

const digest = (text) => createHash('sha256').update(text).digest('hex');
const revision = 'a'.repeat(40);
const url = 'https://github.com/example/product/blob/main/policy.md';

function fixture(t) {
  const root = scratch(t, 'corpus-content-');
  const product = path.join(root, 'arbitrary-checkout-name');
  mkdirSync(product);
  writeFileSync(path.join(product, 'policy.md'), 'Reviewed policy\n');
  writeFileSync(path.join(root, 'public.astro'), 'Reviewed public policy\n');
  const manifest = {
    schemaVersion: 1, repository: 'example/website',
    relationships: [{ id: 'privacy', covers: ['src/**'], targets: ['https://github.com/example/website/blob/main/public.astro'] }],
    reviews: [{
      id: 'privacy', reviewedAt: '2026-11-05T00:00:00Z', note: 'Reviewed the stated data flows.', limits: 'Synthetic source review; no deployment proof.',
      inputs: [{ url, revision, sha256: digest('Reviewed policy\n') }],
      outputs: [{ path: 'public.astro', sha256: digest('Reviewed public policy\n') }],
    }],
  };
  const save = () => writeFileSync(path.join(root, 'corpus-content.json'), JSON.stringify(manifest));
  const run = (args = [], options = {}) => {
    save();
    return runCli(['content', 'check', '--root', root, '--checkout', `example/product=${product}`, ...args], options);
  };
  return { root, product, manifest, save, run };
}

test('real CLI accepts reviewed bytes using a checkout at any directory', async (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.product, 'unrelated.txt'), 'New unrelated feature');
  const result = await f.run();
  assert.equal(result.status, 0, result.output);
  assert.equal(JSON.parse(result.stdout).verdict, 'pass');
});

for (const kind of ['input', 'output']) test(`real CLI refuses changed ${kind} bytes`, async (t) => {
  const f = fixture(t);
  writeFileSync(path.join(kind === 'input' ? f.product : f.root, kind === 'input' ? 'policy.md' : 'public.astro'), 'Unreviewed change');
  const result = await f.run();
  assert.equal(result.status, 1, result.output);
  assert.match(JSON.parse(result.stdout).failures[0], new RegExp(`privacy: changed ${kind}:`));
});

for (const kind of ['empty', 'missing', 'escape', 'duplicate', 'unknown', 'remote host', 'bad revision']) test(`real CLI reports ${kind} review input as unverified`, async (t) => {
  const f = fixture(t);
  if (kind === 'empty') f.manifest.reviews = [];
  if (kind === 'missing') f.manifest.reviews[0].inputs[0].url = url.replace('policy.md', 'missing.md');
  if (kind === 'escape') f.manifest.reviews[0].outputs[0].path = '../outside';
  if (kind === 'duplicate') f.manifest.reviews.push(f.manifest.reviews[0]);
  if (kind === 'unknown') f.manifest.reviews[0].approved = true;
  if (kind === 'remote host') f.manifest.reviews[0].inputs[0].url = 'https://example.invalid/file';
  if (kind === 'bad revision') f.manifest.reviews[0].inputs[0].revision = 'main';
  const result = await f.run();
  assert.equal(result.status, 2, result.output);
  assert.match(result.stderr, /NOT_VERIFIED/);
  assert.equal(result.stdout, '');
});

test('impact routes explicit and committed changes to GitHub targets without network or prose edits', async (t) => {
  const f = fixture(t);
  f.manifest.relationships[0].targets.push('https://example.invalid/privacy/');
  f.save();
  const explicit = await runCli(['content', 'impact', '--root', f.root, '--changed-file', 'src/new.ts', '--changed-file', 'unrelated.txt']);
  assert.equal(explicit.status, 0, explicit.output);
  assert.deepEqual(JSON.parse(explicit.stdout).surfaces, [{ id: 'privacy', targets: f.manifest.relationships[0].targets, changedBy: ['src/new.ts'] }]);
  git(f.root, ['init', '-q']);
  const base = commitAll(f.root, 'baseline');
  mkdirSync(path.join(f.root, 'src'));
  writeFileSync(path.join(f.root, 'src', 'new.ts'), 'export const value = 1;');
  commitAll(f.root, 'new code without public copy changes');
  const committed = await runCli(['content', 'impact', '--root', f.root, '--base', base]);
  assert.equal(committed.status, 0, committed.output);
  assert.deepEqual(JSON.parse(committed.stdout).surfaces, JSON.parse(explicit.stdout).surfaces);
  const bad = await runCli(['content', 'impact', '--root', f.root, '--base', 'missing-ref']);
  assert.equal(bad.status, 2, bad.output);
});

for (const state of ['current', 'drifted', 'unavailable']) test(`GitHub API fixture: ${state} remote content`, async (t) => {
  const f = fixture(t);
  // Two inputs on one moving branch must use one observed commit, even if
  // GitHub's branch moves between content requests. The child records URLs.
  f.manifest.reviews[0].inputs.push({ url: url.replace('policy.md', 'other.md'), revision, sha256: digest('Reviewed policy\n') });
  f.save();
  const requests = path.join(f.root, 'requests.json');
  const preload = path.join(f.root, 'github-fixture.mjs');
  writeFileSync(preload, `
    import { writeFileSync } from 'node:fs';
    const requests = [];
    globalThis.fetch = async (url, options) => {
      requests.push(String(url));
      writeFileSync(${JSON.stringify(requests)}, JSON.stringify(requests));
      if (options.redirect !== 'error') throw new Error('redirects must be refused');
      if (${JSON.stringify(state)} === 'unavailable') return new Response('', { status: 404 });
      if (String(url).includes('/commits/')) return Response.json({ sha: ${JSON.stringify(revision)} });
      if (!String(url).endsWith('?ref=${revision}')) throw new Error('content not pinned to observed commit');
      return Response.json({ type: 'file', encoding: 'base64', content: Buffer.from(${JSON.stringify(state === 'drifted' ? 'Changed policy\n' : 'Reviewed policy\n')}).toString('base64') });
    };
  `);
  const result = await runCli(['content', 'check', '--root', f.root], { env: { NODE_OPTIONS: `--import=${preload}` } });
  assert.equal(result.status, { current: 0, drifted: 1, unavailable: 2 }[state], result.output);
  const seen = JSON.parse(readFileSync(requests, 'utf8'));
  assert.equal(seen.filter((url) => url.includes('/commits/')).length, 1);
  if (state === 'current') assert.equal(JSON.parse(result.stdout).observedRevisions['example/product@main'], revision);
  if (state === 'unavailable') assert.match(result.stderr, /NOT_VERIFIED.*404/);
});
