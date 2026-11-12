import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { standaloneFileMutationLock } from '../src/index.js';
import { KitDefaultStoreAdapter } from '../src/default-store.js';

// A host's dry run (for example the Knowledge kit's `dream --dry-run`) promises
// to create nothing, so constructing and reading the store must not touch disk.
describe('KitDefaultStoreAdapter lazy records directory', () => {
  let base: string;
  let root: string;
  const open = () =>
    new KitDefaultStoreAdapter({
      storeRoot: root,
      lock: standaloneFileMutationLock,
      coordinationIdentity: () => () => {},
      coordinationDirectory: join(base, 'coordination'),
    });

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'lazy-records-'));
    root = join(base, 'store');
    // An existing, empty root, as a host that provisions the directory leaves it.
    mkdirSync(root);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  test('construction and read-only calls leave an empty root empty', async () => {
    const store = open();
    expect(readdirSync(root)).toEqual([]);
    expect(await store.get('missing')).toBeNull();
    expect(await store.listByType('raw')).toEqual([]);
    expect(await store.listByCategory('engineering')).toEqual([]);
    expect(await store.listProposals()).toEqual([]);
    expect(readdirSync(root)).toEqual([]);
  });

  test('the first write still creates records/ and the record is readable', async () => {
    const store = open();
    expect(existsSync(join(root, 'records'))).toBe(false);
    const id = await store.create({
      type: 'raw',
      title: 'First',
      body: 'Body',
      category: 'engineering',
      provenance: { agent: 'test' },
    });
    expect(statSync(join(root, 'records')).isDirectory()).toBe(true);
    expect(existsSync(join(root, 'records', `${id}.md`))).toBe(true);
    expect((await open().get(id))?.title).toBe('First');
  });
});
