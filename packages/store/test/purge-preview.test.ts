/**
 * Purge preview (kontourai/corpus#69). `previewPurge` and `previewPurgeProposal` report what the
 * erasure will do, read-only, from the plan the erasure itself runs; the revision they return pins
 * the preview, and `purge` / `purgeProposal` refuse with STALE_REVISION if the store has moved.
 * Every parity test compares the preview with what the committed erasure then returned, on both
 * profiles, in a store where every category is non-empty.
 */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  KitDefaultStoreAdapter,
  KitObsidianStoreAdapter,
  standaloneFileMutationLock,
  type CreateInput,
  type KnowledgeStoreAdapter,
  type KnowledgeStoreCreateProposals,
  type KnowledgeStorePurger,
} from '../src/index.js';

type Store = KnowledgeStoreAdapter & KnowledgeStorePurger & KnowledgeStoreCreateProposals;
const evidence = { agent: 'privacy-officer', rationale: 'erasure request 42' };
const proposalEvidence = (text = 'because') => ({ agent: 'drafter', proposal: text });
/** Text that exists only as erased-to-be content, so a scan of a preview finds it only if the preview leaks. */
const MARKERS = ['ZEBRA-TITLE', 'ZEBRA-BODY', 'ZEBRA-TAG', 'zebra-alias', 'ZEBRA-NOTE', 'ZEBRA-LABEL', 'ZEBRA-PROPOSAL', '0.7312'];

function everything(root: string): string {
  const parts: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      parts.push(path.slice(root.length));
      if (entry.isDirectory()) walk(path);
      else parts.push(readFileSync(path, 'utf8'));
    }
  };
  walk(root);
  return parts.join('\n');
}

async function code(promise: Promise<unknown>): Promise<string | undefined> {
  try { await promise; } catch (error) { return (error as { code?: string }).code ?? `no-code:${(error as Error).message}`; }
  return undefined;
}

const without = <T extends object, K extends string>(value: T, ...keys: K[]) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key as K)));

