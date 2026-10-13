import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { FIXTURES, REPO_ROOT, scratch } from './helpers.mjs';

for (const [name, status, message] of [
  ['pnpm-self-exclusion', 0, /PASS builtOn/],
  ['pnpm-workspace-missing', 1, /packages\/worker\/package.json dependencies: @kontourai\/knowledge is missing/],
  ['workspace-excluded', 1, /@kontourai\/component is missing/],
  ['pnpm-flow-workspaces', 0, /PASS builtOn/],
  ['pnpm-unindented', 1, /@kontourai\/knowledge is missing/],
  ['pnpm-no-members', 2, /no workspace members resolve/],
  ['pnpm-no-packages', 2, /no workspace members resolve/],
  ['pnpm-malformed', 2, /cannot parse YAML evidence/],
  ['alias-declared', 0, /PASS builtOn/],
  ['alias-target-rejected', 1, /alias is missing from builtOn/],
  ['scoped-non-kontour', 0, /PASS builtOn/],
  ['cli-github-expression', 0, /PASS builtOn/],
  ['cli-with-run', 1, /no matching dependency/],
  ['cli-heredoc', 1, /no matching dependency/],
  ['cli-after-heredoc', 0, /PASS builtOn/],
  ['cli-composite', 0, /PASS builtOn/],
  ['cli-non-composite', 1, /no matching dependency/],
  ['cli-bin', 0, /PASS builtOn/],
  ['invalid-bin', 2, /bin must be a bare CLI/],
  ['cli-no-evidence', 1, /no matching dependency/],
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

function runChangedFixture(t, name, file, change) {
  const root = scratch(t, 'built-on-matrix-');
  cpSync(path.join(FIXTURES, 'built-on', name), root, { recursive: true });
  const target = path.join(root, file);
  writeFileSync(target, JSON.stringify(change(JSON.parse(readFileSync(target)))));
  return spawnSync(process.execPath, [path.join(REPO_ROOT, 'bin/corpus.mjs'), 'check', '--root', root], { encoding: 'utf8' });
}

for (const spec of [
  'npm:@kontourai/flow@^1',
  'git+ssh://git@github.com/kontourai/flow.git#main',
  'git@github.com:kontourai/flow.git',
  'git://github.com/kontourai/flow.git',
  'https://github.com/kontourai/flow.git',
  'https://codeload.github.com/kontourai/flow/tar.gz/refs/heads/main',
  'kontourai/flow',
  'github:kontourai/flow/subpath',
  'github:KontourAI/flow',
  'git+https://github.com/KontourAI/flow.git',
  'https://codeload.github.com/KontourAI/flow/tar.gz/main',
]) {
  test(`builtOn spec coverage: ${spec}`, (t) => {
    const result = runChangedFixture(t, 'spec-missing', 'package.json', () => ({ dependencies: { alias: spec } }));
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /alias is missing from builtOn; add/);
  });
}
for (const command of [
  'npm exec veritas readiness', 'npm exec -- veritas readiness',
  'pnpm dlx veritas readiness', 'yarn dlx veritas readiness',
  'pnpm veritas readiness', 'yarn veritas readiness',
  'npx veritas@1.2.3 readiness', 'npx --no-install veritas readiness',
  './node_modules/.bin/veritas readiness', 'CI=true MODE=test veritas readiness',
]) {
  test(`builtOn CLI runner: ${command}`, (t) => {
    const result = runChangedFixture(t, 'cli-runners', 'package.json', () => ({ scripts: { check: command } }));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /PASS builtOn/);
  });
}

for (const command of [
  'cat <<EOF\nveritas readiness\nEOF',
  'cat <<-EOF\n\tveritas readiness\n\tEOF',
  'cat <<FIRST <<"SECOND"\necho ignored\nFIRST\nveritas readiness\nSECOND',
  'echo "text\nveritas readiness\nmore text"',
]) {
  test(`builtOn CLI non-command text: ${JSON.stringify(command)}`, (t) => {
    const result = runChangedFixture(t, 'cli-runners', 'package.json', () => ({ scripts: { check: command } }));
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /no matching dependency/);
  });
}
