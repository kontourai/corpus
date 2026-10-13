import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runConformance, vectors } from '../packages/conformance/index.mjs';

const rejection = vectors.find((vector) => vector.id === 'create-invalid-body-   ');
test('runner distinguishes expected contract errors from acceptance and unrelated errors', async () => {
  for (const [code, passes] of [['MISSING_EVIDENCE', true], ['NOT_FOUND', false], [null, false]]) {
    const report = await runConformance(() => ({ create() {
      if (code) throw Object.assign(new Error('rejected'), { code });
      return 'accepted';
    } }), { cases: [rejection] });
    assert.equal(report.passed, passes);
  }
});
test('runner fails absent storage probes and unresolved references', async () => {
  const missing = await runConformance(() => ({}), { cases: [vectors.find((vector) => vector.id === 'concurrent-create')] });
  assert.equal(missing.passed, false);
  assert.match(missing.results[0].error, /missing required probe/);
  const unresolved = await runConformance(() => ({ get() { throw new Error('must not be reached'); } }), { cases: [{ id: 'unresolved', operations: [{ call: 'get', args: ['$missing'] }], expected: [] }] });
  assert.equal(unresolved.passed, false);
  assert.match(unresolved.results[0].error, /unresolved reference/);
});
test('runner isolates vectors, preserves saved observations, and records cleanup failures', async () => {
  let factories = 0;
  let disposals = 0;
  const cases = [{ id: 'snapshot', operations: [{ call: 'get', args: [], save: 'before' }, { call: 'update', args: [] }], expected: [{ ref: 'before.body', equals: 'original' }] }];
  const report = await runConformance(() => {
    factories++;
    const record = { body: 'original' };
    return { adapter: { get: () => record, update: () => { record.body = 'changed'; } }, dispose: () => { disposals++; } };
  }, { cases: [...cases, ...cases] });
  assert.equal(report.passed, true);
  assert.equal(factories, 2);
  assert.equal(disposals, 2);
  const cleanup = await runConformance(() => ({ adapter: {}, dispose() { throw new Error('cleanup failed'); } }), { cases: [{ id: 'cleanup', operations: [], expected: [] }] });
  assert.equal(cleanup.passed, false);
  assert.match(cleanup.results[0].error, /cleanup failed/);
});
