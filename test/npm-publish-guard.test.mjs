import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const guard = new URL('../scripts/npm-publish-guard.mjs', import.meta.url);
const STORE = '@kontourai/corpus-store';
const ROOT = '@kontourai/corpus';
const fixtures = [
  { label: 'allows missing prerelease on next', version: '0.1.0-next.0', tag: 'next', code: 1, response: { error: { code: 'E404' } }, status: 0, message: /Allow @kontourai\/corpus-store@0\.1\.0-next\.0 with dist-tag next/ },
  { label: 'allows missing stable on latest', version: '0.1.0', tag: 'latest', code: 1, response: { error: { code: 'E404' } }, status: 0, message: /Allow .* with dist-tag latest/ },
  { label: 'refuses prerelease on latest', version: '0.1.0-next.0', tag: 'latest', code: 1, response: { error: { code: 'E404' } }, status: 1, message: /latest is forbidden/ },
  { label: 'refuses existing version', version: '0.1.0-next.0', tag: 'next', code: 0, response: '0.1.0-next.0', status: 1, message: /already exists on npm/ },
  { label: 'refuses registry outage', version: '0.1.0-next.0', tag: 'next', code: 1, response: { error: { code: 'ECONNRESET' } }, status: 1, message: /npm view failed: ECONNRESET/ },
  { label: 'refuses malformed registry response', version: '0.1.0-next.0', tag: 'next', code: 1, response: undefined, status: 1, message: /absence is unconfirmed/ },
  { label: 'refuses version ranges', version: '^0.1.0', tag: 'next', code: 1, response: { error: { code: 'E404' } }, status: 1, message: /exact semantic version/ },
  { label: 'refuses invalid numeric prerelease', version: '0.1.0-01', tag: 'next', code: 1, response: { error: { code: 'E404' } }, status: 1, message: /exact semantic version/ },
  // The root CLI package, published by its own workflow on `latest`.
  { label: 'allows the root package, missing stable, on latest', name: ROOT, version: '0.8.0', tag: 'latest', code: 1, response: { error: { code: 'E404' } }, status: 0, message: /Allow @kontourai\/corpus@0\.8\.0 with dist-tag latest: npm reports E404/, queried: '@kontourai/corpus@0.8.0' },
  { label: 'refuses an existing root version', name: ROOT, version: '0.7.0', tag: 'latest', code: 0, response: '0.7.0', status: 1, message: /@kontourai\/corpus@0\.7\.0 already exists on npm/ },
  { label: 'refuses a root prerelease on latest', name: ROOT, version: '0.8.0-rc.0', tag: 'latest', code: 1, response: { error: { code: 'E404' } }, status: 1, message: /latest is forbidden/ },
  // Unknown names are refused before the registry is asked, even when it would report E404.
  { label: 'refuses an unlisted Kontour package', name: '@kontourai/corpus-other', version: '0.8.0', tag: 'latest', code: 1, response: { error: { code: 'E404' } }, status: 1, message: /expected a Corpus package name/, queried: null },
  { label: 'refuses an unscoped look-alike', name: 'corpus', version: '0.8.0', tag: 'latest', code: 1, response: { error: { code: 'E404' } }, status: 1, message: /expected a Corpus package name/, queried: null },
  { label: 'refuses the root name with a version suffix', name: '@kontourai/corpus@0.8.0', version: '0.8.0', tag: 'latest', code: 1, response: { error: { code: 'E404' } }, status: 1, message: /expected a Corpus package name/, queried: null },
];

for (const fixture of fixtures) {
  test(`npm publish guard: ${fixture.label}`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'corpus-publish-guard-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const npm = join(directory, 'npm');
    const queried = join(directory, 'queried');
    // The fake npm records the spec it was asked about, so a test can tell
    // "refused before asking the registry" from "asked and was refused".
    writeFileSync(npm, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(queried)}, process.argv[3]);\nconsole.log(${JSON.stringify(JSON.stringify(fixture.response) ?? 'not JSON')});\nprocess.exit(${fixture.code});\n`);
    chmodSync(npm, 0o755);
    const result = spawnSync(process.execPath, [guard.pathname, fixture.name ?? STORE, fixture.version, fixture.tag], {
      encoding: 'utf8', env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
    });
    assert.equal(result.status, fixture.status, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, fixture.message);
    if (fixture.queried === null) assert.equal(existsSync(queried), false, 'the registry must not be queried');
    else if (fixture.queried) assert.equal(readFileSync(queried, 'utf8'), fixture.queried);
  });
}
