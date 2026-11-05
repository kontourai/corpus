import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runConformance, vectors, storeVectors, hostVectors, vectorScope } from '../packages/conformance/index.mjs';

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
test('runner rejects malformed expected entries without equals or length', async () => {
  const report = await runConformance(() => ({ get: () => ({ body: 'evidence' }) }), {
    cases: [{
      id: 'malformed-expected',
      operations: [{ call: 'get', args: [], save: 'record' }],
      expected: [{ ref: 'record.body' }],
    }],
  });
  assert.equal(report.passed, false);
  assert.equal(report.results[0].passed, false);
  assert.match(report.results[0].error, /malformed expected entry.*equals or length/);
});


test('absence expectations check field removal and reject a retained null', async () => {
  const cases = [{ id: 'absence', operations: [{ call: 'get', args: [], save: 'record' }], expected: [{ ref: 'record.expires_at', absent: true }] }];
  assert.equal((await runConformance(() => ({ get: async () => ({}) }), { cases })).passed, true);
  const retained = await runConformance(() => ({ get: async () => ({ expires_at: null }) }), { cases });
  assert.equal(retained.passed, false);
  assert.match(retained.results[0].error, /must be absent/);
});

test('vector scopes partition the vectors into store and host obligations', () => {
  assert.equal(storeVectors.length + hostVectors.length, vectors.length);
  assert.ok(hostVectors.every((vector) => vector.scope === 'host'));
  assert.ok(storeVectors.every((vector) => vector.scope === undefined || vector.scope === 'store'));
  assert.equal(vectorScope({ id: 'unscoped' }), 'store');
  assert.throws(() => vectorScope({ id: 'typo', scope: 'hosts' }), /vector typo: unknown scope "hosts"/);
});

test('$number tokens write the numbers JSON cannot, in arguments and in expected values', async () => {
  const received = [];
  const cases = [{
    id: 'numbers',
    operations: [{ call: 'echo', args: [{ nested: [{ $number: 'NaN' }] }, { $number: 'Infinity' }, { $number: '-Infinity' }, { $number: '-0' }], save: 'echoed' }],
    expected: [{ ref: 'echoed', equals: { $number: 'NaN' } }],
  }];
  const report = await runConformance(() => ({ echo(...args) { received.push(args); return Number.NaN; } }), { cases });
  assert.equal(report.passed, true, JSON.stringify(report));
  const [nested, infinity, negativeInfinity, negativeZero] = received[0];
  assert.ok(Number.isNaN(nested.nested[0]));
  assert.equal(infinity, Number.POSITIVE_INFINITY);
  assert.equal(negativeInfinity, Number.NEGATIVE_INFINITY);
  assert.ok(Object.is(negativeZero, -0));
  // A returned 0 is not -0, and a token is compared as the number it stands for.
  const wrong = await runConformance(() => ({ echo: () => 0 }), { cases: [{ id: 'zero', operations: [{ call: 'echo', args: [], save: 'v' }], expected: [{ ref: 'v', equals: { $number: '-0' } }] }] });
  assert.equal(wrong.passed, false);
});

test('a malformed $number token fails the vector instead of passing through as an object', async () => {
  for (const token of [{ $number: 'nan' }, { $number: 5 }, { $number: 'NaN', extra: true }, { $number: '__proto__' }, { $number: ['NaN'] }, { $number: ['-0'] }, { $number: null }]) {
    let called = false;
    const report = await runConformance(() => ({ echo() { called = true; } }), { cases: [{ id: 'bad', operations: [{ call: 'echo', args: [token] }], expected: [] }] });
    assert.equal(report.passed, false, JSON.stringify(token));
    assert.match(report.results[0].error, /malformed \$number token/);
    assert.equal(called, false);
  }
});

test('a $number getter that changes its answer cannot pass validation and then resolve differently', async () => {
  // The first reads answer the valid token NaN (enough for a runner that validates it more than once); later reads are not a token. The adapter returns undefined,
  // so the vector must fail. A runner that reads the property again after validating would resolve it
  // to undefined and pass.
  let reads = 0;
  const token = { get $number() { return reads++ < 3 ? 'NaN' : 'unknown'; } };
  const report = await runConformance(() => ({ echo: () => undefined }), { cases: [{ id: 'getter', operations: [{ call: 'echo', args: [], save: 'v' }], expected: [{ ref: 'v', equals: token }] }] });
  assert.equal(report.passed, false, JSON.stringify(report));
});
