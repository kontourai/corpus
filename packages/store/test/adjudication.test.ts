import { expect, test } from 'vitest';
import { hostVectors, storeVectors, vectors } from '@kontourai/corpus-conformance';
import { adjudicate, packageCases } from './conformance.mjs';
// A fixture list with both binding shapes, so these tests keep their force after
// the real list empties.
const expected = {
  'read-retired': {
    profiles: ['default', 'vault'],
    awaits: 'fixture decision',
    assertions: {
      default: { ref: 'history', kind: 'length', expected: 1, actual: 0 },
      vault: { ref: 'history', kind: 'length', expected: 1, actual: 0 },
    },
  },
  'compiled-without-source': {
    profiles: ['default', 'vault'],
    awaits: 'fixture decision',
    errorPattern: '^create must reject$',
  },
};
test('expected failures bind to the exact assertion and observed values', () => {
  for (const profile of ['default', 'vault']) {
    const assertion = expected['read-retired'].assertions[profile as 'default' | 'vault'];
    const failure = { id: 'read-retired', passed: false, error: 'Expected values to be strictly equal', assertion };
    expect(adjudicate({ results: [failure] }, profile, expected, { selected: true }).passed).toBe(true);
    for (const changed of [{ ...assertion, ref: 'wrong' }, { ...assertion, expected: 999 }, { ...assertion, actual: 999 }]) {
      expect(adjudicate({ results: [{ ...failure, assertion: changed }] }, profile, expected, { selected: true }).passed).toBe(false);
    }
    const patterned = { id: 'compiled-without-source', passed: false, error: 'create must reject' };
    expect(adjudicate({ results: [patterned] }, profile, expected, { selected: true }).passed).toBe(true);
    expect(adjudicate({ results: [{ ...patterned, error: 'something else' }] }, profile, expected, { selected: true }).passed).toBe(false);
  }
});
test('selected vectors still reject unexpected passes and unexpected failures', () => {
  expect(adjudicate({ results: [{ id: 'read-retired', passed: true }] }, 'default', expected, { selected: true }).passed).toBe(false);
  expect(adjudicate({ results: [{ id: 'create-roundtrip', passed: false, error: 'broken' }] }, 'default', expected, { selected: true }).passed).toBe(false);
});

test('the selected-vector CLI applies expected-fail adjudication', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'corpus-adjudication-'));
  try {
    // A passing vector listed as an expected failure must fail the selected run.
    const list = join(directory, 'expected-fails.json');
    writeFileSync(list, JSON.stringify({ 'create-roundtrip': { profiles: ['default', 'vault'], awaits: 'fixture', errorPattern: '^never$' } }));
    const cli = new URL('./conformance.mjs', import.meta.url).pathname;
    const listed = spawnSync(process.execPath, [cli, 'create-roundtrip'], { encoding: 'utf8', env: { ...process.env, CORPUS_EXPECTED_FAILS: list } });
    expect(listed.status, listed.stderr + listed.stdout).toBe(1);
    expect(listed.stdout).toContain('Expected-fail vector passed; remove it from the list');
    const unlisted = spawnSync(process.execPath, [cli, 'create-roundtrip'], { encoding: 'utf8' });
    expect(unlisted.status, unlisted.stderr + unlisted.stdout).toBe(0);
    expect(unlisted.stdout).toContain('"unexpected": []');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the package runs every store vector and no host vector', () => {
  // search-working-set is the one host vector today; pinned here independently of the scope data.
  expect(hostVectors.map((vector) => vector.id)).toEqual(['search-working-set']);
  const ids = packageCases().map((vector) => vector.id);
  expect(ids).toEqual(storeVectors.map((vector) => vector.id));
  expect(ids).not.toContain('search-working-set');
  expect(ids.length + hostVectors.length).toBe(vectors.length);
  expect(() => packageCases(['search-working-set'])).toThrow(/host vector/);
});

test('a host vector cannot be excused by the package expected-fail list', () => {
  const excused = { 'search-working-set': { profiles: ['default', 'vault'], awaits: 'host', errorPattern: '^missing adapter method: search' } };
  const report = { results: [{ id: 'create-roundtrip', passed: true }] };
  for (const selected of [false, true]) {
    const result = adjudicate(report, 'default', excused, { selected });
    expect(result.passed).toBe(false);
    expect(result.unexpected).toEqual([{ id: 'search-working-set', error: 'Host vector listed as a package expected failure; hosts must pass it' }]);
  }
});

test('the selected-vector CLI refuses a host vector', async () => {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, [new URL('./conformance.mjs', import.meta.url).pathname, 'search-working-set'], { encoding: 'utf8' });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Selected vector search-working-set is a host vector');
});
