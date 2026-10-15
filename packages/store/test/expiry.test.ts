import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  KitDefaultStoreAdapter,
  KitObsidianStoreAdapter,
  standaloneFileMutationLock,
} from '../src/index.js';

// One expiry rule (owner decision, 2026-10-13): explicit expires_at wins, otherwise
// created_at + ttl_seconds; the TTL anchor is creation, and expiry is inclusive.
const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const TTL = 60;
const EXPIRY = T0 + TTL * 1000;

for (const [profile, Constructor] of [
  ['default', KitDefaultStoreAdapter],
  ['vault', KitObsidianStoreAdapter],
] as const) {
  describe(`${profile}: record expiry and the stale filter`, () => {
    const roots: string[] = [];
    afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
    function open() {
      const root = mkdtempSync(join(tmpdir(), `corpus-expiry-${profile}-`));
      roots.push(root);
      const clock = { now: T0 };
      const store = new Constructor({
        storeRoot: join(root, 'store'),
        coordinationDirectory: join(root, 'coordination'),
        coordinationIdentity: () => () => {},
        lock: standaloneFileMutationLock,
        clock: () => clock.now,
      });
      return { store, clock };
    }
    const raw = (title: string, fields: Record<string, unknown> = {}) => ({
      type: 'raw' as const, title, body: `${title} body`, category: 'expiry', provenance: { agent: 'tester' }, ...fields,
    });
    const ids = (records: { id: string }[]) => records.map((r) => r.id).sort();

    test('the TTL anchors at creation and an update never extends it', async () => {
      const { store, clock } = open();
      const id = await store.create(raw('ttl', { ttl_seconds: TTL }));
      clock.now = T0 + 30_000;
      await store.update(id, { body: 'edited later' }, { agent: 'tester' });
      const record = await store.get(id);
      expect(Date.parse(record!.updated_at)).toBe(T0 + 30_000);
      expect(record!.created_at).toBe(new Date(T0).toISOString());
      // Evaluated through the injected clock (no `now` option).
      clock.now = EXPIRY - 1;
      expect(await store.listByType('raw', { stale: true })).toEqual([]);
      expect(ids(await store.listByType('raw', { stale: false }))).toEqual([id]);
      clock.now = EXPIRY;
      expect(ids(await store.listByType('raw', { stale: true }))).toEqual([id]);
      expect(await store.listByType('raw', { stale: false })).toEqual([]);
      // An explicit `now` overrides the clock.
      expect(await store.listByType('raw', { stale: true, now: EXPIRY - 1 })).toEqual([]);
      expect(ids(await store.listByCategory('expiry', { stale: true, now: EXPIRY }))).toEqual([id]);
    });

    test('explicit expires_at takes precedence over the TTL, and clearing it restores the TTL', async () => {
      const { store } = open();
      const later = '2030-01-01T00:00:00.000Z';
      const id = await store.create(raw('both', { ttl_seconds: TTL, expires_at: later }));
      expect(await store.listByType('raw', { stale: true, now: EXPIRY })).toEqual([]);
      expect(await store.listByType('raw', { stale: true, now: Date.parse(later) - 1 })).toEqual([]);
      expect(ids(await store.listByType('raw', { stale: true, now: Date.parse(later) }))).toEqual([id]);
      await store.update(id, { expires_at: null }, { agent: 'tester' });
      expect(ids(await store.listByType('raw', { stale: true, now: EXPIRY }))).toEqual([id]);
    });

    test('a record with no expiry never goes stale, and no stale option means no expiry filter', async () => {
      const { store } = open();
      const forever = await store.create(raw('forever'));
      const short = await store.create(raw('short', { ttl_seconds: 1 }));
      const far = Number.MAX_SAFE_INTEGER;
      expect(ids(await store.listByType('raw', { stale: true, now: far }))).toEqual([short]);
      expect(ids(await store.listByType('raw', { stale: false, now: far }))).toEqual([forever]);
      expect(ids(await store.listByType('raw', { now: far }))).toEqual([forever, short].sort());
    });

    test('the stale filter composes with the working set', async () => {
      const { store } = open();
      const id = await store.create(raw('retired', { ttl_seconds: 1 }));
      await store.retire(id, 'retired', { agent: 'tester', rationale: 'obsolete' });
      expect(await store.listByType('raw', { stale: true, now: EXPIRY })).toEqual([]);
      expect(ids(await store.listByType('raw', { stale: true, now: EXPIRY, includeHistory: true }))).toEqual([id]);
    });

    test('malformed stale or now options are refused, not ignored', async () => {
      const { store } = open();
      await store.create(raw('any', { ttl_seconds: TTL }));
      for (const options of [{ stale: 'yes' }, { stale: true, now: Number.NaN }, { stale: true, now: '0' }, { now: Infinity }]) {
        await expect(store.listByType('raw', options as never)).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });
        await expect(store.listByCategory('expiry', options as never)).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });
      }
    });
  });
}
