import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

export const vectors = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8')).vectors;

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

async function special(harness, operation, values) {
  const adapter = harness.adapter;
  if (operation.special === 'ttl-anchor') {
    const record = await adapter.get(values.a);
    const expiry = Date.parse(record.created_at) + record.ttl_seconds * 1000;
    assert.ok(Number.isFinite(expiry), 'creation timestamp and TTL must define expiry');
    const before = await adapter.listByType('raw', { stale: true, now: expiry - 1 });
    const at = await adapter.listByType('raw', { stale: true, now: expiry });
    assert.equal(before.length, 0);
    assert.equal(at.length, 1);
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
        const actual = reference(values, expected.ref);
        if (Object.hasOwn(expected, 'equals')) assert.deepEqual(actual, resolve(expected.equals, values));
        if (Object.hasOwn(expected, 'length')) assert.equal(actual?.length, expected.length);
      }
    } catch (error) { failure = error; }
    try { await harness?.dispose?.(); } catch (error) { failure ??= error; }
    results.push({ id: vector.id, passed: !failure, ...(failure ? { error: failure.message } : {}) });
  }
  return { passed: results.every((result) => result.passed), results };
}
