import { expect, test } from 'vitest';
import { adjudicate } from './conformance.mjs';
import expected from './expected-fails.json';
test('expected failures bind to the exact assertion and observed values', () => {
  for (const profile of ['default', 'vault']) for (const [id, decision] of Object.entries(expected)) {
    if (!('assertions' in decision)) continue;
    const assertion = decision.assertions[profile];
    const failure = { id, passed: false, error: 'Expected values to be strictly equal', assertion };
    expect(adjudicate({ results: [failure] }, profile, expected, { selected: true }).passed).toBe(true);
    for (const changed of [{ ...assertion, ref: 'wrong' }, { ...assertion, expected: 999 }, { ...assertion, actual: 999 }]) {
      expect(adjudicate({ results: [{ ...failure, assertion: changed }] }, profile, expected, { selected: true }).passed).toBe(false);
    }
  }
});
test('selected vectors still reject unexpected passes and unexpected failures', () => {
  expect(adjudicate({ results: [{ id: 'read-retired', passed: true }] }, 'default', expected, { selected: true }).passed).toBe(false);
  expect(adjudicate({ results: [{ id: 'create-roundtrip', passed: false, error: 'broken' }] }, 'default', expected, { selected: true }).passed).toBe(false);
});

test('the selected-vector CLI applies expected-fail adjudication', async () => {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, [new URL('./conformance.mjs', import.meta.url).pathname, 'read-retired'], { encoding: 'utf8' });
  expect(result.status, result.stderr + result.stdout).toBe(0);
  expect(result.stdout).toContain('"unexpected": []');
  expect(result.stdout).toContain('"read-retired"');
});
