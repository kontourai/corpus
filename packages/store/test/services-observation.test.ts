import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, readdirSync, lstatSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { KitDefaultStoreAdapter, standaloneFileMutationLock } from '../src/index.js';
import { observeExactKnowledgeRecordFile, KnowledgeObservationRefusal } from '../src/observation.js';
const roots: string[] = [];
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'corpus-services-')));
  roots.push(base);
  return { root: join(base, 'records-root'), coordination: join(base, 'coordination') };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const input = { type: 'raw' as const, title: 'Injected', body: 'Source body', category: 'engineering', provenance: { agent: 'test' } };
test('uses injected lock, clock, IDs and non-authoritative observers through public mutations', async () => {
  const { root, coordination } = fixture();
  const acquired: string[] = [];
  let releases = 0;
  let ids = 0;
  let warnings = 0;
  const outcomes: string[] = [];
  const store = new KitDefaultStoreAdapter({
    storeRoot: root, coordinationDirectory: coordination,
    coordinationIdentity: () => () => {},
    lock(path) { acquired.push(path); return () => { releases++; }; },
    clock: () => Date.parse('2026-01-01T00:00:00.000Z'),
    ids: () => `injected-${ids++}`,
    diagnostics: { warn() { warnings++; throw new Error('diagnostics failure'); } },
    transactionObserver(operation, outcome) { outcomes.push(`${operation}:${outcome}`); throw new Error('observer failure'); },
  });
  const id = await store.create(input);
  expect(id).toMatch(/^injected-/);
  expect((await store.get(id))?.created_at).toBe('2026-01-01T00:00:00.000Z');
  writeFileSync(join(root, 'alias-index.json'), '{corrupt');
  expect((await store.get(id))?.body).toBe('Source body');
  expect(warnings).toBeGreaterThan(0);
  expect(outcomes).toContain('create:applied');
  expect(releases).toBe(acquired.length);
  expect(acquired.every((path) => path.startsWith(coordination + '/'))).toBe(true);
});
test('exact observation is construction-free, refuses writer artifacts and detects byte replacement', async () => {
  const { root, coordination } = fixture();
  const store = new KitDefaultStoreAdapter({ storeRoot: root, coordinationDirectory: coordination, coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock });
  const id = await store.create({ ...input, id: 'observed-record' });
  const beforeRoot = readdirSync(root).sort();
  const beforeCoordination = readdirSync(coordination).sort();
  const observed = observeExactKnowledgeRecordFile(root, coordination, id, () => () => {});
  expect(observed.file).not.toBeNull();
  observed.recheck();
  expect(readdirSync(root).sort()).toEqual(beforeRoot);
  expect(readdirSync(coordination).sort()).toEqual(beforeCoordination);
  const journal = join(root, '.station-knowledge-transaction.json');
  writeFileSync(journal, '{}');
  expect(() => observeExactKnowledgeRecordFile(root, coordination, id, () => () => {})).toThrow(KnowledgeObservationRefusal);
  rmSync(journal);
  const info = lstatSync(root);
  const hash = createHash('sha256').update(`${realpathSync(root)}\0${info.dev}\0${info.ino}`).digest('hex');
  const lock = join(coordination, `${hash}.lock`);
  mkdirSync(lock);
  expect(() => observeExactKnowledgeRecordFile(root, coordination, id, () => () => {})).toThrow(KnowledgeObservationRefusal);
  rmSync(lock, { recursive: true });
  const path = join(root, 'records', `${id}.md`);
  writeFileSync(path, readFileSync(path, 'utf8') + '\nexternal edit');
  expect(observed.recheck).toThrow(KnowledgeObservationRefusal);
  expect(existsSync(journal)).toBe(false);
});
