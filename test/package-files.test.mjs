import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { packedFileProblems, trackedShippedFiles } from '../scripts/root-package-files.mjs';
import { REPO_ROOT } from './helpers.mjs';

// What `npm publish` would upload for the root package, from npm itself.
function dryRunPack() {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  const [entry, ...others] = JSON.parse(output);
  assert.equal(others.length, 0, 'npm pack at the root must pack only the root package');
  return entry;
}

test('the root npm tarball ships exactly bin/, src/, schemas/, README.md, LICENSE, and package.json', () => {
  const entry = dryRunPack();
  assert.equal(entry.name, '@kontourai/corpus');
  const paths = entry.files.map((file) => file.path).sort();
  assert.deepEqual(packedFileProblems(paths, trackedShippedFiles(REPO_ROOT)), []);
  // Spot-check what must never ship, independently of the allow-list above.
  for (const forbidden of ['test/', 'packages/', 'docs/', '.github/', 'scripts/', 'node_modules/']) {
    assert.deepEqual(paths.filter((path) => path.startsWith(forbidden)), [], `${forbidden} must not ship`);
  }
  for (const forbidden of ['corpus.json', 'CHANGELOG.md', 'AGENTS.md', 'package-lock.json']) {
    assert.equal(paths.includes(forbidden), false, `${forbidden} must not ship`);
  }
});

test('packedFileProblems names a stray file and a missing tracked source', () => {
  const problems = packedFileProblems(['LICENSE', 'README.md', 'package.json', 'test/check.test.mjs'], ['src/cli.mjs']);
  assert.ok(problems.includes('not allowed in the tarball: test/check.test.mjs'), problems.join('\n'));
  assert.ok(problems.includes('missing from the tarball: src/cli.mjs'), problems.join('\n'));
  assert.ok(problems.includes('missing from the tarball: bin/corpus.mjs'), problems.join('\n'));
});
