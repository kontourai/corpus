import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { FIXTURES, REPO_ROOT, scratch } from './helpers.mjs';

for (const [name, status, message] of [
  ['pnpm-self-exclusion', 0, /PASS builtOn/],
  ['pnpm-workspace-missing', 1, /packages\/worker\/package.json dependencies: @kontourai\/knowledge is missing/],
  ['workspace-excluded', 1, /@kontourai\/component is missing/],
  ['pnpm-invalid-workspaces', 2, /packages must use a block list/],
  ['grouped', 0, /PASS builtOn/],
  ['declared-id', 0, /PASS builtOn/],
  ['array-missing', 1, /@kontourai\/console-ui is missing from builtOn; add/],
  ['array-phantom', 1, /via @kontourai\/console-ui.*no matching dependency/],
  ['duplicate', 1, /@kontourai\/console-core appears more than once.*entries 0 and 1/],
  ['duplicate-array', 1, /@kontourai\/console-core appears more than once/],
  ['self-exclusion', 0, /PASS builtOn/],
  ['external-same-prefix', 1, /@kontourai\/sample-external is missing/],
  ['empty-via', 2, /via must be a non-empty array/],
  ['invalid-via-item', 2, /via\[1\]/],
  ['cli-array-valid', 0, /PASS builtOn/],
  ['cli-array-invalid', 1, /via veritas-query.*no matching dependency/],
  ['cli-runtime-missing', 1, /@kontourai\/flow-agents is missing/],
  ['matching', 0, /PASS builtOn/],
  ['missing', 1, /@kontourai\/flow-agents is missing from builtOn; add/],
  ['phantom', 1, /via @kontourai\/knowledge.*no matching dependency; remove/],
  ['cli-valid', 0, /PASS builtOn/],
  ['cli-invalid', 1, /via veritas.*no matching dependency/],
  ['cli-script', 0, /PASS builtOn/],
  ['dev-only', 0, /dev-only: @kontourai\/veritas; declare it/],
  ['dev-declared', 0, /WARN builtOn/],
  ['workspace', 0, /3 package.json file/],
  ['workspace-missing', 1, /packages\/worker\/package.json dependencies: @kontourai\/knowledge is missing/],
  ['git-spec', 0, /PASS builtOn/],
  ['no-package', 0, /SKIP builtOn.*no package.json.*not verified/],
  ['v1', 0, /SKIP builtOn.*v1/],
  ['invalid-evidence', 2, /evidence must be "cli"/],
  ['malformed-package', 2, /cannot read dependency evidence/],
]) {
  test(`builtOn CLI: ${name}`, (t) => {
    const root = scratch(t, 'built-on-');
    cpSync(path.join(FIXTURES, 'built-on', name), root, { recursive: true });
    const result = spawnSync(process.execPath, [path.join(REPO_ROOT, 'bin/corpus.mjs'), 'check', '--root', root], { encoding: 'utf8' });
    assert.equal(result.status, status, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, message);
    if (name === 'self-exclusion') assert.doesNotMatch(result.stdout + result.stderr, /dev-only/);
  });
}
