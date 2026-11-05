import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { commitAll, fixtureRepo, FIXTURES, git, runCli, scratch } from './helpers.mjs';

const hash = (root, file) => createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex');
const documents = ['docs/getting-started.md', 'docs/reference/cli.md'];
const source = 'src/cli/main.js';

function review(root, inputs = [source]) {
  return {
    id: 'cli-docs', reviewedAt: '2026-11-05T00:00:00Z',
    note: 'Reviewed the internal change; the documented CLI behavior is unchanged.',
    limits: 'Source review only, not runtime or deployment qualification.',
    inputs: inputs.map((file) => ({ path: file, sha256: hash(root, file) })),
    outputs: documents.map((file) => ({ path: file, sha256: hash(root, file) })),
  };
}
function save(root, reviews) {
  writeFileSync(path.join(root, 'corpus-content.json'), JSON.stringify({ schemaVersion: 1, repository: 'example/sample', reviews }, null, 2));
}
const check = (root, base) => runCli(['check', '--root', root, '--base', base]);

test('a new complete byte review clears freshness without changing covering prose', async (t) => {
  const root = fixtureRepo(t, 'valid');
  const base = git(root, ['rev-parse', 'HEAD']);
  const original = documents.map((file) => readFileSync(path.join(root, file), 'utf8'));
  appendFileSync(path.join(root, source), '\n// Internal implementation changed.\n');
  commitAll(root, 'source only');
  assert.equal((await check(root, base)).status, 1);
  save(root, [review(root)]);
  commitAll(root, 'record explicit source review');
  const result = await check(root, base);
  assert.equal(result.status, 0, result.output);
  assert.match(result.stdout, /PASS freshness/);
  assert.deepEqual(documents.map((file) => readFileSync(path.join(root, file), 'utf8')), original);
  appendFileSync(path.join(root, source), '\n// A later unreviewed change.\n');
  commitAll(root, 'source changed after the review');
  const later = await check(root, base);
  assert.equal(later.status, 1, later.output);
  assert.match(later.stderr, /is stale/);
});

test('a review must include every covered changed file and current document bytes', async (t) => {
  const root = fixtureRepo(t, 'valid');
  const base = git(root, ['rev-parse', 'HEAD']);
  appendFileSync(path.join(root, source), '\n// Changed.\n');
  const extra = 'src/cli/extra.js';
  writeFileSync(path.join(root, extra), 'export const extra = true;\n');
  save(root, [review(root)]);
  commitAll(root, 'incomplete source review');
  assert.equal((await check(root, base)).status, 1);
  const complete = review(root, [source, extra]);
  complete.outputs[0].sha256 = '0'.repeat(64);
  save(root, [complete]);
  commitAll(root, 'wrong document binding');
  assert.equal((await check(root, base)).status, 1);
  save(root, [review(root, [source, extra])]);
  commitAll(root, 'complete reviewed bindings');
  const result = await check(root, base);
  assert.equal(result.status, 0, result.output);
});

test('old reviews and unrelated manifest edits cannot approve a later mode change', async (t) => {
  const root = fixtureRepo(t, 'valid');
  save(root, [review(root)]);
  const base = commitAll(root, 'existing review');
  chmodSync(path.join(root, source), 0o755);
  git(root, ['update-index', '--chmod=+x', source]);
  git(root, ['commit', '-qm', 'executable mode changed']);
  assert.equal((await check(root, base)).status, 1);
  const manifest = JSON.parse(readFileSync(path.join(root, 'corpus-content.json')));
  manifest.relationships = [{ id: 'other', covers: ['other/**'], targets: ['https://example.invalid/other'] }];
  writeFileSync(path.join(root, 'corpus-content.json'), JSON.stringify(manifest));
  commitAll(root, 'an unrelated relationship');
  const result = await check(root, base);
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /is stale/);
});

test('remote-only input evidence cannot clear the offline source freshness gate', async (t) => {
  const root = fixtureRepo(t, 'valid');
  const base = git(root, ['rev-parse', 'HEAD']);
  appendFileSync(path.join(root, source), '\n// Changed.\n');
  const recorded = review(root);
  recorded.inputs = [{ url: 'https://github.com/example/sample/blob/main/src/cli/main.js', revision: 'a'.repeat(40), sha256: hash(root, source) }];
  save(root, [recorded]);
  commitAll(root, 'remote evidence does not review the local candidate');
  const result = await check(root, base);
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /is stale/);
});

test('invalid local review configuration is unavailable rather than a passing freshness result', async (t) => {
  const root = fixtureRepo(t, 'valid');
  const base = git(root, ['rev-parse', 'HEAD']);
  appendFileSync(path.join(root, source), '\n// Changed.\n');
  save(root, [{ ...review(root), note: '' }]);
  commitAll(root, 'invalid review');
  const result = await check(root, base);
  assert.equal(result.status, 2, result.output);
  assert.match(result.stderr, /NOT_VERIFIED/);
});

test('a docs root below the git root resolves the correct merge-base review', async (t) => {
  const top = scratch(t);
  const root = path.join(top, 'nested');
  mkdirSync(root);
  cpSync(path.join(FIXTURES, 'valid'), root, { recursive: true });
  git(top, ['init', '-q']);
  const base = commitAll(top, 'baseline');
  appendFileSync(path.join(root, source), '\n// Internal change.\n');
  save(root, [review(root)]);
  commitAll(top, 'review nested docs');
  const result = await check(root, base);
  assert.equal(result.status, 0, result.output);
});
