/**
 * Purge (owner decision, 2026-11-02), beyond the conformance vectors: the default-deny
 * switch, the exact stored tombstone shape, vault paths and rendered links, log
 * scrubbing, atomic refusal, codec round trips, and recovery. Both profiles run every
 * test, because a guarantee that holds for one adapter only is not the contract.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  KitDefaultStoreAdapter,
  KitObsidianStoreAdapter,
  standaloneFileMutationLock,
  type KnowledgeStoreAdapter,
  type KnowledgeStorePurger,
} from '../src/index.js';

type Store = KnowledgeStoreAdapter & KnowledgeStorePurger & { reindex(): Promise<unknown> };
const evidence = { agent: 'privacy-officer', rationale: 'erasure request 42' };

function open(profile: 'default' | 'vault', root: string, options: Record<string, unknown> = {}): Store {
  const Constructor = profile === 'default' ? KitDefaultStoreAdapter : KitObsidianStoreAdapter;
  return new Constructor({
    storeRoot: root,
    coordinationDirectory: join(dirname(root), 'coordination'),
    coordinationIdentity: () => () => {},
    lock: standaloneFileMutationLock,
    allowPurge: true,
    ...options,
  }) as unknown as Store;
}

function files(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else result[relative(root, path)] = readFileSync(path, 'utf8');
    }
  };
  walk(root);
  return result;
}

function frontmatter(text: string): Record<string, unknown> {
  return load(text.slice(4, text.indexOf('\n---\n', 4))) as Record<string, unknown>;
}

describe.each(['default', 'vault'] as const)('purge — %s profile', (profile) => {
  let base: string;
  let root: string;
  let store: Store;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), `corpus-purge-${profile}-`));
    root = join(base, 'store');
    store = open(profile, root);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const raw = (id: string, extra: Record<string, unknown> = {}) =>
    store.create({ id, type: 'raw', title: `title of ${id}`, body: `body of ${id}`, category: 'engineering', provenance: { agent: 'creator' }, ...extra });
  const compiled = (id: string, sources: string[], extra: Record<string, unknown> = {}) =>
    store.create({ id, type: 'compiled', title: `title of ${id}`, body: `body of ${id}`, category: 'engineering', provenance: { agent: 'creator' }, links: sources.map((target_id) => ({ target_id, kind: 'source' })), ...extra });

  test('is refused without allowPurge, before any write or journal', async () => {
    await raw('guarded');
    const before = files(root);
    for (const options of [{ allowPurge: undefined }, { allowPurge: false }]) {
      const closed = open(profile, root, options);
      await expect(closed.purge(['guarded'], evidence)).rejects.toMatchObject({ code: 'READ_ONLY' });
    }
    expect(files(root)).toEqual(before);
    expect((await store.get('guarded'))?.status).toBe('active');
  });

  test('stores exactly the tombstone shape and no digest of the content', async () => {
    await raw('shape', { title: 'Secret Title', body: 'Secret body', tags: ['t'], aliases: ['team/secret'], ttl_seconds: 60, provenance: { agent: 'creator', session_id: 's1', note: 'Secret note' } });
    await raw('other');
    await store.link('shape', [{ target_id: 'other', kind: 'related', label: 'Secret label' }], { agent: 'editor', note: 'Secret edit note' });
    await store.purge(['shape'], { ...evidence, note: 'ticket 7' });

    const stored = Object.entries(files(root)).find(([path]) => path.endsWith('.md') && frontmatter(readFileSync(join(root, path), 'utf8')).id === 'shape');
    expect(stored).toBeDefined();
    const meta = frontmatter(stored![1]);
    expect(Object.keys(meta).sort()).toEqual(['category', 'created_at', 'id', 'links', 'mutation_log', 'provenance', 'status', 'title', 'type', 'updated_at']);
    expect(meta).toMatchObject({ id: 'shape', type: 'raw', category: 'purged', status: 'purged', title: '[purged]' });
    expect(meta.provenance).toEqual({ agent: 'creator', session_id: 's1' });
    expect(meta.links).toEqual([{ target_id: 'other', kind: 'related' }]);
    expect(meta.mutation_log).toEqual([
      { op: 'link', at: expect.any(String), agent: 'editor' },
      { op: 'purged', at: expect.any(String), agent: 'privacy-officer', rationale: 'erasure request 42', note: 'ticket 7', evidence: { cause: 'requested' } },
    ]);
    expect(stored![1].split('\n---\n')[1].trim()).toBe('');
    for (const text of Object.values(files(root))) {
      for (const secret of ['Secret Title', 'Secret body', 'Secret note', 'Secret label', 'Secret edit note', 'team/secret']) expect(text).not.toContain(secret);
    }
  });

  test('reduces earlier log entries to who, what and when, and keeps identities', async () => {
    await raw('old');
    await raw('new', { title: 'replacement' });
    await store.update('old', { tags: ['x'] }, { agent: 'editor', note: 'Secret update note' });
    await store.supersede('new', ['old'], { agent: 'editor', rationale: 'Secret supersede rationale' });
    await store.purge(['old'], evidence);
    const log = (await store.get('old'))!.mutation_log!;
    expect(log.map((entry) => entry.op)).toEqual(['update', 'superseded-by', 'purged']);
    expect(log[0]).toEqual({ op: 'update', at: expect.any(String), agent: 'editor', evidence: { fields: ['tags'] } });
    expect(log[1]).toEqual({ op: 'superseded-by', at: expect.any(String), agent: 'editor', new_id: 'new', evidence: { superseded_by_id: 'new' } });
    expect(JSON.stringify(log)).not.toContain('Secret');
    // The superseding record keeps its own log, which is not erased content.
    expect((await store.get('new'))!.mutation_log!.map((entry) => entry.op)).toEqual(['supersede', 'reference-purged']);
  });

  test('a bad request writes nothing, even when one of several ids is valid', async () => {
    await raw('present');
    const before = files(root);
    await expect(store.purge(['present', 'absent'], evidence)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(store.purge(['present'], { agent: 'privacy-officer', rationale: '' })).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });
    await expect(store.purge('present' as unknown as string[], evidence)).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });
    await expect(store.purge([42 as unknown as string], evidence)).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });
    expect(files(root)).toEqual(before);
  });

  test('reports ids in a stable order and counts a duplicate request once', async () => {
    await raw('b-source');
    await raw('a-source');
    await compiled('z-child', ['a-source']);
    await compiled('m-child', ['a-source']);
    const result = await store.purge(['b-source', 'a-source', 'b-source'], evidence);
    expect(result).toEqual({ purged: ['b-source', 'a-source'], cascaded: ['m-child', 'z-child'], survivors: [], referrers: [], alreadyPurged: [] });
  });

  test('a record whose support was purged earlier cascades with the last support', async () => {
    await raw('s1');
    await raw('s2');
    await compiled('c', ['s1', 's2']);
    expect((await store.purge(['s1'], evidence)).survivors).toEqual(['c']);
    expect((await store.get('c'))?.status).toBe('active');
    expect((await store.purge(['s2'], evidence)).cascaded).toEqual(['c']);
    expect((await store.get('c'))?.status).toBe('purged');
  });

  test('records that only support each other do not keep erased content alive', async () => {
    await raw('root');
    await store.create({ id: 'x', type: 'concept', title: 'x', body: 'x', category: 'engineering', provenance: { agent: 'creator', source_ids: ['root'] } });
    await store.create({ id: 'y', type: 'concept', title: 'y', body: 'y', category: 'engineering', provenance: { agent: 'creator', source_ids: ['x'] } });
    // x now rests on root and on y, and y rests on x: a cycle.
    await store.link('x', [{ target_id: 'y', kind: 'source' }], { agent: 'editor' });
    const result = await store.purge(['root'], evidence);
    expect(result.cascaded).toEqual(['x', 'y']);
    expect(result.survivors).toEqual([]);
    expect((await store.get('y'))?.status).toBe('purged');
  });

  test('an island that was already ungrounded is not swept up by an unrelated purge', async () => {
    await raw('root');
    await store.create({ id: 'p', type: 'concept', title: 'p', body: 'p', category: 'engineering', provenance: { agent: 'creator' } });
    await store.create({ id: 'q', type: 'concept', title: 'q', body: 'q', category: 'engineering', provenance: { agent: 'creator', source_ids: ['p'] } });
    // p rests on q and q rests on p, and neither rests on anything else.
    await store.link('p', [{ target_id: 'q', kind: 'source' }], { agent: 'editor' });
    const result = await store.purge(['root'], evidence);
    expect(result.cascaded).toEqual([]);
    expect((await store.get('p'))?.status).toBe('active');
    expect((await store.get('q'))?.status).toBe('active');
  });

  test('records resting on a purged member of a support cycle are erased with it', async () => {
    await store.create({ id: 'p', type: 'concept', title: 'p', body: 'p', category: 'engineering', provenance: { agent: 'creator' } });
    await store.create({ id: 'q', type: 'concept', title: 'q', body: 'q', category: 'engineering', provenance: { agent: 'creator', source_ids: ['p'] } });
    await store.link('p', [{ target_id: 'q', kind: 'source' }], { agent: 'editor' });
    await store.create({ id: 'r', type: 'concept', title: 'r', body: 'r', category: 'engineering', provenance: { agent: 'creator', source_ids: ['q'] } });
    const result = await store.purge(['p'], evidence);
    expect(result).toMatchObject({ cascaded: ['q', 'r'], survivors: [] });
  });

  test('a record with a live supporter outside the purge keeps it, even when that supporter is in an older cycle', async () => {
    await raw('root');
    await store.create({ id: 'x', type: 'concept', title: 'x', body: 'x', category: 'engineering', provenance: { agent: 'creator' } });
    await store.create({ id: 'y', type: 'concept', title: 'y', body: 'y', category: 'engineering', provenance: { agent: 'creator', source_ids: ['x'] } });
    await store.link('x', [{ target_id: 'y', kind: 'source' }], { agent: 'editor' });
    await store.create({ id: 'b', type: 'concept', title: 'b', body: 'b', category: 'engineering', provenance: { agent: 'creator', source_ids: ['root', 'x'] } });
    const result = await store.purge(['root'], evidence);
    expect(result).toMatchObject({ cascaded: [], survivors: ['b'] });
    expect((await store.get('x'))?.status).toBe('active');
  });

  test('survivor links keep their support but lose labels that name an erased record', async () => {
    await raw('s1');
    await raw('s2');
    await compiled('c', ['s1', 's2']);
    await store.link('c', [{ target_id: 's1', kind: 'related', label: 'Erased Title' }, { target_id: 's2', kind: 'related', label: 'Kept label' }], { agent: 'editor' });
    await store.purge(['s1'], evidence);
    const survivor = (await store.get('c'))!;
    expect(survivor.links).toEqual([
      { target_id: 's1', kind: 'source' },
      { target_id: 's2', kind: 'source' },
      { target_id: 's1', kind: 'related' },
      { target_id: 's2', kind: 'related', label: 'Kept label' },
    ]);
    expect(JSON.stringify(await store.getLinks('c'))).not.toContain('Erased Title');
    expect(Object.values(files(root)).join('\n')).not.toContain('Erased Title');
  });

  test('ids that look like numbers or booleans round-trip as strings in the log', async () => {
    await raw('1.10');
    await raw('true');
    await store.create({ id: 'both', type: 'concept', title: 'both', body: 'both', category: 'engineering', provenance: { agent: 'creator', source_ids: ['1.10', 'true'] } });
    await store.create({ id: 'keeps', type: 'concept', title: 'keeps', body: 'keeps', category: 'engineering', provenance: { agent: 'creator', source_ids: ['1.10', 'external'] } });
    await store.purge(['1.10', 'true'], evidence);
    // A fresh adapter reads the files, not any cache.
    const reopened = open(profile, root);
    const both = (await reopened.get('both'))!;
    expect(both.mutation_log![0].evidence).toEqual({ cause: 'sole-support-purged', via: ['1.10', 'true'] });
    expect((await reopened.get('keeps'))!.mutation_log![0].evidence).toEqual({ purged_ids: ['1.10'] });
  });

  test('purge is a terminal status: retire cannot move it and reads stay stable across a reopen', async () => {
    await raw('gone');
    await store.purge(['gone'], evidence);
    const first = await store.get('gone');
    const reopened = open(profile, root);
    expect(await reopened.get('gone')).toEqual(first);
    await expect(reopened.retire('gone', 'retired', { agent: 'editor', rationale: 'again' })).rejects.toMatchObject({ code: 'PURGED' });
    expect(await reopened.get('gone')).toEqual(first);
  });

  test('refuses evidence of the wrong runtime type before writing anything', async () => {
    await raw('typed');
    const before = files(root);
    for (const bad of [{ agent: { x: 1 }, rationale: 'r' }, { agent: 'a', rationale: 5 }, { agent: 'a', rationale: 'r', note: { y: 1 } }, { agent: '  ', rationale: 'r' }]) {
      await expect(store.purge(['typed'], bad as never)).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });
    }
    expect(files(root)).toEqual(before);
  });

  test('allowPurge must be exactly true', async () => {
    await raw('strict');
    for (const value of ['false', 'true', 1, {}]) {
      await expect(open(profile, root, { allowPurge: value }).purge(['strict'], evidence)).rejects.toMatchObject({ code: 'READ_ONLY' });
    }
  });

  test('a journal temporary left by a crash is removed by the next locked operation, and other .tmp files are not', async () => {
    await raw('secret', { body: 'ORPHAN-NEEDLE' });
    const journal = JSON.stringify({ version: 1, transactionId: 't', operation: 'purge', phase: 'prepared', entries: [{ path: 'x.md', before: Buffer.from('ORPHAN-NEEDLE').toString('base64'), after: null }] });
    writeFileSync(join(root, '.crashed-journal.tmp'), journal);
    writeFileSync(join(root, '.someone-elses.tmp'), 'not a journal');
    await store.get('secret');
    expect(existsSync(join(root, '.crashed-journal.tmp'))).toBe(false);
    expect(existsSync(join(root, '.someone-elses.tmp'))).toBe(true);
  });

  test('a journal temporary cut short by a crash is removed too, and a foreign JSON file with similar keys is not', async () => {
    await raw('cut');
    const cut = `{"version":1,"transactionId":"t","operation":"purge","phase":"prepared","entries":[{"path":"x.md","before":"${Buffer.from('CUT-NEEDLE').toString('base64')}`;
    writeFileSync(join(root, '.cut.tmp'), cut);
    const foreign = '{"version":1,"transactionId":"foreign-work","entries":[],"application":"not a store journal"}';
    writeFileSync(join(root, '.foreign.tmp'), foreign);
    await store.get('cut');
    expect(existsSync(join(root, '.cut.tmp'))).toBe(false);
    expect(readFileSync(join(root, '.foreign.tmp'), 'utf8')).toBe(foreign);
  });

  test.each([
    ['escaped quotes', 'tx"quoted"id', 'op"erat\\ion'],
    ['newlines and unicode', 'tx\nid-\u2028-é', 'purge\r\n'],
    ['a very long id and operation', 'x'.repeat(5000), 'o'.repeat(3000)],
  ])('every cut of a journal with %s is recognised as a journal temporary', async (_name, transactionId, operation) => {
    await raw('recognised');
    const full = JSON.stringify({ version: 1, transactionId, operation, phase: 'prepared', entries: [{ path: 'x.md', before: Buffer.from('ENTRY-NEEDLE').toString('base64'), after: null }] });
    const header = full.indexOf('"entries":[') + '"entries":['.length;
    for (const length of [header, header + 20, full.length - 1, full.length]) {
      writeFileSync(join(root, '.cut.tmp'), full.slice(0, length));
      await store.get('recognised');
      expect(existsSync(join(root, '.cut.tmp'))).toBe(false);
    }
  });

  test('a multi-megabyte journal header is recognised, and a foreign file with an unterminated string never blocks the store', async () => {
    await raw('big');
    const long = 'x'.repeat(16 * 1024 * 1024);
    const journal = JSON.stringify({ version: 1, transactionId: long, operation: 'purge', phase: 'prepared', entries: [{ path: 'x.md', before: Buffer.from('BIG-NEEDLE').toString('base64'), after: null }] });
    writeFileSync(join(root, '.big.tmp'), journal);
    const foreign = `{"version":1,"transactionId":"${long}`;
    writeFileSync(join(root, '.unterminated.tmp'), foreign);
    await store.get('big');
    expect(existsSync(join(root, '.big.tmp'))).toBe(false);
    expect(readFileSync(join(root, '.unterminated.tmp'), 'utf8')).toBe(foreign);
    await expect(store.get('big')).resolves.toMatchObject({ id: 'big' });
  });

  test('a journal temporary that cannot be removed fails the operation instead of being skipped', async () => {
    await raw('stuck');
    writeFileSync(join(root, '.stuck.tmp'), '{"version":1,"transactionId":"t","operation":"purge","phase":"prepared","entries":[]}');
    const hooked = open(profile, root) as unknown as { files: { hooks: { beforeFileReplace?: (path: string) => void } } } & Store;
    hooked.files.hooks.beforeFileReplace = (path) => { if (path.endsWith('.stuck.tmp')) throw new Error('permission denied'); };
    await expect(hooked.purge(['stuck'], evidence)).rejects.toThrow();
    expect((await open(profile, root).get('stuck'))?.status).toBe('active');
  });

  test('a purge whose commit marker cannot be written does not report success over a journal that holds erased content', async () => {
    await raw('doomed', { body: 'MARKER-NEEDLE' });
    const journalPath = join(root, '.station-knowledge-transaction.json');
    const hooked = open(profile, root) as unknown as { files: { hooks: { beforeFileReplace?: (path: string) => void } } } & Store;
    let writes = 0;
    hooked.files.hooks.beforeFileReplace = (path) => {
      if (path.endsWith('.station-knowledge-transaction.json') && ++writes === 2) throw new Error('disk full');
    };
    const result = await hooked.purge(['doomed'], evidence);
    expect(result.purged).toEqual(['doomed']);
    expect(existsSync(journalPath)).toBe(false);
  });

  test('reindex rebuilds the graph and aliases with the tombstone links and without its aliases', async () => {
    await raw('a', { aliases: ['team/a'] });
    await raw('b');
    await store.link('a', [{ target_id: 'b', kind: 'related' }], { agent: 'editor' });
    await store.purge(['a'], evidence);
    const before = await store.getLinks('b');
    await store.reindex();
    expect(await store.getLinks('b')).toEqual(before);
    expect((await store.getLinks('a')).forward).toEqual([{ target_id: 'b', kind: 'related' }]);
    expect(await store.get('team/a')).toBeNull();
  });
});

describe('purge — vault layout', () => {
  let base: string;
  let root: string;
  let store: Store;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'corpus-purge-vault-'));
    root = join(base, 'store');
    store = open('vault', root);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));
  const index = () => JSON.parse(readFileSync(join(root, 'path-index.json'), 'utf8')) as { by_id: Record<string, { path: string; archived: boolean }>; by_path: Record<string, string> };

  test('moves the tombstone to an id-derived archived path and removes the title from every path', async () => {
    await store.create({ id: 'src-1', type: 'raw', title: 'Zebra Quartz Memo', body: 'x', category: 'engineering.api', provenance: { agent: 'creator' } });
    await store.purge(['src-1'], evidence);
    expect(index().by_id['src-1']).toEqual({ path: 'archive/purged/src-1.md', archived: true });
    expect(index().by_path['archive/purged/src-1.md']).toBe('src-1');
    expect(Object.keys(files(root)).filter((path) => path.includes('zebra'))).toEqual([]);
    expect(existsSync(join(root, 'engineering'))).toBe(false); // the emptied category folders go too
  });

  test('derives a safe path for ids that are not lowercase path segments', async () => {
    for (const id of ['Mixed_ID-1.10', 'a b', 'ünï']) {
      await store.create({ id, type: 'raw', title: `t ${id}`, body: 'x', category: 'engineering', provenance: { agent: 'creator' } });
    }
    await store.purge(['Mixed_ID-1.10', 'a b', 'ünï'], evidence);
    for (const id of ['Mixed_ID-1.10', 'a b', 'ünï']) {
      expect(index().by_id[id].path).toMatch(/^archive\/purged\/id-[0-9a-f]{32}\.md$/);
      expect((await store.get(id))?.status).toBe('purged');
    }
    expect(new Set(Object.values(index().by_id).map((entry) => entry.path)).size).toBe(3);
  });

  test('purges a superseded (archived) record and an existing survivor note stops naming its title', async () => {
    await store.create({ id: 'raw-1', type: 'raw', title: 'Zebra Quartz Memo', body: 'x', category: 'engineering', provenance: { agent: 'creator' } });
    await store.create({ id: 'raw-2', type: 'raw', title: 'Second', body: 'y', category: 'engineering', provenance: { agent: 'creator' } });
    await store.create({ id: 'sum-1', type: 'compiled', title: 'Summary', body: 'z', category: 'engineering', provenance: { agent: 'creator' }, links: [{ target_id: 'raw-1', kind: 'source' }, { target_id: 'raw-2', kind: 'source' }] });
    await store.create({ id: 'sum-2', type: 'compiled', title: 'Newer summary', body: 'w', category: 'engineering', provenance: { agent: 'creator' }, links: [{ target_id: 'raw-2', kind: 'source' }] });
    await store.supersede('sum-2', ['sum-1'], { agent: 'editor', rationale: 'newer' });
    expect(index().by_id['sum-1'].archived).toBe(true);
    const note = (id: string) => readFileSync(join(root, index().by_id[id].path), 'utf8');
    expect(note('sum-1')).toContain('zebra-quartz-memo');
    await store.purge(['raw-1'], evidence);
    expect(note('sum-1')).not.toContain('zebra-quartz-memo');
    expect(note('sum-1')).toContain('[[raw-1]]');
    expect(note('sum-1')).toContain('second');
    expect((await store.get('sum-1'))).toMatchObject({ status: 'active', body: 'z' });
    await store.purge(['sum-1'], evidence);
    expect(index().by_id['sum-1']).toEqual({ path: 'archive/purged/sum-1.md', archived: true });
  });

  test('a tombstone has no category dimensions, and survivors keep theirs', async () => {
    const dimensional = open('vault', root, { dimensions: ['territory', 'customer'] });
    await dimensional.create({ id: 'src', type: 'raw', title: 's', body: 'x', category: 'sales.east.acme', provenance: { agent: 'creator' } });
    await dimensional.create({ id: 'kept', type: 'concept', title: 'k', body: 'k', category: 'sales.west.initech', provenance: { agent: 'creator' }, links: [{ target_id: 'src', kind: 'related' }] });
    await dimensional.purge(['src'], evidence);
    const tombstone = frontmatter(readFileSync(join(root, index().by_id.src.path), 'utf8'));
    expect(tombstone).not.toHaveProperty('territory');
    expect(tombstone).not.toHaveProperty('customer');
    expect(Object.values(files(root)).join('\n')).not.toContain('acme');
    expect(frontmatter(readFileSync(join(root, index().by_id.kept.path), 'utf8'))).toMatchObject({ territory: 'west', customer: 'initech' });
  });

  test('a hand-edited tombstone cannot serve content', async () => {
    await store.create({ id: 'src', type: 'raw', title: 's', body: 'x', category: 'engineering', provenance: { agent: 'creator' } });
    await store.purge(['src'], evidence);
    const path = join(root, index().by_id.src.path);
    writeFileSync(path, `${readFileSync(path, 'utf8')}\nsneaked content\n`);
    expect((await open('vault', root).get('src'))?.body).toBe('');
  });

  test('removes the emptied category folders, and only those', async () => {
    await store.create({ id: 'only', type: 'raw', title: 'Only', body: 'x', category: 'private.person-739', provenance: { agent: 'creator' } });
    await store.create({ id: 'kept', type: 'raw', title: 'Kept', body: 'x', category: 'private.other', provenance: { agent: 'creator' } });
    mkdirSync(join(root, 'unrelated-empty'));
    await store.purge(['only'], evidence);
    expect(existsSync(join(root, 'private', 'person-739'))).toBe(false);
    expect(existsSync(join(root, 'private', 'other'))).toBe(true);
    expect(existsSync(join(root, 'unrelated-empty'))).toBe(true);
  });

  test('does not follow a folder swapped for a symlink after publication when removing emptied folders', async () => {
    const { renameSync, symlinkSync } = await import('node:fs');
    await store.create({ id: 'only', type: 'raw', title: 'Only', body: 'x', category: 'private.person-739', provenance: { agent: 'creator' } });
    const outside = join(base, 'outside');
    mkdirSync(join(outside, 'person-739', 'sources'), { recursive: true });
    const hooked = open('vault', root) as unknown as { files: { hooks: { afterCommitMarker?: () => void } } } & Store;
    hooked.files.hooks.afterCommitMarker = () => {
      renameSync(join(root, 'private'), join(base, 'moved-private'));
      symlinkSync(outside, join(root, 'private'));
    };
    await hooked.purge(['only'], evidence);
    expect(existsSync(join(outside, 'person-739', 'sources'))).toBe(true);
  });

  test('removes emptied folders when the commit marker had to be skipped', async () => {
    await store.create({ id: 'only', type: 'raw', title: 'Only', body: 'x', category: 'private.person-739', provenance: { agent: 'creator' } });
    const hooked = open('vault', root) as unknown as { files: { hooks: { beforeFileReplace?: (path: string) => void } } } & Store;
    let writes = 0;
    hooked.files.hooks.beforeFileReplace = (path) => { if (path.endsWith('.station-knowledge-transaction.json') && ++writes === 2) throw new Error('disk full'); };
    await hooked.purge(['only'], evidence);
    expect(existsSync(join(root, 'private'))).toBe(false);
  });

  test('refuses to purge a vault that still holds migration artifacts, which keep erased paths and hashes', async () => {
    await store.create({ id: 'src', type: 'raw', title: 'Zebra', body: 'x', category: 'engineering', provenance: { agent: 'creator' } });
    mkdirSync(join(root, '.corpus-store-migration'));
    writeFileSync(join(root, '.corpus-store-migration', 'manifest.json'), '{}');
    const before = files(root);
    await expect(store.purge(['src'], evidence)).rejects.toMatchObject({ code: 'READ_ONLY', message: expect.stringContaining('.corpus-store-migration') });
    expect(files(root)).toEqual(before);
    rmSync(join(root, '.corpus-store-migration'), { recursive: true });
    await expect(store.purge(['src'], evidence)).resolves.toMatchObject({ purged: ['src'] });
  });

  test('a kit-v1 vault refuses purge as read-only', async () => {
    const kit = join(base, 'kit');
    cpSync(fileURLToPath(new URL('./fixtures/kit-v1/kit-vault', import.meta.url)), kit, { recursive: true });
    const adapter = open('vault', kit);
    await expect(adapter.purge(['kit-raw-0001'], evidence)).rejects.toMatchObject({ code: 'READ_ONLY' });
    expect((await adapter.get('kit-raw-0001'))?.status).not.toBe('purged');
  });
});

describe('purge — default layout', () => {
  test('the tombstone stays at records/<id>.md and a second store sees it', async () => {
    const base = mkdtempSync(join(tmpdir(), 'corpus-purge-default-'));
    try {
      const root = join(base, 'store');
      const store = open('default', root);
      await store.create({ id: 'src', type: 'raw', title: 'Secret', body: 'Secret', category: 'engineering', provenance: { agent: 'creator' } });
      await store.purge(['src'], evidence);
      expect(Object.keys(files(root)).filter((path) => path.endsWith('.md'))).toEqual(['records/src.md']);
      expect((await open('default', root).get('src'))?.status).toBe('purged');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
