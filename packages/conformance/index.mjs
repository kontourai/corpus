import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

export const vectors = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8')).vectors;

/**
 * Vector scopes. `store` (the default when `scope` is absent) is satisfied by a
 * store adapter alone. `host` needs host-owned behavior, such as search, that a
 * store library deliberately does not implement: a store package cannot pass it,
 * and every host that mounts a store must.
 */
export const vectorScopes = Object.freeze(['store', 'host']);
export function vectorScope(vector) {
  const scope = vector.scope ?? 'store';
  if (!vectorScopes.includes(scope)) throw new Error(`vector ${vector.id}: unknown scope ${JSON.stringify(scope)}`);
  return scope;
}
export const storeVectors = vectors.filter((vector) => vectorScope(vector) === 'store');
export const hostVectors = vectors.filter((vector) => vectorScope(vector) === 'host');

function reference(values, ref) {
  const [name, ...keys] = ref.split('.');
  assert.ok(Object.hasOwn(values, name), `unresolved reference ${ref}`);
  return keys.reduce((value, key) => {
    assert.ok(value != null && Object.hasOwn(value, key), `unresolved reference ${ref}`);
    return value[key];
  }, values[name]);
}

function resolve(value, values) {
  if (typeof value === 'string' && value.startsWith('$')) return reference(values, value.slice(1));
  if (Array.isArray(value)) return value.map((item) => resolve(item, values));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item, values)]));
  return value;
}

function compare(actual, expected, ref, kind) {
  try { assert.deepEqual(actual, expected); }
  catch (error) { error.conformanceAssertion = { ref, kind, expected, actual }; throw error; }
}

async function special(harness, operation, values) {
  const adapter = harness.adapter;
  if (operation.special === 'ttl-anchor') {
    const record = await adapter.get(values.a);
    const expiry = Date.parse(record.created_at) + record.ttl_seconds * 1000;
    assert.ok(Number.isFinite(expiry), 'creation timestamp and TTL must define expiry');
    const before = await adapter.listByType('raw', { stale: true, now: expiry - 1 });
    const at = await adapter.listByType('raw', { stale: true, now: expiry });
    compare(before.length, 0, 'ttl-anchor.before', 'length');
    compare(at.length, 1, 'ttl-anchor.at', 'length');
    values.check = true;
    return;
  }
  if (operation.special === 'prefix-resolution') {
    const record = await adapter.get(values.a.slice(0, 8));
    assert.equal(record.id, values.a);
    values.check = true;
    return;
  }
  const probe = harness.specials?.[operation.special];
  assert.equal(typeof probe, 'function', `missing required probe: ${operation.special}`);
  const saved = await probe({ adapter, operation, values: structuredClone(values) });
  assert.ok(saved && typeof saved === 'object', `probe ${operation.special} must return saved observations`);
  Object.assign(values, structuredClone(saved));
}

/** A fresh adapter/harness per vector; missing capabilities are failures. */
export async function runConformance(adapterFactory, { cases = vectors } = {}) {
  const results = [];
  for (const vector of cases) {
    let harness;
    let failure;
    try {
      const created = await adapterFactory(vector);
      harness = created?.adapter ? created : { adapter: created };
      assert.ok(harness.adapter, 'factory must return an adapter or harness');
      const values = {};
      for (const operation of vector.operations) {
        if (operation.special) {
          await special(harness, operation, values);
          continue;
        }
        const method = harness.adapter[operation.call];
        assert.equal(typeof method, 'function', `missing adapter method: ${operation.call}`);
        const args = resolve(operation.args, values);
        if (operation.expect_error) {
          let caught;
          try { await method.apply(harness.adapter, args); } catch (error) { caught = error; }
          assert.ok(caught, `${operation.call} must reject`);
          if (operation.expect_error !== 'ANY') assert.equal(caught.code, operation.expect_error);
        } else {
          const value = await method.apply(harness.adapter, args);
          if (operation.save) values[operation.save] = structuredClone(value);
        }
      }
      for (const expected of vector.expected) {
        assert.ok(Object.hasOwn(expected, 'equals') || Object.hasOwn(expected, 'length') || expected.absent === true, 'malformed expected entry: requires equals or length or absent:true');
        if (expected.absent === true) {
          const parts = expected.ref.split('.');
          assert.ok(parts.length > 1, 'absence assertion requires a field reference');
          const key = parts.pop();
          const parent = reference(values, parts.join('.'));
          assert.ok(parent && typeof parent === 'object', 'absence assertion requires an object');
          assert.equal(Object.hasOwn(parent, key), false, `${expected.ref} must be absent`);
          continue;
        }
        const actual = reference(values, expected.ref);
        if (Object.hasOwn(expected, 'equals')) compare(actual, resolve(expected.equals, values), expected.ref, 'equals');
        if (Object.hasOwn(expected, 'length')) compare(actual?.length, expected.length, expected.ref, 'length');
      }
    } catch (error) { failure = error; }
    try { await harness?.dispose?.(); } catch (error) { failure ??= error; }
    results.push({ id: vector.id, passed: !failure, ...(failure ? { error: failure.message, ...(failure.conformanceAssertion ? { assertion: failure.conformanceAssertion } : {}) } : {}) });
  }
  return { passed: results.every((result) => result.passed), results };
}