describe.each(['default', 'vault'] as const)('purge preview — %s profile', (profile) => {
  let base: string;
  let root: string;
  let store: Store;
  const open = (options: Record<string, unknown> = {}): Store => {
    const Constructor = profile === 'default' ? KitDefaultStoreAdapter : KitObsidianStoreAdapter;
    return new Constructor({
      storeRoot: root,
      coordinationDirectory: join(base, 'coordination'),
      coordinationIdentity: () => () => {},
      lock: standaloneFileMutationLock,
      allowPurge: true,
      ...options,
    }) as unknown as Store;
  };
  const recordPath = (id: string) =>
    profile === 'default'
      ? join(root, 'records', `${id}.md`)
      : join(root, JSON.parse(readFileSync(join(root, 'path-index.json'), 'utf8')).by_id[id].path);

  const raw = (id: string): CreateInput => ({
    id, type: 'raw', title: `ZEBRA-TITLE ${id}`, body: `ZEBRA-BODY ${id}`, category: 'engineering',
    tags: ['ZEBRA-TAG'], aliases: [`engineering/zebra-alias-${id}`], provenance: { agent: 'ferry', note: 'ZEBRA-NOTE' },
  });
  const concept = (id: string, sources: string[], fields: Partial<CreateInput> = {}): CreateInput => ({
    id, type: 'concept', title: `ZEBRA-TITLE ${id}`, body: `ZEBRA-BODY ${id}`, category: 'engineering',
    provenance: { agent: 'compiler', source_ids: sources, note: 'ZEBRA-NOTE' }, ...fields,
  });
  const compiled = (id: string, sources: string[], fields: Partial<CreateInput> = {}): CreateInput => ({
    id, type: 'compiled', title: `ZEBRA-TITLE ${id}`, body: `ZEBRA-BODY ${id}`, category: 'engineering', confidence: 0.7312,
    links: sources.map((target_id) => ({ target_id, kind: 'source' })),
    provenance: { agent: 'compiler', source_ids: sources, note: 'ZEBRA-NOTE' }, ...fields,
  });
  /** A pending proposal for a concept that rests on `sources`. */
  const propose = (id: string, sources: string[], fields: Partial<CreateInput> = {}) =>
    store.proposeCreate(concept(id, sources, fields), 'proposer-1', proposalEvidence('ZEBRA-PROPOSAL'));

  /**
   * One store in which a purge of `src-a` reaches every category: a target, a sole-support cascade
   * (`sole`, created by an applied proposal, and `dep`, resting only on it), a support cycle
   * (`cx` / `cy`), a survivor (`shared`), a referrer (`ref`), a pending proposal that is rejected,
   * a rejected proposal that is scrubbed, a pending one that is blocked, and one that only loses a label.
   */
  let ids: Record<string, string>;
  async function seed() {
    await store.create(raw('src-a'));
    await store.create(raw('src-b'));
    // `sole` is created through a proposal, so an applied proposal points at it.
    const applied = await store.proposeCreate(compiled('sole', ['src-a']), 'proposer-1', proposalEvidence('ZEBRA-PROPOSAL'));
    await store.applyCreate(applied, 'reviewer-1');
    await store.create(concept('dep', ['sole'], { links: [{ target_id: 'sole', kind: 'source' }] }));
    await store.create(concept('cx', ['src-a']));
    await store.create(concept('cy', ['cx']));
    await store.link('cx', [{ target_id: 'cy', kind: 'source' }], { agent: 'editor' });
    await store.create(compiled('shared', ['src-a', 'src-b']));
    await store.create(concept('ref', [], { links: [{ target_id: 'src-a', kind: 'related', label: 'ZEBRA-LABEL' }] }));
    const pending = await propose('p-pending', ['src-a']);
    const rejected = await propose('p-rejected', ['src-a']);
    await store.rejectCreate(rejected, 'reviewer-1', 'not now');
    const blocked = await propose('p-blocked', ['src-a', 'src-b']);
    const labelled = await propose('p-label', ['src-b'], { links: [{ target_id: 'src-a', kind: 'related', label: 'ZEBRA-LABEL' }] });
    ids = { applied, pending, rejected, blocked, labelled };
  }

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), `corpus-purge-preview-${profile}-`));
    root = join(base, 'store');
    store = open();
    await seed();
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  describe('parity with the committed result', () => {
    test('the scenario reaches every category, so the parity tests below are not vacuous', async () => {
      const preview = await store.previewPurge(['src-a']);
      expect(preview).toMatchObject({
        purged: ['src-a'],
        cascaded: ['cx', 'cy', 'dep', 'sole'],
        survivors: ['shared'],
        referrers: ['ref'],
        alreadyPurged: [],
        proposalsRejected: [ids.pending],
        proposalsBlocked: [ids.blocked],
      });
      expect(preview.proposalsScrubbed).toEqual(expect.arrayContaining([ids.pending, ids.rejected, ids.applied]));
    });

    test('previewPurge names exactly what purge then does: targets, cascade, cycle, survivors, referrers and proposals', async () => {
      const preview = await store.previewPurge(['src-a']);
      const result = await store.purge(['src-a'], evidence, { expectedRevision: preview.revision });
      expect(without(preview, 'revision')).toEqual(result);
    });

    test('shared support: purging both sources takes the record that rested on them', async () => {
      const preview = await store.previewPurge(['src-a', 'src-b']);
      expect(preview.cascaded).toContain('shared');
      expect(preview.survivors).toEqual([]);
      const result = await store.purge(['src-a', 'src-b'], evidence, { expectedRevision: preview.revision });
      expect(without(preview, 'revision')).toEqual(result);
    });

    test('a record that is not a source of anything has no cascade; a cycle member alone takes the other', async () => {
      for (const target of [['ref'], ['cx'], ['shared'], ['dep', 'cy']]) {
        const preview = await store.previewPurge(target);
        const result = await store.purge(target, evidence, { expectedRevision: preview.revision });
        expect(without(preview, 'revision'), `purge ${target.join(',')}`).toEqual(result);
      }
    });

    test('ids already purged are reported as alreadyPurged, and the preview still equals the result', async () => {
      await store.purge(['src-a'], evidence);
      const preview = await store.previewPurge(['src-a', 'src-b']);
      expect(preview.alreadyPurged).toEqual(['src-a']);
      expect(preview.purged).toEqual(['src-b']);
      const result = await store.purge(['src-a', 'src-b'], evidence, { expectedRevision: preview.revision });
      expect(without(preview, 'revision')).toEqual(result);
    });

    test.each([
      ['pending', 'pending'],
      ['rejected', 'rejected'],
      ['blocked', 'pending'],
      ['labelled', 'pending'],
    ])('previewPurgeProposal for a %s proposal equals purgeProposal', async (name, state) => {
      const id = ids[name]!;
      const preview = await store.previewPurgeProposal(id);
      expect(preview).toMatchObject({ proposalId: id, alreadyErased: false, state });
      expect(preview.record).toBeUndefined();
      expect(preview.recordId).toBeUndefined();
      const result = await store.purgeProposal(id, evidence, { expectedRevision: preview.revision });
      expect(without(preview, 'revision', 'state', 'recordId')).toEqual(result);
      expect((await store.getProposal(id))?.erasure).toBeTruthy();
    });

    test('an applied proposal: the preview shows the record behind it and its whole cascade', async () => {
      const preview = await store.previewPurgeProposal(ids.applied!);
      expect(preview).toMatchObject({ alreadyErased: false, state: 'applied', recordId: 'sole' });
      expect(preview.record).toMatchObject({ purged: ['sole'], cascaded: ['dep'] });
      const result = await store.purgeProposal(ids.applied!, evidence, { expectedRevision: preview.revision });
      expect(without(preview, 'revision', 'state', 'recordId')).toEqual(result);
      expect((await store.get('sole'))?.status).toBe('purged');
      expect((await store.get('dep'))?.status).toBe('purged');
    });

    test('an applied proposal whose record is already a tombstone: no record step in either', async () => {
      await store.purge(['sole'], evidence);
      const preview = await store.previewPurgeProposal(ids.applied!);
      expect(preview.record).toBeUndefined();
      expect(preview.recordId).toBe('sole');
      const result = await store.purgeProposal(ids.applied!, evidence, { expectedRevision: preview.revision });
      expect(without(preview, 'revision', 'state', 'recordId')).toEqual(result);
    });

    test('an already erased proposal: alreadyErased in both, and nothing to write', async () => {
      await store.purgeProposal(ids.pending!, evidence);
      const preview = await store.previewPurgeProposal(ids.pending!);
      expect(preview).toMatchObject({ alreadyErased: true, state: 'rejected' });
      const before = everything(root);
      const result = await store.purgeProposal(ids.pending!, evidence, { expectedRevision: preview.revision });
      expect(without(preview, 'revision', 'state', 'recordId')).toEqual(result);
      expect(everything(root)).toBe(before);
    });
  });

  describe('read-only and content-free', () => {
    test('neither preview writes a byte, and both leave the store able to purge', async () => {
      const before = everything(root);
      await store.previewPurge(['src-a']);
      await store.previewPurge(['src-a', 'src-b']);
      await store.previewPurgeProposal(ids.pending!);
      await store.previewPurgeProposal(ids.applied!);
      expect(everything(root)).toBe(before);
      expect((await store.get('src-a'))?.status).toBe('active');
      expect(readdirSync(root).some((name) => name.includes('transaction'))).toBe(false);
    });

    test('a preview contains ids, states and a revision, and none of the content it is about to erase', async () => {
      const previews = [
        await store.previewPurge(['src-a']),
        await store.previewPurge(['src-a', 'src-b']),
        await store.previewPurgeProposal(ids.pending!),
        await store.previewPurgeProposal(ids.applied!),
      ];
      const text = JSON.stringify(previews);
      for (const marker of MARKERS) expect(text, marker).not.toContain(marker);
      // The only strings in it are ids, states and the revision.
      const strings: string[] = [];
      const walk = (value: unknown) => {
        if (typeof value === 'string') strings.push(value);
        else if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === 'object') Object.values(value).forEach(walk);
      };
      walk(previews);
      const allowed = new Set(['src-a', 'src-b', 'sole', 'dep', 'cx', 'cy', 'shared', 'ref', 'pending', 'rejected', 'applied', ...Object.values(ids)]);
      for (const value of strings) expect(allowed.has(value) || /^rev1:[a-f0-9]{64}$/.test(value), value).toBe(true);
    });

    test('a store built without allowPurge can preview, and still cannot purge', async () => {
      const ordinary = open({ allowPurge: false });
      const preview = await ordinary.previewPurge(['src-a']);
      expect(preview.purged).toEqual(['src-a']);
      expect((await ordinary.previewPurgeProposal(ids.pending!)).state).toBe('pending');
      expect(await code(ordinary.purge(['src-a'], evidence, { expectedRevision: preview.revision }))).toBe('READ_ONLY');
      expect(await code(ordinary.purgeProposal(ids.pending!, evidence))).toBe('READ_ONLY');
      expect((await ordinary.get('src-a'))?.status).toBe('active');
      // The privileged adapter on the same root accepts the preview the ordinary one made.
      await expect(store.purge(['src-a'], evidence, { expectedRevision: preview.revision })).resolves.toMatchObject({ purged: ['src-a'] });
    });

    test('the preview refuses what the purge refuses: unknown ids, empty input', async () => {
      expect(await code(store.previewPurge(['nope']))).toBe('NOT_FOUND');
      expect(await code(store.purge(['nope'], evidence))).toBe('NOT_FOUND');
      expect(await code(store.previewPurge([]))).toBe('MISSING_EVIDENCE');
      expect(await code(store.previewPurge([''] as string[]))).toBe('MISSING_EVIDENCE');
      expect(await code(store.previewPurge('src-a' as unknown as string[]))).toBe('MISSING_EVIDENCE');
      expect(await code(store.previewPurgeProposal('nope'))).toBe('NOT_FOUND');
      expect(await code(store.previewPurgeProposal('../escape'))).toBe('NOT_FOUND');
      expect(await code(store.previewPurgeProposal(''))).toBe('MISSING_EVIDENCE');
    });

    test('a corrupt proposal stops a record preview as it stops the purge, but not a pending proposal preview', async () => {
      writeFileSync(join(root, '.corpus-proposals', 'garbage.json'), '{ not json');
      const before = everything(root);
      await expect(store.previewPurge(['src-a'])).rejects.toMatchObject({ name: 'KnowledgeStoreCorruptionError' });
      await expect(store.purge(['src-a'], evidence)).rejects.toMatchObject({ name: 'KnowledgeStoreCorruptionError' });
      expect(everything(root)).toBe(before);
      // A pending proposal reads and erases only itself, so its preview, revision and erasure still work.
      const preview = await store.previewPurgeProposal(ids.pending!);
      expect(preview.revision).toMatch(/^rev1:/);
      await expect(store.purgeProposal(ids.pending!, evidence, { expectedRevision: preview.revision })).resolves.toMatchObject({ alreadyErased: false });
    });
  });

  describe('revision', () => {
    test('it is stable while nothing changes, across calls and across adapters on the same root', async () => {
      const first = (await store.previewPurge(['src-a'])).revision;
      expect((await store.previewPurge(['src-a'])).revision).toBe(first);
      expect((await store.previewPurge(['src-b'])).revision).toBe(first);
      expect((await store.previewPurgeProposal(ids.pending!)).revision).toBe(first);
      expect((await open().previewPurge(['src-a'])).revision).toBe(first);
      expect(first).toMatch(/^rev1:[a-f0-9]{64}$/);
    });

    test('the same records in a different store have a different revision', async () => {
      // Two stores built by the same calls under a fixed clock and id sequence hold byte-identical notes,
      // so only the root's identity can make their revisions differ.
      const built: { dir: string; revision: string; note: string }[] = [];
      try {
        for (const name of ['one', 'two']) {
          const dir = mkdtempSync(join(tmpdir(), `corpus-purge-preview-${name}-`));
          const Constructor = profile === 'default' ? KitDefaultStoreAdapter : KitObsidianStoreAdapter;
          let sequence = 0;
          const twin = new Constructor({
            storeRoot: join(dir, 'store'), coordinationDirectory: join(dir, 'coordination'), coordinationIdentity: () => () => {},
            lock: standaloneFileMutationLock, allowPurge: true, clock: () => Date.UTC(2026, 10, 5), ids: () => `generated-${++sequence}`,
          }) as unknown as Store;
          await twin.create(raw('src-a'));
          await twin.create(compiled('sole', ['src-a']));
          const note = profile === 'default'
            ? join(dir, 'store', 'records', 'sole.md')
            : join(dir, 'store', JSON.parse(readFileSync(join(dir, 'store', 'path-index.json'), 'utf8')).by_id.sole.path);
          built.push({ dir, revision: (await twin.previewPurge(['src-a'])).revision, note: readFileSync(note, 'utf8') });
        }
        expect(built[0]!.note).toBe(built[1]!.note);
        expect(built[0]!.revision).not.toBe(built[1]!.revision);
      } finally {
        for (const { dir } of built) rmSync(dir, { recursive: true, force: true });
      }
    });

    /** Each is a write that changes what a confirmed purge would do, or might. */
    const writes: [string, (s: Store) => Promise<unknown>][] = [
      // A body edit keeps the note where it is (a vault names a note by its title), so only its bytes change.
      ['a record is updated', (s) => s.update('ref', { body: 'ZEBRA-BODY ref, changed' }, { agent: 'editor' })],
      ['a record is created', (s) => s.create(raw('src-c'))],
      ['a record is linked', (s) => s.link('ref', [{ target_id: 'src-b', kind: 'related' }], { agent: 'editor' })],
      ['a record is retired', (s) => s.retire('ref', 'retired', { agent: 'editor', rationale: 'old' })],
      ['a proposal is staged', (s) => s.proposeCreate(concept('later', ['src-b']), 'proposer-1', proposalEvidence())],
      ['a request key is used for the first time', (s) => s.proposeCreate(concept('keyed', ['src-b']), 'proposer-1', proposalEvidence(), { requestKey: 'first-use' })],
      ['a proposal is applied', async (s) => s.applyCreate(ids.blocked!, 'reviewer-1')],
      ['a proposal is rejected', async (s) => s.rejectCreate(ids.labelled!, 'reviewer-1', 'no')],
    ];

    test.each(writes)('STALE_REVISION when %s after the preview; nothing is written, and a fresh preview confirms', async (_name, write) => {
      const preview = await store.previewPurge(['src-a']);
      await write(store);
      const before = everything(root);
      expect(await code(store.purge(['src-a'], evidence, { expectedRevision: preview.revision }))).toBe('STALE_REVISION');
      expect(everything(root)).toBe(before);
      expect((await store.get('src-a'))?.status).toBe('active');
      // Refresh and reconfirm: preview again, show the new effects, then confirm with the new revision.
      const refreshed = await store.previewPurge(['src-a']);
      expect(refreshed.revision).not.toBe(preview.revision);
      const result = await store.purge(['src-a'], evidence, { expectedRevision: refreshed.revision });
      expect(without(refreshed, 'revision')).toEqual(result);
    });

    test.each(writes)('STALE_REVISION for purgeProposal when %s after the preview', async (_name, write) => {
      const preview = await store.previewPurgeProposal(ids.pending!);
      await write(store);
      const before = everything(root);
      expect(await code(store.purgeProposal(ids.pending!, evidence, { expectedRevision: preview.revision }))).toBe('STALE_REVISION');
      expect(everything(root)).toBe(before);
      expect((await store.getProposal(ids.pending!))?.erasure).toBeUndefined();
    });

    test('an edit made outside the store (a person in a vault, a script) is stale too', async () => {
      const preview = await store.previewPurge(['src-a']);
      const path = recordPath('ref');
      writeFileSync(path, readFileSync(path, 'utf8').replace('ZEBRA-BODY ref', 'ZEBRA-BODY ref, edited by hand'));
      expect(await code(store.purge(['src-a'], evidence, { expectedRevision: preview.revision }))).toBe('STALE_REVISION');
      const proposalPath = join(root, '.corpus-proposals', `${ids.pending}.json`);
      const fresh = await store.previewPurge(['src-a']);
      writeFileSync(proposalPath, `${readFileSync(proposalPath, 'utf8')} `);
      expect(await code(store.purge(['src-a'], evidence, { expectedRevision: fresh.revision }))).toBe('STALE_REVISION');
    });

    test('a request-key retry that matches changes nothing, so it does not make a preview stale', async () => {
      const key = { requestKey: 'retry-key' };
      const first = await store.proposeCreate(concept('keyed', ['src-b']), 'proposer-1', proposalEvidence(), key);
      const preview = await store.previewPurge(['src-a']);
      expect(await store.proposeCreate(concept('keyed', ['src-b']), 'proposer-1', proposalEvidence(), key)).toBe(first);
      expect((await store.previewPurge(['src-a'])).revision).toBe(preview.revision);
      await expect(store.purge(['src-a'], evidence, { expectedRevision: preview.revision })).resolves.toMatchObject({ purged: ['src-a'] });
    });

    test('a request key retired by a scrub is a write: a preview from before it is stale', async () => {
      const key = { requestKey: 'to-be-retired' };
      // Dropping the label that names src-a changes the candidate, which retires the key.
      await store.proposeCreate(concept('keyed', ['src-b'], { links: [{ target_id: 'src-a', kind: 'related', label: 'ZEBRA-LABEL' }] }), 'proposer-1', proposalEvidence(), key);
      const preview = await store.previewPurge(['src-b']);
      await store.purge(['src-a'], evidence);
      expect(await code(store.purge(['src-b'], evidence, { expectedRevision: preview.revision }))).toBe('STALE_REVISION');
    });

    test('a purge that already ran makes every earlier preview stale', async () => {
      const preview = await store.previewPurge(['src-a']);
      await store.purge(['src-a'], evidence);
      expect(await code(store.purge(['src-a'], evidence, { expectedRevision: preview.revision }))).toBe('STALE_REVISION');
      expect(await code(store.purgeProposal(ids.applied!, evidence, { expectedRevision: preview.revision }))).toBe('STALE_REVISION');
    });

    test('a revision that no store has is stale, and a malformed one is a usage error', async () => {
      const bogus = `rev1:${'0'.repeat(64)}`;
      const before = everything(root);
      expect(await code(store.purge(['src-a'], evidence, { expectedRevision: bogus }))).toBe('STALE_REVISION');
      expect(await code(store.purgeProposal(ids.pending!, evidence, { expectedRevision: bogus }))).toBe('STALE_REVISION');
      for (const options of [{ expectedRevision: '' }, { expectedRevision: 7 }, { expectedRevision: {} }, null, 'rev1:x'] as unknown[]) {
        expect(await code(store.purge(['src-a'], evidence, options as never)), JSON.stringify(options)).toBe('MISSING_EVIDENCE');
        expect(await code(store.purgeProposal(ids.pending!, evidence, options as never)), JSON.stringify(options)).toBe('MISSING_EVIDENCE');
      }
      expect(everything(root)).toBe(before);
    });

    test('without expectedRevision, purge and purgeProposal behave as before', async () => {
      await expect(store.purge(['src-a'], evidence)).resolves.toMatchObject({ purged: ['src-a'] });
      await expect(store.purgeProposal(ids.blocked!, evidence, {})).resolves.toMatchObject({ alreadyErased: expect.any(Boolean) });
      await expect(store.purgeProposal(ids.labelled!, evidence, { expectedRevision: undefined })).resolves.toMatchObject({ proposalId: ids.labelled });
    });

    test('a stale refusal does not take a lock that blocks the next call, and the error names nothing', async () => {
      const preview = await store.previewPurge(['src-a']);
      await store.update('ref', { title: 'changed' }, { agent: 'editor' });
      const error = await store.purge(['src-a'], evidence, { expectedRevision: preview.revision }).catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe('StaleRevisionError');
      expect((error as Error).message).not.toMatch(/src-a|ref|ZEBRA/);
      await expect(store.previewPurge(['src-a'])).resolves.toMatchObject({ purged: ['src-a'] });
    });
  });

  if (profile === 'vault') {
    test('a vault holding migration artifacts refuses the preview as it refuses the purge', async () => {
      mkdirSync(join(root, '.corpus-store-migration'), { recursive: true });
      writeFileSync(join(root, '.corpus-store-migration', 'manifest.json'), '{}');
      const before = everything(root);
      expect(await code(store.previewPurge(['src-a']))).toBe('READ_ONLY');
      expect(await code(store.purge(['src-a'], evidence))).toBe('READ_ONLY');
      expect(await code(store.previewPurgeProposal(ids.pending!))).toBe('READ_ONLY');
      expect(await code(store.purgeProposal(ids.pending!, evidence))).toBe('READ_ONLY');
      expect(everything(root)).toBe(before);
    });

    test('a vault that opens read-only refuses the preview', async () => {
      const readOnlyRoot = join(base, 'kit-v1');
      cpSync(fileURLToPath(new URL('./fixtures/kit-v1/kit-vault', import.meta.url)), readOnlyRoot, { recursive: true });
      const readOnly = new KitObsidianStoreAdapter({ storeRoot: readOnlyRoot, coordinationDirectory: join(base, 'coordination'), coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock, allowPurge: true }) as unknown as Store;
      expect(await code(readOnly.previewPurge(['anything']))).toBe('READ_ONLY');
      expect(await code(readOnly.previewPurgeProposal('anything'))).toBe('READ_ONLY');
    });
  }
});
