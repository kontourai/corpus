import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { initializeRootBinding, standaloneFileMutationLock } from '../src/index.js';
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
    // The documented exception: the host-chosen coordination directory, outside the root.
    expect(readdirSync(base).sort()).toEqual(['coordination', 'store']);
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
    expect(existsSync(join(root, 'graph-index.json'))).toBe(true);
    expect(existsSync(join(root, 'alias-index.json'))).toBe(true);
    expect((await open().get(id))?.title).toBe('First');
  });

  test('a root that does not exist yet is created with only its identity marker, and that is a stated contract', async () => {
    // Root binding is a synchronous identity (path plus a random marker) captured at
    // construction, so a missing root cannot be deferred. A host whose dry run must
    // create nothing must not construct the store over a missing root.
    const missing = join(base, 'not-yet');
    const open2 = () =>
      new KitDefaultStoreAdapter({
        storeRoot: missing,
        lock: standaloneFileMutationLock,
        coordinationIdentity: () => () => {},
        coordinationDirectory: join(base, 'coordination'),
      });
    const first = open2();
    expect(readdirSync(missing)).toEqual(['.corpus-root-id']);
    expect(await first.get('missing')).toBeNull();
    expect(await first.listByType('raw')).toEqual([]);
    expect(readdirSync(missing)).toEqual(['.corpus-root-id']);
    expect(open2().rootBinding()).toBe(first.rootBinding());
  });

  test('write paths on a fresh root with no records/ create what they need', async () => {
    // Previews need a bound root; initialization writes only the identity marker.
    await initializeRootBinding({
      storeRoot: root,
      lock: standaloneFileMutationLock,
      coordinationIdentity: () => () => {},
      coordinationDirectory: join(base, 'coordination'),
    });
    expect(readdirSync(root)).toEqual(['.corpus-root-id']);
    const store = open();
    const evidence = { agent: 'test' };
    const input = (id: string) => ({
      id,
      type: 'raw' as const,
      title: id,
      body: 'Body',
      category: 'engineering',
      provenance: { agent: 'test' },
    });

    // Refused writes and previews against a root with no records leave it empty.
    await expect(store.link('absent', [{ target_id: 'other', kind: 'related' }], evidence)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(store.previewPurge(['absent'])).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(existsSync(join(root, 'records'))).toBe(false);

    // Staging a proposal needs no record, so it must not create records/.
    const proposalId = await store.proposeCreate(input('proposed'), 'agent-a', { agent: 'agent-a', proposal: 'keep it' });
    expect((await store.getProposal(proposalId))?.state).toBe('pending');
    expect(existsSync(join(root, 'records'))).toBe(false);

    // Applying it is the first record write and creates records/ and the indexes.
    expect(await store.applyCreate(proposalId, 'reviewer')).toBe('proposed');
    expect(existsSync(join(root, 'records', 'proposed.md'))).toBe(true);

    // link on the now-populated store, then a preview over real records.
    await store.create(input('target'));
    await store.link('proposed', [{ target_id: 'target', kind: 'related' }], evidence);
    expect((await store.getLinks('target')).reverse).toEqual([{ source_id: 'proposed', kind: 'related' }]);
    expect(existsSync(join(root, 'graph-index.json'))).toBe(true);
    expect(existsSync(join(root, 'alias-index.json'))).toBe(true);
    await expect(store.previewPurge(['proposed'])).resolves.toBeTruthy();
  });
});
