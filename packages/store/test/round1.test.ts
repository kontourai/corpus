import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { KitDefaultStoreAdapter, KitObsidianStoreAdapter, standaloneFileMutationLock } from '../src/index.js';
import { observeExactKnowledgeRecordFile, observeDirectoryChain, KnowledgeObservationRefusal } from '../src/observation.js';
import { KnowledgeStoreCorruptionError } from '../src/errors.js';
const roots: string[] = [];
function setup(Constructor: typeof KitDefaultStoreAdapter | typeof KitObsidianStoreAdapter) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'corpus-round1-'))); roots.push(base);
  const root = join(base, 'store');
  const coordinationDirectory = join(base, 'coordination');
  return { base, root, coordinationDirectory, store: new Constructor({ storeRoot: root, coordinationDirectory, coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock }) };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const input = { id: 'round1-record', type: 'concept' as const, title: 'Record', body: 'Body', category: 'engineering', provenance: { agent: 'test' } };
function path(profile: string, root: string, id: string): string {
  return profile === 'default' ? join(root, 'records', `${id}.md`) : join(root, JSON.parse(readFileSync(join(root, 'path-index.json'), 'utf8')).by_id[id].path);
}
for (const [profile, Constructor] of [['default', KitDefaultStoreAdapter], ['vault', KitObsidianStoreAdapter]] as const) {
  describe(`${profile} round-1 public adapter regressions`, () => {
    for (const [source, value] of [['1.10', '1.10'], ['-', '-'], ['3', 3], ['true', true], ['null', null]] as const) {
      test(`reads and re-reads unchanged unknown ${source}`, async () => {
        const { store, root } = setup(Constructor);
        await store.create(input);
        const file = path(profile, root, input.id);
        const extension = `future: ${source} # original extension\nnested_future: { value: ${source === '-' ? '"-"' : source} }\n`;
        const original = readFileSync(file, 'utf8');
        writeFileSync(file, original.replace('\n---\n', `\n${extension}---\n`));
        const read = await store.get(input.id) as unknown as Record<string, unknown>;
        expect(read.future).toBe(value);
        expect(read.nested_future).toEqual({ value });
        await store.update(input.id, { title: 'Changed title' }, { agent: 'editor' });
        const rewritten = readFileSync(path(profile, root, input.id), 'utf8');
        if (source === '1.10') expect(rewritten).toContain('future: 1.10\n');
        expect((await store.get(input.id) as unknown as Record<string, unknown>).nested_future).toEqual({ value });
        expect((await store.get(input.id) as unknown as Record<string, unknown>).future).toBe(value);
      });
    }
    test('retains unknown nested log fields when appending mutation evidence', async () => {
      const { store, root } = setup(Constructor);
      await store.create(input);
      await store.update(input.id, { title: 'First' }, { agent: 'editor' });
      const file = path(profile, root, input.id);
      writeFileSync(file, readFileSync(file, 'utf8').replace('    evidence:\n', '    future_count: 1.10 # keep log token\n    evidence:\n'));
      await store.update(input.id, { title: 'Second' }, { agent: 'editor' });
      expect((await store.get(input.id))?.mutation_log?.[0].future_count).toBe('1.10');
    });
    test('supersede evidence is numeric on read and subsequent rewrite', async () => {
      const { store, root } = setup(Constructor);
      const old = await store.create({ ...input, id: 'older-record' });
      const replacement = await store.create({ ...input, id: 'newer-record', title: 'Newer' });
      await store.supersede(replacement, [old], { agent: 'editor', rationale: 'New evidence' });
      expect((await store.get(replacement))?.mutation_log?.[0].evidence?.superseded_count).toBe(1);
      await store.update(replacement, { tags: ['changed'] }, { agent: 'editor' });
      expect(readFileSync(path(profile, root, replacement), 'utf8')).toContain('      superseded_count: 1\n');
      expect(readFileSync(path(profile, root, replacement), 'utf8')).not.toContain("superseded_count: '1'");
    });
    test('quoted numeric TTL remains corruption as in Station', async () => {
      const { store, root } = setup(Constructor);
      await store.create({ ...input, ttl_seconds: 60 });
      const file = path(profile, root, input.id);
      writeFileSync(file, readFileSync(file, 'utf8').replace('ttl_seconds: 60', "ttl_seconds: '60'"));
      await expect(store.get(input.id)).rejects.toBeInstanceOf(KnowledgeStoreCorruptionError);
    });
    test('requires an explicit lock and absolute coordination directory', () => {
      const { root, coordinationDirectory } = setup(Constructor);
      expect(() => new Constructor({ storeRoot: root } as never)).toThrow(/Explicit lock/);
      expect(() => new Constructor({ storeRoot: root, coordinationDirectory } as never)).toThrow(/Explicit lock/);
      expect(() => new Constructor({ storeRoot: root, coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock } as never)).toThrow(/Explicit absolute coordinationDirectory/);
    });
    test('keeps the internal transaction engine out of enumerable adapter properties', () => {
      const { store } = setup(Constructor);
      expect(Object.keys(store)).not.toContain('files');
      expect(JSON.stringify(store)).not.toContain('"files"');
    });
  });
}
test('coordination identity refuses runtime-home changes and strict-home symlink substitution', async () => {
  const { store, root, base, coordinationDirectory } = setup(KitDefaultStoreAdapter);
  await store.create(input);
  let runtimeHome = base;
  const identity = () => {
    const capturedHome = runtimeHome;
    const recheckHome = observeDirectoryChain(capturedHome);
    return () => {
      if (runtimeHome !== capturedHome) throw new KnowledgeObservationRefusal('unavailable');
      recheckHome();
    };
  };
  const bound = new KitDefaultStoreAdapter({ storeRoot: root, coordinationDirectory, lock: standaloneFileMutationLock, coordinationIdentity: identity });
  const observed = observeExactKnowledgeRecordFile(root, coordinationDirectory, input.id, identity);
  runtimeHome = `${base}-other`;
  expect(observed.recheck).toThrow(KnowledgeObservationRefusal);
  await expect(bound.get(input.id)).rejects.toThrow();
  runtimeHome = base;
  const oldHome = `${base}-moved`; roots.push(oldHome);
  renameSync(base, oldHome); symlinkSync(oldHome, base);
  expect(observed.recheck).toThrow(KnowledgeObservationRefusal);
  expect(() => observeExactKnowledgeRecordFile(join(oldHome, 'store'), join(oldHome, 'coordination'), input.id, identity)).toThrow(KnowledgeObservationRefusal);
});
