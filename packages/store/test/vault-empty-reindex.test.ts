import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { KitObsidianStoreAdapter, standaloneFileMutationLock } from '../src/index.js';

const input = (id: string) => ({
  id,
  type: 'raw' as const,
  title: `Record ${id}`,
  body: 'Users stall at account setup.',
  category: 'engineering',
  provenance: { agent: 'tester' },
});

/** kontourai/corpus#43: `reindex()` on a vault with no records left it unopenable. */
describe('reindex on a vault with no records', () => {
  let base: string;
  let root: string;
  const open = (): KitObsidianStoreAdapter => new KitObsidianStoreAdapter({
    storeRoot: root,
    coordinationDirectory: join(base, 'coordination'),
    coordinationIdentity: () => () => {},
    lock: standaloneFileMutationLock,
  });
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'corpus-empty-reindex-'));
    root = join(base, 'store');
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  test('writes the empty path index, so the vault stays openable and accepts a create', async () => {
    const vault = open();
    expect(await vault.reindex()).toMatchObject({ records: 0, links: 0 });
    expect(existsSync(join(root, 'graph-index.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, 'path-index.json'), 'utf8'))).toEqual({ by_id: {}, by_path: {} });
    // A second handle sees only what is on disk.
    const reopened = open();
    expect(await reopened.reindex()).toMatchObject({ records: 0 });
    expect(await reopened.create(input('first'))).toBe('first');
    expect((await reopened.get('first'))?.title).toBe('Record first');
  });

  test('a vault holding only a pending proposal stays openable after reindex', async () => {
    const vault = open();
    const proposal = await vault.proposeCreate(input('proposed'), 'proposer', { agent: 'distiller', proposal: 'add it' });
    await vault.reindex();
    expect(await vault.applyCreate(proposal, 'reviewer')).toBe('proposed');
    expect((await vault.get('proposed'))?.id).toBe('proposed');
  });

  test('reindex leaves an existing path index byte for byte alone', async () => {
    const vault = open();
    await vault.create(input('kept'));
    const before = readFileSync(join(root, 'path-index.json'));
    await vault.reindex();
    expect(readFileSync(join(root, 'path-index.json')).equals(before)).toBe(true);
  });
});
