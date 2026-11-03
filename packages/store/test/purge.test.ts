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
import { VAULT_NOTE_MAX_BYTES } from '../src/obsidian-store.js';
import { startsLikeJournal } from '../src/shared/file-transactions.js';
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
    expect(result).toEqual({ purged: ['b-source', 'a-source'], cascaded: ['m-child', 'z-child'], survivors: [], referrers: [], alreadyPurged: [], proposalsRejected: [], proposalsScrubbed: [], proposalsBlocked: [] });
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
    ['control characters and lone surrogates', 'a\u0001b\ud800c\udc00d', 'op\u001f\udbffz'],
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

  test.each([
    ['an escape the engine never writes for t', '{"version":1,"transactionId":"\\u0074","operation":"purge","phase":"prepared","entries":["USER-DATA"]}'],
    ['an unknown escape', '{"version":1,"transactionId":"a\\qb","operation":"purge","phase":"prepared","entries":["USER-DATA"]}'],
    ['an escaped slash', '{"version":1,"transactionId":"a\\/b","operation":"purge","phase":"prepared","entries":["USER-DATA"]}'],
    ['a raw newline', '{"version":1,"transactionId":"a\nb","operation":"purge","phase":"prepared","entries":["USER-DATA"]}'],
    ['a long escape for a control that has a short one (\\u000a)', '{"version":1,"transactionId":"a\\u000ab","operation":"purge","phase":"prepared","entries":["USER-DATA"]}'],
    ['a long escape for a tab (\\u0009)', '{"version":1,"transactionId":"a\\u0009b","operation":"purge","phase":"prepared","entries":["USER-DATA"]}'],
    ['a long escape for a backspace in the operation (\\u0008)', '{"version":1,"transactionId":"a","operation":"pu\\u0008rge","phase":"prepared","entries":["USER-DATA"]}'],
    ['a long escape for a form feed (\\u000c)', '{"version":1,"transactionId":"a\\u000cb","operation":"purge","phase":"prepared","entries":["USER-DATA"]}'],
    ['a long escape for a carriage return (\\u000d)', '{"version":1,"transactionId":"a\\u000db","operation":"purge","phase":"prepared","entries":["USER-DATA"]}'],
    ['uppercase hex', '{"version":1,"transactionId":"a\\u000Ab","operation":"purge","phase":"prepared","entries":["USER-DATA"]}'],
    ['an escaped surrogate pair', '{"version":1,"transactionId":"\\ud83d\\ude00","operation":"purge","phase":"prepared","entries":["USER-DATA"]}'],
  ])('a foreign file whose journal-like header uses %s is left alone', async (_name, content) => {
    await raw('foreign');
    writeFileSync(join(root, '.foreign-user-data.tmp'), content);
    await store.get('foreign');
    expect(readFileSync(join(root, '.foreign-user-data.tmp'), 'utf8')).toBe(content);
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

  test('purging the last record leaves a vault that opens, lists, reindexes and still accepts records', async () => {
    await store.create({ id: 'only', type: 'raw', title: 'Only', body: 'x', category: 'engineering', provenance: { agent: 'creator' } });
    await store.purge(['only'], evidence);
    expect(existsSync(join(root, 'path-index.json'))).toBe(true);
    // Lose the derived indexes, as the empty-vault fix covers: the path index is what tells an occupied vault from a new one.
    rmSync(join(root, 'graph-index.json'));
    rmSync(join(root, 'alias-index.json'));
    const reopened = open('vault', root);
    expect((await reopened.get('only'))?.status).toBe('purged');
    expect(await reopened.listByType('raw')).toEqual([]);
    expect((await reopened.listByType('raw', { includeHistory: true })).map((r) => r.id)).toEqual(['only']);
    await expect(reopened.reindex()).resolves.toMatchObject({ records: 1 });
    expect(index().by_id.only).toEqual({ path: 'archive/purged/only.md', archived: true });
    const next = await reopened.create({ type: 'raw', title: 'Next', body: 'y', category: 'engineering', provenance: { agent: 'creator' } });
    expect((await open('vault', root).get(next))?.body).toBe('y');
    // A third open, after the new record, still reads both.
    expect((await open('vault', root).listByType('raw', { includeHistory: true })).length).toBe(2);
  });

  describe('a survivor near the vault note bound', () => {
    // A concept note is its body plus its frontmatter; size the body so the note leaves exactly `slack` bytes.
    async function survivorWithRoom(slack: number): Promise<void> {
      await store.create({ id: 's1', type: 'raw', title: 's1', body: 'x', category: 'engineering', provenance: { agent: 'creator' } });
      await store.create({ id: 's2', type: 'raw', title: 's2', body: 'y', category: 'engineering', provenance: { agent: 'creator' } });
      const scratch = open('vault', join(base, 'scratch'));
      await scratch.create({ id: 's1', type: 'raw', title: 's1', body: 'x', category: 'engineering', provenance: { agent: 'creator' } });
      await scratch.create({ id: 's2', type: 'raw', title: 's2', body: 'y', category: 'engineering', provenance: { agent: 'creator' } });
      const make = (adapter: Store, length: number) =>
        adapter.create({ id: 'big', type: 'concept', title: 'big', body: 'b'.repeat(length), category: 'engineering', provenance: { agent: 'creator', source_ids: ['s1', 's2'] } });
      await make(scratch, 1);
      const scratchIndex = JSON.parse(readFileSync(join(base, 'scratch', 'path-index.json'), 'utf8')) as { by_id: Record<string, { path: string }> };
      const probe = Buffer.byteLength(readFileSync(join(base, 'scratch', scratchIndex.by_id.big.path), 'utf8'));
      await make(store, 1 + VAULT_NOTE_MAX_BYTES - slack - probe);
    }
    const bigBytes = () => Buffer.byteLength(readFileSync(join(root, index().by_id.big.path), 'utf8'));

    test('gets the purge entry without its prose when the full entry would not fit', async () => {
      await survivorWithRoom(600);
      expect(VAULT_NOTE_MAX_BYTES - bigBytes()).toBe(600);
      await expect(store.purge(['s1'], { agent: 'privacy-officer', rationale: 'r'.repeat(4000) })).resolves.toMatchObject({ survivors: ['big'] });
      const log = (await store.get('big'))!.mutation_log!;
      expect(log.at(-1)).toEqual({ op: 'support-purged', at: expect.any(String), agent: 'privacy-officer', evidence: { purged_ids: ['s1'], compact: true } });
      expect(bigBytes()).toBeLessThanOrEqual(VAULT_NOTE_MAX_BYTES);
      expect((await store.get('s1'))?.status).toBe('purged');
      await expect(store.create({ type: 'raw', title: 'after', body: 'z', category: 'engineering', provenance: { agent: 'creator' } })).resolves.toEqual(expect.any(String));
    });

    test('refuses, writing nothing, when not even that fits, and names the record to shrink', async () => {
      await survivorWithRoom(20);
      const before = files(root);
      await expect(store.purge(['s1'], evidence)).rejects.toMatchObject({
        code: 'MISSING_EVIDENCE',
        message: expect.stringMatching(/record big; shrink it.*limited to 16777216 bytes/),
      });
      expect(files(root)).toEqual(before);
      expect((await store.get('s1'))?.status).toBe('active');
    });

    test('is not purged around: a survivor that fits gets the full entry', async () => {
      await survivorWithRoom(100_000);
      await store.purge(['s1'], evidence);
      expect((await store.get('big'))!.mutation_log!.at(-1)).toMatchObject({ op: 'support-purged', rationale: 'erasure request 42' });
    });
  });

  describe('a tombstone near the vault note bound', () => {
    // A note made almost entirely of provenance ids keeps them in its tombstone, so the tombstone
    // plus its audit entry can pass the bound that the note itself met.
    const chunk = 'i'.repeat(2_000_000);
    async function noteNearBound(id: string, slack: number): Promise<void> {
      const scratch = open('vault', join(base, `scratch-${id}`));
      const ids = (pad: number) => [...Array.from({ length: 8 }, (_, n) => `${n}${chunk}`), 'p'.repeat(pad)];
      const create = (adapter: Store, pad: number) =>
        adapter.create({ id, type: 'concept', title: 't', body: 'b', category: 'engineering', provenance: { agent: 'creator', source_ids: ids(pad) } });
      await create(scratch, 1);
      const probe = Buffer.byteLength(readFileSync(join(base, `scratch-${id}`, JSON.parse(readFileSync(join(base, `scratch-${id}`, 'path-index.json'), 'utf8')).by_id[id].path), 'utf8'));
      await create(store, 1 + (VAULT_NOTE_MAX_BYTES - slack - probe));
    }
    const noteBytes = (id: string) => Buffer.byteLength(readFileSync(join(root, index().by_id[id].path), 'utf8'));

    test('drops the prose of its purge entry when the full entry would not fit', async () => {
      await noteNearBound('near', 900);
      await store.purge(['near'], { agent: 'privacy-officer', rationale: 'r'.repeat(1500) });
      const stone = (await store.get('near'))!;
      expect(stone.status).toBe('purged');
      // The rationale is cut to 256 JSON bytes, so a projection still has a non-empty reason, and the entry says it was cut.
      expect(stone.mutation_log!.at(-1)).toEqual({
        op: 'purged',
        at: expect.any(String),
        agent: 'privacy-officer',
        rationale: 'r'.repeat(254),
        evidence: { cause: 'requested', compact: true, rationale_truncated: true, rationale_bytes: 1500 },
      });
      expect(stone.provenance.source_ids).toHaveLength(9);
      expect(noteBytes('near')).toBeLessThanOrEqual(VAULT_NOTE_MAX_BYTES);
    });

    test.each([
      ['type', 'type: concept\n', (pad: number) => `type: '${'t'.repeat(Math.max(0, pad - 2))}'\n`, 'omitted_type_bytes'],
      ['created_at', /created_at: [^\n]+\n/, (pad: number) => `created_at: '2026-01-01T00:00:00.${'0'.repeat(Math.max(0, pad - 22))}Z'\n`, 'omitted_created_at_bytes'],
    ] as const)('a note read from outside that is made of a very long %s can still be erased', async (name, target, field, omitted) => {
      await store.create({ id: 'odd', type: 'concept', title: 't', body: 'b', category: 'engineering', provenance: { agent: 'creator' } });
      const path = join(root, index().by_id.odd.path);
      const text = readFileSync(path, 'utf8');
      const match = typeof target === 'string' ? target : text.match(target)![0];
      // Grow the field until the note is exactly at the limit (its length is linear in `pad`).
      const others = Buffer.byteLength(text) - Buffer.byteLength(match);
      let pad = VAULT_NOTE_MAX_BYTES - others;
      for (let i = 0; i < 3; i++) pad += VAULT_NOTE_MAX_BYTES - (others + Buffer.byteLength(field(pad)));
      const { writeFileSync } = await import('node:fs');
      writeFileSync(path, text.replace(match, field(pad)));
      expect(noteBytes('odd')).toBe(VAULT_NOTE_MAX_BYTES);
      expect(await open('vault', root).get('odd')).toMatchObject({ id: 'odd' });
      await store.purge(['odd'], { agent: 'privacy-officer', rationale: 'erasure request 42' });
      const stone = (await store.get('odd'))!;
      expect(stone.status).toBe('purged');
      expect(stone.mutation_log![0].evidence).toHaveProperty(omitted);
      expect(noteBytes('odd')).toBeLessThanOrEqual(VAULT_NOTE_MAX_BYTES);
      expect(name).toBeTruthy();
    });

    test('keeps a rationale of at most 64 bytes in the minimal shape, cut and flagged, so a projection never sees an empty reason', async () => {
      await noteNearBound('tiny', 5);
      await store.purge(['tiny'], { agent: 'privacy-officer', rationale: 'é'.repeat(500) });
      const entry = (await store.get('tiny'))!.mutation_log![0];
      expect(entry.rationale).toBe('é'.repeat(31)); // 2 quote bytes + 31 two-byte characters
      expect(entry.evidence).toMatchObject({ compact: true, rationale_truncated: true, rationale_bytes: 1000, omitted_source_ids: 9 });
      expect(noteBytes('tiny')).toBeLessThanOrEqual(VAULT_NOTE_MAX_BYTES);
    });

    test('cuts a rationale from its first visible character, so leading spaces cannot leave only spaces', async () => {
      await noteNearBound('lead', 450);
      await store.purge(['lead'], { agent: 'privacy-officer', rationale: `${' '.repeat(600)}erasure request 42` });
      const entry = (await store.get('lead'))!.mutation_log!.at(-1)!;
      expect(entry.rationale).toBe('erasure request 42');
      expect(entry.evidence).not.toHaveProperty('rationale_truncated');
    });

    test('also drops an agent or session id too long to keep, so a note made of them can still be erased', async () => {
      const scratch = open('vault', join(base, 'scratch-agent'));
      const make = (adapter: Store, pad: number) =>
        adapter.create({ id: 'wide', type: 'concept', title: 't', body: 'b', category: 'engineering', provenance: { agent: `\u0000${'a'.repeat(pad)}`, session_id: 's'.repeat(1000) } });
      await make(scratch, 1);
      const probe = Buffer.byteLength(readFileSync(join(base, 'scratch-agent', JSON.parse(readFileSync(join(base, 'scratch-agent', 'path-index.json'), 'utf8')).by_id.wide.path), 'utf8'));
      await make(store, 1 + (VAULT_NOTE_MAX_BYTES - probe));
      expect(noteBytes('wide')).toBe(VAULT_NOTE_MAX_BYTES);
      await store.purge(['wide'], { agent: 'privacy-officer', rationale: 'erasure request 42' });
      const stone = (await store.get('wide'))!;
      expect(stone.status).toBe('purged');
      // Booleans, so a failure does not print a 16 MiB agent.
      expect(stone.provenance.agent === '[omitted]').toBe(true);
      expect(Object.keys(stone.provenance)).toEqual(['agent']);
      expect(stone.mutation_log![0].evidence).toMatchObject({ cause: 'requested', compact: true, omitted_source_ids: 0, omitted_agent_bytes: expect.any(Number), omitted_session_id_bytes: 1000 });
      expect(noteBytes('wide')).toBeLessThanOrEqual(VAULT_NOTE_MAX_BYTES);
    });

    test('keeps identity and the purge entry, with counts of what it dropped, when even the compact entry would not fit', async () => {
      await noteNearBound('edge', 5);
      await store.purge(['edge'], { agent: 'privacy-officer', rationale: 'erasure request 42' });
      const stone = (await store.get('edge'))!;
      expect(stone).toMatchObject({ id: 'edge', status: 'purged', provenance: { agent: 'creator' }, links: [] });
      expect(stone.provenance).not.toHaveProperty('source_ids');
      expect(stone.mutation_log).toEqual([
        { op: 'purged', at: expect.any(String), agent: 'privacy-officer', rationale: 'erasure request 42', evidence: { cause: 'requested', compact: true, omitted_source_ids: 9, omitted_links: 0, omitted_log_entries: 0 } },
      ]);
      expect(noteBytes('edge')).toBeLessThanOrEqual(VAULT_NOTE_MAX_BYTES);
      // The vault is still usable: a later create scans every note with the bound.
      await expect(store.create({ type: 'raw', title: 'after', body: 'z', category: 'engineering', provenance: { agent: 'creator' } })).resolves.toEqual(expect.any(String));
    });
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

describe('startsLikeJournal', () => {
  test('recognises the start of every journal JSON.stringify can write, for random ids and operation names', () => {
    let seed = 12345;
    const random = (limit: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % limit;
    const units = [0x22, 0x5c, 0x0a, 0x00, 0x1f, 0x7f, 0x2028, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0x41, 0xe9, 0x4e2d];
    const word = () => Array.from({ length: random(12) }, () => String.fromCharCode(random(3) === 0 ? random(0x10000) : units[random(units.length)])).join('');
    for (let i = 0; i < 20000; i++) {
      const journal = JSON.stringify({ version: 1, transactionId: word(), operation: word(), phase: random(2) ? 'prepared' : 'committed', entries: [{ path: 'x', before: 'QQ==', after: null }] });
      const start = journal.indexOf('"entries":[') + '"entries":['.length;
      expect(startsLikeJournal(journal)).toBe(true);
      expect(startsLikeJournal(journal.slice(0, start))).toBe(true);
      expect(startsLikeJournal(journal.slice(0, start - 1))).toBe(false);
    }
  });
});
