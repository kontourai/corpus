import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const guard = new URL('../scripts/npm-publish-guard.mjs', import.meta.url);
const fixtures = [
  { label: 'allows missing prerelease on next', version: '0.1.0-next.0', tag: 'next', code: 1, response: { error: { code: 'E404' } }, status: 0, message: /Allow .* with dist-tag next/ },
  { label: 'allows missing stable on latest', version: '0.1.0', tag: 'latest', code: 1, response: { error: { code: 'E404' } }, status: 0, message: /Allow .* with dist-tag latest/ },
  { label: 'refuses prerelease on latest', version: '0.1.0-next.0', tag: 'latest', code: 1, response: { error: { code: 'E404' } }, status: 1, message: /latest is forbidden/ },
  { label: 'refuses existing version', version: '0.1.0-next.0', tag: 'next', code: 0, response: '0.1.0-next.0', status: 1, message: /already exists on npm/ },
  { label: 'refuses registry outage', version: '0.1.0-next.0', tag: 'next', code: 1, response: { error: { code: 'ECONNRESET' } }, status: 1, message: /npm view failed: ECONNRESET/ },
  { label: 'refuses malformed registry response', version: '0.1.0-next.0', tag: 'next', code: 1, response: undefined, status: 1, message: /absence is unconfirmed/ },
  { label: 'refuses version ranges', version: '^0.1.0', tag: 'next', code: 1, response: { error: { code: 'E404' } }, status: 1, message: /exact semantic version/ },
  { label: 'refuses invalid numeric prerelease', version: '0.1.0-01', tag: 'next', code: 1, response: { error: { code: 'E404' } }, status: 1, message: /exact semantic version/ },
];

for (const fixture of fixtures) {
  test(`npm publish guard: ${fixture.label}`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'corpus-publish-guard-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const npm = join(directory, 'npm');
    writeFileSync(npm, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify(fixture.response) ?? 'not JSON')});\nprocess.exit(${fixture.code});\n`);
    chmodSync(npm, 0o755);
    const result = spawnSync(process.execPath, [guard.pathname, '@kontourai/corpus-store', fixture.version, fixture.tag], {
      encoding: 'utf8', env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
    });
    assert.equal(result.status, fixture.status, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, fixture.message);
  });
}
