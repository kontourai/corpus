import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const preflight = fileURLToPath(new URL('../scripts/root-release-preflight.mjs', import.meta.url));
const RELEASED = '# Changelog\n\n## 0.8.0\n\n- Released change.\n\n## 0.7.0\n\n- Older change.\n';

function run(t, { name = '@kontourai/corpus', version = '0.8.0', changelog = RELEASED, args = ['0.8.0'] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'corpus-release-preflight-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify({ name, version }, null, 2)}\n`);
  if (changelog !== null) writeFileSync(join(directory, 'CHANGELOG.md'), changelog);
  return spawnSync(process.execPath, [preflight, ...args], { cwd: directory, encoding: 'utf8' });
}

test('root release preflight: passes when the manifest and the first changelog section name the version', (t) => {
  const result = run(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Release preflight passed for @kontourai\/corpus@0\.8\.0/);
});

const refusals = [
  { label: 'a version that differs from package.json', options: { args: ['0.7.0'] }, message: /package\.json version "0\.8\.0" does not equal the requested "0\.7\.0"/ },
  { label: 'a workspace manifest', options: { name: '@kontourai/corpus-store' }, message: /package\.json name is "@kontourai\/corpus-store"/ },
  {
    label: 'an Unreleased section anywhere',
    options: { changelog: '# Changelog\n\n## 0.8.0\n\n- A.\n\n## Unreleased — Corpus\n\n- B.\n' },
    message: /still has "## Unreleased — Corpus"; release those changes under "## 0\.8\.0" first/,
  },
  {
    // The shape of this repository's changelog before the 0.8.0 release.
    label: 'the previous version still on top with unreleased changes below it',
    options: { version: '0.7.0', args: ['0.7.0'], changelog: '# Changelog\n\n## 0.7.0\n\n- A.\n\n## Unreleased — Corpus\n\n- B.\n' },
    message: /still has "## Unreleased — Corpus"/,
  },
  {
    label: 'a bracketed [Unreleased] section after the release',
    options: { changelog: '# Changelog\n\n## 0.8.0\n\n- A.\n\n## [Unreleased]\n\n- B.\n' },
    message: /still has "## \[Unreleased\]"/,
  },
  {
    label: 'an Unreleased heading at another level',
    options: { changelog: '# Changelog\n\n## 0.8.0\n\n### Unreleased\n\n- B.\n' },
    message: /still has "### Unreleased"/,
  },
  {
    label: 'a top-level Unreleased heading',
    options: { changelog: '# Unreleased\n\n## 0.8.0\n\n- A.\n' },
    message: /still has "# Unreleased"/,
  },
  { label: 'a changelog whose first section is another version', options: { changelog: '# Changelog\n\n## 0.7.0\n\n- A.\n' }, message: /first section is "## 0\.7\.0", not "## 0\.8\.0"/ },
  { label: 'a missing changelog', options: { changelog: null }, message: /cannot read CHANGELOG\.md/ },
  { label: 'no version argument', options: { args: [] }, message: /usage: root-release-preflight\.mjs <exact-version>/ },
];

for (const { label, options, message } of refusals) {
  test(`root release preflight: refuses ${label}`, (t) => {
    const result = run(t, options);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /^Refusing release: /);
    assert.match(result.stderr, message);
  });
}
