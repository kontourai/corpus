/**
 * `purgeProposal` (owner decision, 2026-11-04, kontourai/corpus#62): erase one create proposal
 * by its proposal id, pending or rejected with or without sources, and an applied one together
 * with the record it created. Both profiles run every test.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  assertAdapterBoundTo,
  KitDefaultStoreAdapter,
  KitObsidianStoreAdapter,
  standaloneFileMutationLock,
  type CreateInput,
  type FileMutationLock,
  type KnowledgeStoreAdapter,
  type KnowledgeStoreCreateProposals,
  type KnowledgeStorePurger,
} from '../src/index.js';
import { migrateVaultIndex } from '../src/migrate.js';

type Store = KnowledgeStoreAdapter & KnowledgeStorePurger & KnowledgeStoreCreateProposals;
type Profile = 'default' | 'vault';

const evidence = { agent: 'privacy-officer', rationale: 'erasure request 42', note: 'ticket 7' };
const proposalEvidence = (text = 'Secret proposal text NEEDLE-EVID') => ({ agent: 'drafter', proposal: text });
const NEEDLES = ['NEEDLE-CAND', 'NEEDLE-TITLE', 'NEEDLE-EVID', 'NEEDLE-TAG', 'NEEDLE-ALIAS', 'NEEDLE-LABEL', 'NEEDLE-NOTE', 'NEEDLE-REF', 'NEEDLE-REVIEW', 'needle-alias'];

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

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** A lock that parks its holder after acquiring, so a second adapter can queue behind it. */
function gatedLock() {
  let armed = false;
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const lock: FileMutationLock = async (path) => {
    const unlock = await standaloneFileMutationLock(path);
    if (armed) {
      armed = false;
      enter();
      await held;
    }
    return unlock;
  };
  return { lock, arm: () => { armed = true; }, entered, release };
}

describe.each(['default', 'vault'] as const)('purgeProposal — %s profile', (profile: Profile) => {
  let base: string;
  let root: string;
  let store: Store;
  let tick: number;

  const open = (storeRoot = root, extra: Record<string, unknown> = {}): Store => {
    const Constructor = profile === 'default' ? KitDefaultStoreAdapter : KitObsidianStoreAdapter;
    return new Constructor({
      storeRoot,
      coordinationDirectory: join(base, 'coordination'),
      coordinationIdentity: () => () => {},
      lock: standaloneFileMutationLock,
      allowPurge: true,
      clock: () => Date.UTC(2026, 10, 4) + ++tick * 1000,
      ...extra,
    }) as unknown as Store;
  };
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), `corpus-purge-proposal-${profile}-`));
    root = join(base, 'store');
    tick = 0;
    store = open();
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const raw = (id: string) =>
    store.create({ id, type: 'raw', title: `title of ${id}`, body: `body of ${id}`, category: 'engineering', provenance: { agent: 'creator' } });
  const candidate = (sources: string[], extra: Partial<CreateInput> = {}): CreateInput => ({
    type: 'concept',
    title: 'NEEDLE-TITLE Secret Candidate',
    body: 'Secret candidate body NEEDLE-CAND',
    category: 'engineering',
    tags: ['NEEDLE-TAG'],
    aliases: ['team/needle-alias'],
    provenance: {
      agent: 'drafter',
      session_id: 'session-1',
      note: 'NEEDLE-NOTE',
      source_ids: sources,
      source_refs: [{ kind: 'session-transcript', harness: 'h', session_id: 's-1', transcript_ref: 'NEEDLE-REF' }],
    },
    ...extra,
  });
  const propose = (sources: string[], extra: Partial<CreateInput> = {}, options?: { requestKey?: string }) =>
    store.proposeCreate(candidate(sources, extra), 'proposer-1', proposalEvidence(), options);
  const noContent = (where = root) => {
    const bytes = everything(where);
    for (const needle of NEEDLES) expect(bytes, needle).not.toContain(needle);
  };
  const stub = (sources: string[]) => ({
    type: 'concept',
    title: '[purged]',
    body: '',
    category: 'purged',
    provenance: { agent: 'drafter', session_id: 'session-1', ...(sources.length ? { source_ids: sources } : {}) },
    links: [],
  });

  describe.each([
    ['no source', [] as string[]],
    ['a source outside the store (partly supported)', ['live-1', 'external-conversation-1']],
    ['sources that are all live records (fully supported)', ['live-1', 'live-2']],
  ])('a proposal with %s', (_name, sources) => {
    beforeEach(async () => {
      await raw('live-1');
      await raw('live-2');
    });

    test('pending: the candidate, evidence and source references are erased, the proposal is settled rejected, and the sources are untouched', async () => {
      const id = await propose(sources, { links: [{ target_id: 'live-1', kind: 'related', label: 'NEEDLE-LABEL' }] });
      const before = [JSON.stringify(await store.get('live-1')), JSON.stringify(await store.get('live-2'))];
      expect(everything(root)).toContain('NEEDLE-CAND');

      // The scope the issue reports: a purge of an unrelated record does not reach this proposal.
      await store.purge(['live-2'], { agent: 'someone', rationale: 'unrelated' });
      expect((await store.getProposal(id))!.candidate.body).toContain('NEEDLE-CAND');
      const beforeLive1 = JSON.stringify(await store.get('live-1'));

      const result = await store.purgeProposal(id, evidence);
      expect(result).toEqual({ proposalId: id, alreadyErased: false });

      const after = (await store.getProposal(id))!;
      expect(after).toMatchObject({
        id,
        state: 'rejected',
        proposer_id: 'proposer-1',
        reviewer_id: 'privacy-officer',
        rationale: 'erasure request 42',
        evidence: { agent: 'drafter', proposal: '[purged]' },
        erasure: { agent: 'privacy-officer', rationale: 'erasure request 42', note: 'ticket 7' },
        candidate: { ...stub(sources), links: [{ target_id: 'live-1', kind: 'related' }] },
      });
      expect(Date.parse(after.erasure!.at)).not.toBeNaN();
      expect(after.decided_at).toBe(after.erasure!.at);
      expect(after.candidate).not.toHaveProperty('tags');
      expect(after.candidate).not.toHaveProperty('aliases');
      expect(after.candidate.provenance).not.toHaveProperty('source_refs');
      expect(after.candidate.provenance).not.toHaveProperty('note');
      noContent();
      // No digest of the erased content is kept either.
      const bytes = everything(root);
      for (const secret of ['Secret candidate body NEEDLE-CAND', 'NEEDLE-TITLE Secret Candidate']) {
        for (const form of [sha256(secret), createHash('md5').update(secret).digest('hex')]) expect(bytes).not.toContain(form);
      }

      // Nothing else changed: the source records are byte-for-byte what they were.
      expect(JSON.stringify(await store.get('live-1'))).toBe(beforeLive1);
      expect(before[0]).toBe(beforeLive1);
      // It can never apply, and no record came of it.
      await expect(store.applyCreate(id, 'reviewer-1')).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });
      await expect(store.rejectCreate(id, 'reviewer-1', 'late')).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });
      expect(await store.listByType('concept', { includeHistory: true })).toEqual([]);
      // Reopening and rebuilding the derived indexes read the same proposal back and bring nothing back.
      const reopened = open();
      expect(await reopened.getProposal(id)).toEqual(after);
      await reopened.reindex();
      noContent();
    });

    test('rejected: the candidate and the reviewer’s rationale are erased, and the reviewer stays', async () => {
      const id = await propose(sources);
      await store.rejectCreate(id, 'reviewer-2', 'Reviewer prose NEEDLE-REVIEW');
      const result = await store.purgeProposal(id, evidence);
      expect(result).toEqual({ proposalId: id, alreadyErased: false });
      expect(await store.getProposal(id)).toMatchObject({
        state: 'rejected',
        reviewer_id: 'reviewer-2',
        rationale: '[purged]',
        evidence: { agent: 'drafter', proposal: '[purged]' },
        erasure: { agent: 'privacy-officer', rationale: 'erasure request 42' },
        candidate: stub(sources),
      });
      noContent();
    });
  });

  test('an applied proposal is erased together with the record it created, cascade included, in one write', async () => {
    const id = await propose([]);
    const recordId = await store.applyCreate(id, 'reviewer-1');
    await store.create({ id: 'dep', type: 'concept', title: 'dep', body: 'dep body', category: 'engineering', provenance: { agent: 'creator' }, links: [{ target_id: recordId, kind: 'source' }] });
    await raw('other-support');
    await store.create({ id: 'kept', type: 'concept', title: 'kept', body: 'kept body', category: 'engineering', provenance: { agent: 'creator' }, links: [{ target_id: recordId, kind: 'source' }, { target_id: 'other-support', kind: 'source' }] });
    expect(everything(root)).toContain('NEEDLE-CAND');

    const result = await store.purgeProposal(id, evidence);
    expect(result.alreadyErased).toBe(false);
    expect(result.record).toMatchObject({ purged: [recordId], cascaded: ['dep'], survivors: ['kept'], proposalsScrubbed: [id] });
    expect((await store.get(recordId))!.status).toBe('purged');
    expect((await store.get('dep'))!.status).toBe('purged');
    expect((await store.get('kept'))!.status).toBe('active');

    const after = (await store.getProposal(id))!;
    expect(after).toMatchObject({ state: 'applied', record_id: recordId, reviewer_id: 'reviewer-1', evidence: { proposal: '[purged]' }, candidate: stub([]) });
    // One erasure wrote both: the proposal carries the purge's own time, not a later one.
    const purged = (await store.get(recordId))!.mutation_log!.at(-1)!;
    expect(purged.op).toBe('purged');
    expect(after.erasure).toMatchObject({ at: purged.at, agent: 'privacy-officer' });
    noContent();
    expect((await store.purgeProposal(id, evidence))).toEqual({ proposalId: id, alreadyErased: true });
  });

  test('an applied proposal whose record is already a tombstone, gone, or not a safe id is erased alone', async () => {
    const cases: Array<[string, (id: string, recordId: string) => void]> = [
      ['a tombstoned record', () => {}],
      ['an id that names no record', (id) => rewrite(id, 'ghost-record')],
      ['an id too long to be a record', (id) => rewrite(id, 'r'.repeat(300))],
      ['an inherited property name', (id) => rewrite(id, 'constructor')],
      // In the default layout `records/<id>.md` is joined, so this names a real record through a traversal.
      ['a path-like id that reaches a real record', (id, recordId) => rewrite(id, `../records/${recordId}`)],
    ];
    const rewrite = (id: string, recordId: string) => {
      const path = join(root, '.corpus-proposals', `${id}.json`);
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), record_id: recordId }, null, 2));
    };
    for (const [index, [name, change]] of cases.entries()) {
      const id = await propose([], { body: `Secret body NEEDLE-CAND ${name}`, aliases: [`team/needle-alias-${index}`] });
      const path = join(root, '.corpus-proposals', `${id}.json`);
      const recordId = await store.applyCreate(id, 'reviewer-1');
      const applied = readFileSync(path, 'utf8');
      if (name === 'a tombstoned record') {
        // A proposal file restored from before the record's purge: the record is a tombstone, the proposal is not.
        await store.purge([recordId], { agent: 'someone', rationale: 'earlier' });
        writeFileSync(path, applied);
      }
      change(id, recordId);
      const result = await store.purgeProposal(id, evidence);
      expect(result, name).toEqual({ proposalId: id, alreadyErased: false });
      expect((await store.getProposal(id))!.erasure, name).toMatchObject({ agent: 'privacy-officer' });
      // Only the proposal is erased here: a record this proposal does not name stays as it is.
      const file = readFileSync(path, 'utf8');
      for (const needle of NEEDLES) expect(file, `${name}: ${needle}`).not.toContain(needle);
    }
  });

  test('it is idempotent: a second call writes nothing and keeps the first marker, whoever asks', async () => {
    const id = await propose([]);
    await store.purgeProposal(id, evidence);
    const first = readFileSync(join(root, '.corpus-proposals', `${id}.json`), 'utf8');
    const snapshot = everything(root);
    const again = await store.purgeProposal(id, { agent: 'someone-else', rationale: 'a different request' });
    expect(again).toEqual({ proposalId: id, alreadyErased: true });
    expect(readFileSync(join(root, '.corpus-proposals', `${id}.json`), 'utf8')).toBe(first);
    expect(everything(root)).toBe(snapshot);
    expect((await store.getProposal(id))!.erasure!.agent).toBe('privacy-officer');
  });

  test('a proposal that a record purge already erased is reported as already erased', async () => {
    await raw('src');
    const id = await propose(['src']);
    await store.purge(['src'], evidence);
    const snapshot = everything(root);
    expect(await store.purgeProposal(id, { agent: 'x', rationale: 'y' })).toEqual({ proposalId: id, alreadyErased: true });
    expect(everything(root)).toBe(snapshot);
  });

  test('an unknown or unsafe proposal id is NOT_FOUND, a record id is not a proposal id, and nothing is written', async () => {
    await raw('a-record');
    const id = await propose([]);
    const snapshot = everything(root);
    for (const target of ['no-such-proposal', '../escape', 'a/b', 'a-record', '.corpus-proposals', 'a'.repeat(300)]) {
      await expect(store.purgeProposal(target, evidence), target).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    expect(await store.getProposal('a'.repeat(300))).toBeNull();
    expect(everything(root)).toBe(snapshot);
    // `purge` still takes record ids only.
    await expect(store.purge([id], evidence)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await store.getProposal(id))!.candidate.body).toContain('NEEDLE-CAND');
    expect((await store.get('a-record'))!.status).toBe('active');
  });

  describe('authorization and actor', () => {
    test('it is refused without allowPurge, before any I/O, whatever the proposal', async () => {
      const id = await propose([]);
      const snapshot = everything(root);
      const locked = open(root, { allowPurge: undefined });
      await expect(locked.purgeProposal(id, evidence)).rejects.toMatchObject({ code: 'READ_ONLY' });
      await expect(open(root, { allowPurge: 'yes' }).purgeProposal(id, evidence)).rejects.toMatchObject({ code: 'READ_ONLY' });
      await expect(locked.purgeProposal('no-such-proposal', evidence)).rejects.toMatchObject({ code: 'READ_ONLY' });
      expect(everything(root)).toBe(snapshot);
    });

    test('the actor and the reason are required and bounded as for purge, and nothing is written when they are not', async () => {
      const id = await propose([]);
      const snapshot = everything(root);
      for (const bad of [
        { agent: '', rationale: 'r' },
        { agent: '  ', rationale: 'r' },
        { agent: 'a', rationale: '' },
        { agent: 'a', rationale: 'r', note: 5 },
        { agent: 'a'.repeat(1025), rationale: 'r' },
        { agent: 'a', rationale: 'r'.repeat(8 * 1024) },
        { agent: 'a', rationale: 'r', note: '\u0001'.repeat(1400) },
        undefined,
        null,
      ]) {
        await expect(store.purgeProposal(id, bad as never), JSON.stringify(bad)?.slice(0, 40)).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });
      }
      for (const badId of ['', 5, null, undefined, {}]) {
        await expect(store.purgeProposal(badId as never, evidence), String(badId)).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });
      }
      expect(everything(root)).toBe(snapshot);
    });

    test('the erasing agent is the settler of a pending proposal, so the proposer cannot be mistaken for the reviewer', async () => {
      const id = await propose([]);
      await store.purgeProposal(id, { agent: 'proposer-1', rationale: 'withdrawn by the proposer' });
      expect(await store.getProposal(id)).toMatchObject({ state: 'rejected', proposer_id: 'proposer-1', reviewer_id: 'proposer-1', erasure: { agent: 'proposer-1' } });
    });

    test('the root binding and its marker survive an erasure, and a different root still does not match', async () => {
      const binding = store.rootBinding();
      const marker = readFileSync(join(root, '.corpus-root-id'), 'utf8');
      const id = await propose([]);
      await store.purgeProposal(id, evidence);
      await store.reindex();
      expect(store.rootBinding()).toBe(binding);
      expect(readFileSync(join(root, '.corpus-root-id'), 'utf8')).toBe(marker);
      expect(() => assertAdapterBoundTo(store, root)).not.toThrow();
      expect(open().rootBinding()).toBe(binding);
      const other = join(base, 'other');
      open(other);
      expect(() => assertAdapterBoundTo(store, other)).toThrow(expect.objectContaining({ code: 'ROOT_BINDING_MISMATCH' }));
    });
  });

  describe('request keys', () => {
    const keyed = async (state: 'pending' | 'rejected' | 'applied', requestKey: string) => {
      const id = await propose([], {}, { requestKey });
      if (state === 'rejected') await store.rejectCreate(id, 'reviewer-2', 'Reviewer prose NEEDLE-REVIEW');
      if (state === 'applied') await store.applyCreate(id, 'reviewer-1');
      return id;
    };

    test.each(['pending', 'rejected', 'applied'] as const)('a retry after erasing a %s proposal is refused, with the same or different input, and writes nothing', async (state) => {
      const id = await keyed(state, 'opaque-key-RETRY');
      const digest = (await store.getProposal(id))!.request_digest!;
      await store.purgeProposal(id, evidence);
      const erased = (await store.getProposal(id))!;
      expect(erased).toMatchObject({ request_key_retired: true });
      expect(erased.request_key_hash).toBe(sha256('opaque-key-RETRY'));
      expect(erased).not.toHaveProperty('request_digest');
      expect(erased).not.toHaveProperty('request_digest_version');
      const bytes = everything(root);
      expect(bytes).not.toContain(digest);
      expect(bytes).not.toContain('opaque-key-RETRY');
      for (const attempt of [candidate([]), candidate([], { body: 'something else' })]) {
        const error = await store.proposeCreate(attempt, 'proposer-1', proposalEvidence(), { requestKey: 'opaque-key-RETRY' }).catch((caught: Error) => caught);
        // Refused as a retired key: not compared with anything, never answered with the erased proposal's id.
        expect(error).toMatchObject({ code: 'REQUEST_KEY_CONFLICT', message: expect.stringMatching(/retired/) });
      }
      expect(everything(root)).toBe(bytes);
      expect(await store.listProposals()).toHaveLength(1);
      // Reopening changes nothing about it.
      await expect(open().proposeCreate(candidate([]), 'proposer-1', proposalEvidence(), { requestKey: 'opaque-key-RETRY' })).rejects.toMatchObject({ code: 'REQUEST_KEY_CONFLICT' });
    });

    test('other keys, and the same content without a key, still stage — as new proposals, never the erased one', async () => {
      const id = await keyed('pending', 'key-one');
      const kept = await keyed('pending', 'key-two');
      await store.purgeProposal(id, evidence);
      expect((await store.getProposal(kept))!.state).toBe('pending');
      expect(await propose([], {}, { requestKey: 'key-two' })).toBe(kept);
      const fresh = await propose([]);
      expect(fresh).not.toBe(id);
      expect((await store.getProposal(id))!.candidate.body).toBe('');
      expect((await store.getProposal(fresh))!.candidate.body).toContain('NEEDLE-CAND');
    });
  });

  describe('concurrent settlement', () => {
    test('erase holds the lock while an apply is queued: the apply finds a rejected, erased proposal and creates nothing', async () => {
      const id = await propose([]);
      const gate = gatedLock();
      const eraser = open(root, { lock: gate.lock });
      const applier = open();
      gate.arm();
      const erasing = eraser.purgeProposal(id, evidence);
      await gate.entered;
      const applying = applier.applyCreate(id, 'reviewer-1').catch((error: Error) => error);
      gate.release();
      expect(await erasing).toEqual({ proposalId: id, alreadyErased: false });
      // Refused because the proposal is settled, not because its erased candidate happens to be invalid.
      expect(await applying, 'applyCreate after erasure must be refused').toMatchObject({ code: 'MISSING_EVIDENCE', message: expect.stringMatching(/is rejected, not pending/) });
      expect(await store.listByType('concept', { includeHistory: true })).toEqual([]);
      expect(await store.getProposal(id)).toMatchObject({ state: 'rejected', erasure: { agent: 'privacy-officer' } });
      noContent();
    });

    test('apply holds the lock while an erase is queued: the erase purges the record it made, so nothing is left', async () => {
      const id = await propose([]);
      const gate = gatedLock();
      const applier = open(root, { lock: gate.lock });
      const eraser = open();
      gate.arm();
      const applying = applier.applyCreate(id, 'reviewer-1');
      await gate.entered;
      const erasing = eraser.purgeProposal(id, evidence);
      gate.release();
      const recordId = await applying;
      const result = await erasing;
      expect(result.record).toMatchObject({ purged: [recordId], proposalsScrubbed: [id] });
      expect((await store.get(recordId))!.status).toBe('purged');
      expect(await store.getProposal(id)).toMatchObject({ state: 'applied', record_id: recordId, erasure: { agent: 'privacy-officer' } });
      noContent();
    });

    test('a reject that holds the lock leaves its rationale for the queued erase to remove; an erase first leaves a reject nothing to settle', async () => {
      const first = await propose([]);
      const gate = gatedLock();
      const rejecter = open(root, { lock: gate.lock });
      const eraser = open();
      gate.arm();
      const rejecting = rejecter.rejectCreate(first, 'reviewer-2', 'Reviewer prose NEEDLE-REVIEW');
      await gate.entered;
      const erasing = eraser.purgeProposal(first, evidence);
      gate.release();
      await rejecting;
      expect(await erasing).toEqual({ proposalId: first, alreadyErased: false });
      expect(await store.getProposal(first)).toMatchObject({ state: 'rejected', reviewer_id: 'reviewer-2', rationale: '[purged]' });

      const second = await propose([]);
      const gate2 = gatedLock();
      const eraser2 = open(root, { lock: gate2.lock });
      gate2.arm();
      const erasing2 = eraser2.purgeProposal(second, evidence);
      await gate2.entered;
      const rejecting2 = open().rejectCreate(second, 'reviewer-2', 'Reviewer prose NEEDLE-REVIEW').catch((error: Error) => error);
      gate2.release();
      await erasing2;
      expect(await rejecting2, 'rejectCreate after erasure must be refused').toMatchObject({ code: 'MISSING_EVIDENCE', message: expect.stringMatching(/is rejected, not pending/) });
      expect(await store.getProposal(second)).toMatchObject({ reviewer_id: 'privacy-officer', rationale: 'erasure request 42' });
      noContent();
    });

    test('two erasers racing: one erases and the other finds it erased', async () => {
      const id = await propose([]);
      const [a, b] = await Promise.all([open().purgeProposal(id, evidence), open().purgeProposal(id, { agent: 'second', rationale: 'second request' })]);
      expect([a.alreadyErased, b.alreadyErased].sort()).toEqual([false, true]);
      expect((await store.getProposal(id))!.erasure).toBeDefined();
      noContent();
    });

    test('whichever of an unordered apply and an erase wins, nothing of the candidate survives and no live record exists', async () => {
      for (let round = 0; round < 6; round++) {
        const id = await propose([], { body: `Secret body NEEDLE-CAND ${round}` });
        const [applied, erased] = await Promise.allSettled([open().applyCreate(id, 'reviewer-1'), open().purgeProposal(id, evidence)]);
        expect(erased.status, `round ${round}`).toBe('fulfilled');
        if (applied.status === 'rejected') expect((applied.reason as { code: string }).code).toBe('MISSING_EVIDENCE');
        expect(await store.listByType('concept', { includeHistory: false })).toEqual([]);
        expect((await store.getProposal(id))!.erasure).toBeDefined();
        noContent();
      }
    });
  });

  describe('interrupted erasure', () => {
    const crash = (phase: string, id: string) =>
      spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/purge-proposal-crash.ts', import.meta.url)), base, profile, phase, id], { encoding: 'utf8', timeout: 60_000 });
    const journalPath = () => join(root, '.station-knowledge-transaction.json');
    const journalText = () => {
      const journal = JSON.parse(readFileSync(journalPath(), 'utf8')) as { phase: string; entries: Array<{ before: string | null; after: string | null }> };
      return { phase: journal.phase, bytes: journal.entries.flatMap((entry) => [entry.before, entry.after]).filter((side): side is string => side !== null).map((side) => Buffer.from(side, 'base64').toString('utf8')).join('\n') };
    };

    test('a crash before anything is published rolls back whole: the proposal and its key are exactly as they were, and the erasure can be retried', async () => {
      const id = await propose([], {}, { requestKey: 'crash-key' });
      const path = join(root, '.corpus-proposals', `${id}.json`);
      const original = readFileSync(path, 'utf8');
      const interrupted = crash('prepared', id);
      expect(interrupted.status, interrupted.stderr).toBe(23);
      expect(JSON.parse(readFileSync(journalPath(), 'utf8'))).toMatchObject({ phase: 'prepared', operation: 'purgeProposal' });
      expect(readFileSync(path, 'utf8')).toBe(original);

      const recovered = open();
      expect(await recovered.getProposal(id)).toMatchObject({ state: 'pending', candidate: { body: expect.stringContaining('NEEDLE-CAND') } });
      expect(existsSync(journalPath())).toBe(false);
      expect(readFileSync(path, 'utf8')).toBe(original);
      // The key was not retired by the half-done attempt.
      expect(await propose([], {}, { requestKey: 'crash-key' })).toBe(id);
      expect(await recovered.purgeProposal(id, evidence)).toEqual({ proposalId: id, alreadyErased: false });
      noContent();
    });

    test.each(['final-publish', 'committed'])('a crash at %s leaves the erasure applied whole: erased, journal cleared, key retired, and a retry is a no-op', async (phase) => {
      const id = await propose([], {}, { requestKey: 'crash-key' });
      const interrupted = crash(phase, id);
      expect(interrupted.status, interrupted.stderr).toBe(23);
      if (phase === 'committed') {
        // A journal left after the commit marker holds none of the erased content.
        const journal = journalText();
        expect(journal.phase).toBe('committed');
        for (const needle of NEEDLES) expect(journal.bytes, needle).not.toContain(needle);
      }
      const recovered = open();
      const after = (await recovered.getProposal(id))!;
      expect(after).toMatchObject({ state: 'rejected', erasure: { agent: 'privacy-officer', rationale: 'crash drill' }, candidate: stub([]), request_key_retired: true });
      expect(existsSync(journalPath())).toBe(false);
      noContent();
      const snapshot = everything(root);
      expect(await recovered.purgeProposal(id, evidence)).toEqual({ proposalId: id, alreadyErased: true });
      expect(everything(root)).toBe(snapshot);
      await expect(propose([], {}, { requestKey: 'crash-key' })).rejects.toMatchObject({ code: 'REQUEST_KEY_CONFLICT' });
    });

    test.each(['prepared', 'first-publish', 'final-publish', 'committed'])('an applied proposal interrupted at %s is wholly erased or wholly intact, never a record without its proposal', async (phase) => {
      const id = await propose([]);
      const recordId = await store.applyCreate(id, 'reviewer-1');
      const interrupted = crash(phase, id);
      expect(interrupted.status, interrupted.stderr).toBe(23);
      const recovered = open();
      const record = (await recovered.get(recordId))!;
      const proposal = (await recovered.getProposal(id))!;
      if (phase === 'prepared' || phase === 'first-publish') {
        expect(record.status, 'rolled back').toBe('active');
        expect(proposal.erasure, 'rolled back').toBeUndefined();
        expect(proposal.candidate.body).toContain('NEEDLE-CAND');
        expect(await recovered.purgeProposal(id, evidence)).toMatchObject({ alreadyErased: false, record: { purged: [recordId] } });
      } else {
        expect(record.status).toBe('purged');
        expect(proposal.erasure).toBeDefined();
      }
      expect(existsSync(journalPath())).toBe(false);
      expect((await recovered.get(recordId))!.status).toBe('purged');
      expect((await recovered.getProposal(id))!.erasure).toBeDefined();
      noContent();
    });
  });

  test('a corrupt proposal is not erased, and a corrupt neighbour does not stop the erasure of a pending one', async () => {
    const id = await propose([]);
    const path = join(root, '.corpus-proposals', `${id}.json`);
    const original = readFileSync(path, 'utf8');
    const variants: Record<string, (value: Record<string, unknown>) => void> = {
      'an erasure marker over intact content': (value) => { value.erasure = { at: new Date().toISOString(), agent: 'x', rationale: 'y' }; },
      'a candidate without provenance': (value) => { value.candidate = { body: 'SECRET-BODY' }; },
      'links that are not links': (value) => { (value.candidate as { links: unknown }).links = ['x']; },
    };
    for (const [name, change] of Object.entries(variants)) {
      const value = JSON.parse(original) as Record<string, unknown>;
      change(value);
      writeFileSync(path, JSON.stringify(value));
      const before = everything(root);
      await expect(store.purgeProposal(id, evidence), name).rejects.toThrow(/corrupt/);
      expect(everything(root), name).toBe(before);
    }
    writeFileSync(path, original);
    writeFileSync(join(root, '.corpus-proposals', 'broken.json'), '{not json');
    await expect(store.purgeProposal(id, evidence)).resolves.toEqual({ proposalId: id, alreadyErased: false });
    await expect(store.purgeProposal('broken', evidence)).rejects.toThrow(/corrupt/);
  });

  test('evidence at its bounds fits next to the largest pending proposal staging allows', async () => {
    const body = 'x'.repeat(16 * 1024 * 1024 - 64 * 1024 - 4000);
    const id = await store.proposeCreate(candidate([], { body }), 'p'.repeat(1000), { agent: 'd'.repeat(500), proposal: 'z'.repeat(500) });
    const result = await store.purgeProposal(id, { agent: 'a'.repeat(1000), rationale: '\u0001'.repeat(1300), note: '\u0001'.repeat(1300) });
    expect(result.alreadyErased).toBe(false);
    expect((await store.getProposal(id))!.candidate.body).toBe('');
  }, 60_000);


  test('a record whose file is gone: the default layout erases the proposal and rebuilds the derived indexes, the vault refuses as corrupt', async () => {
    const id = await propose([], { aliases: ['team/needle-alias'], links: [{ target_id: 'anchor', kind: 'related', label: 'NEEDLE-LABEL' }] });
    await raw('anchor');
    // A candidate's links are checked at apply, so link the created record to the anchor afterwards.
    const recordId = await store.applyCreate(id, 'reviewer-1');
    await store.link(recordId, [{ target_id: 'anchor', kind: 'related', label: 'NEEDLE-LABEL' }], { agent: 'editor' });
    expect(everything(root)).toContain('needle-alias');
    const recordFile = profile === 'default'
      ? join(root, 'records', `${recordId}.md`)
      : join(root, (JSON.parse(readFileSync(join(root, 'path-index.json'), 'utf8')) as { by_id: Record<string, { path: string }> }).by_id[recordId].path);
    rmSync(recordFile);
    if (profile === 'default') {
      await expect(store.purgeProposal(id, evidence)).resolves.toEqual({ proposalId: id, alreadyErased: false });
      expect((await store.getProposal(id))!.erasure).toBeDefined();
      // The alias and the link label lived in the derived indexes, which no longer name the record.
      for (const needle of ['needle-alias', 'NEEDLE-LABEL', 'NEEDLE-CAND']) expect(everything(root), needle).not.toContain(needle);
    } else {
      const before = everything(root);
      await expect(store.purgeProposal(id, evidence)).rejects.toThrow(/missing record/);
      expect(everything(root)).toBe(before);
      expect((await store.getProposal(id))!.erasure).toBeUndefined();
    }
  });

  if (profile === 'default') {
    test('a record whose file is gone but which another record still links to is refused, and erased once it is restored', async () => {
      const id = await propose([], { title: 'NEEDLE-TITLE Sensitive Person' });
      const recordId = await store.applyCreate(id, 'reviewer-1');
      await store.create({ id: 'survivor', type: 'concept', title: 'survivor', body: 'survivor body', category: 'engineering', provenance: { agent: 'creator' }, links: [{ target_id: recordId, kind: 'related', label: 'NEEDLE-TITLE Sensitive Person' }] });
      const file = join(root, 'records', `${recordId}.md`);
      const saved = readFileSync(file, 'utf8');
      rmSync(file);
      const before = everything(root);
      // Nothing can strip the survivor's label while the record is missing, so nothing is erased.
      await expect(store.purgeProposal(id, evidence)).rejects.toThrow(/still refers to it/);
      expect(everything(root)).toBe(before);
      expect((await store.getProposal(id))!.erasure).toBeUndefined();
      writeFileSync(file, saved);
      await expect(store.purgeProposal(id, evidence)).resolves.toMatchObject({ record: { purged: [recordId], referrers: ['survivor'] } });
      noContent();
    });
  }

  if (profile === 'default') {
    test('a record that rests on the missing one only through source_ids blocks the erasure too, and a tombstoned referrer does not', async () => {
      const id = await propose([]);
      const recordId = await store.applyCreate(id, 'reviewer-1');
      await store.create({ id: 'dependent', type: 'concept', title: 'dependent', body: 'DEPENDENT-NEEDLE body', category: 'engineering', provenance: { agent: 'creator', source_ids: [recordId] } });
      await store.create({ id: 'old-referrer', type: 'concept', title: 'old-referrer', body: 'old', category: 'engineering', provenance: { agent: 'creator' }, links: [{ target_id: recordId, kind: 'related', label: 'NEEDLE-LABEL' }] });
      await store.purge(['old-referrer'], { agent: 'someone', rationale: 'earlier' });
      const file = join(root, 'records', `${recordId}.md`);
      const saved = readFileSync(file, 'utf8');
      rmSync(file);
      const before = everything(root);
      await expect(store.purgeProposal(id, evidence)).rejects.toThrow(/dependent still refers to it/);
      expect(everything(root)).toBe(before);
      writeFileSync(file, saved);
      // With the record back, the purge cascades the dependent, which is what the refusal protected.
      await expect(store.purgeProposal(id, evidence)).resolves.toMatchObject({ record: { purged: [recordId], cascaded: ['dependent'] } });
      expect(everything(root)).not.toContain('DEPENDENT-NEEDLE');
      // A tombstone keeps only a link target, so once only tombstones refer to a missing record it does not block.
      const next = await propose([], { aliases: ['team/needle-alias-9'] });
      const nextRecord = await store.applyCreate(next, 'reviewer-1');
      await store.create({ id: 'second-referrer', type: 'concept', title: 'second', body: 'second', category: 'engineering', provenance: { agent: 'creator' }, links: [{ target_id: nextRecord, kind: 'related' }] });
      await store.purge(['second-referrer'], { agent: 'someone', rationale: 'earlier' });
      rmSync(join(root, 'records', `${nextRecord}.md`));
      await expect(store.purgeProposal(next, evidence)).resolves.toEqual({ proposalId: next, alreadyErased: false });
    });
  }

  describe('what the caller hands in is read once', () => {
    test('evidence changed while the call waits for the lock is not what is written', async () => {
      const id = await propose([]);
      const gate = gatedLock();
      const holder = open(root, { lock: gate.lock });
      gate.arm();
      const holding = holder.rejectCreate(await propose([]), 'reviewer-9', 'hold the lock');
      await gate.entered;
      const mutable = { agent: 'privacy-officer', rationale: 'erasure request 42', note: 'ticket 7' };
      const erasing = open().purgeProposal(id, mutable);
      mutable.agent = '';
      mutable.rationale = '';
      gate.release();
      await holding;
      await expect(erasing).resolves.toEqual({ proposalId: id, alreadyErased: false });
      // Still a readable proposal, erased by the actor that was validated.
      expect((await store.getProposal(id))!).toMatchObject({ erasure: { agent: 'privacy-officer', rationale: 'erasure request 42' }, reviewer_id: 'privacy-officer' });
    });

    test('the same holds for an applied proposal, whose record purge gets the snapshot too', async () => {
      const id = await propose([]);
      const recordId = await store.applyCreate(id, 'reviewer-1');
      const gate = gatedLock();
      const holder = open(root, { lock: gate.lock });
      gate.arm();
      const holding = holder.rejectCreate(await propose([]), 'reviewer-9', 'hold the lock');
      await gate.entered;
      const mutable = { agent: 'privacy-officer', rationale: 'erasure request 42' };
      const erasing = open().purgeProposal(id, mutable);
      mutable.agent = '';
      mutable.rationale = '';
      gate.release();
      await holding;
      await expect(erasing).resolves.toMatchObject({ alreadyErased: false, record: { purged: [recordId] } });
      const record = (await store.get(recordId))!;
      expect(record.status).toBe('purged');
      expect(record.mutation_log!.at(-1)).toMatchObject({ op: 'purged', agent: 'privacy-officer', rationale: 'erasure request 42' });
      expect((await store.getProposal(id))!.erasure).toMatchObject({ agent: 'privacy-officer' });
    });

    test('an accessor that answers differently on its second read is read only once', async () => {
      const id = await propose([]);
      const reads: Record<string, number> = {};
      const accessor = (key: string, value: string) => ({ get: () => ((reads[key] = (reads[key] ?? 0) + 1) === 1 ? value : ''), enumerable: true });
      const tricky = Object.defineProperties({}, { agent: accessor('agent', 'privacy-officer'), rationale: accessor('rationale', 'erasure request 42') });
      await expect(store.purgeProposal(id, tricky as never)).resolves.toEqual({ proposalId: id, alreadyErased: false });
      expect((await store.getProposal(id))!.erasure).toMatchObject({ agent: 'privacy-officer', rationale: 'erasure request 42' });
      expect(reads).toEqual({ agent: 1, rationale: 1 });
    });
  });

  test('a field the store does not know does not survive an erasure, and an erased proposal that carries one is corrupt', async () => {
    const id = await propose([]);
    const path = join(root, '.corpus-proposals', `${id}.json`);
    const stored = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...stored, extra: { body: 'NEEDLE-CAND leaked', source_refs: 'NEEDLE-REF', digest: sha256('Secret candidate body NEEDLE-CAND') } }, null, 2));
    expect(everything(root)).toContain('leaked');
    await expect(store.purgeProposal(id, evidence)).resolves.toEqual({ proposalId: id, alreadyErased: false });
    const erased = readFileSync(path, 'utf8');
    expect(erased).not.toContain('extra');
    expect(erased).not.toContain('leaked');
    expect(erased).not.toContain(sha256('Secret candidate body NEEDLE-CAND'));
    noContent();
    // An erased proposal that has gained a field is not what an erasure writes: it is refused, not reported as done.
    writeFileSync(path, JSON.stringify({ ...JSON.parse(erased), extra: { body: 'NEEDLE-CAND again' } }, null, 2));
    await expect(store.purgeProposal(id, evidence)).rejects.toThrow(/corrupt/);
  });

  if (profile === 'vault') {
    test('the migration manifest’s digest of a proposal file is why a vault that still holds it refuses, until the host deletes it', async () => {
      // A real migration: the Kit index is the only one on disk, `migrate` records a sha256 of every file.
      const id = await propose([]);
      await raw('seed');
      renameSync(join(root, 'path-index.json'), join(root, '.graph-index.json'));
      await migrateVaultIndex({ root, coordinationDirectory: join(base, 'coordination'), coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock });
      const manifest = JSON.parse(readFileSync(join(root, '.corpus-store-migration', 'manifest.json'), 'utf8')) as { files: Record<string, string> };
      const original = readFileSync(join(root, '.corpus-proposals', `${id}.json`));
      const digest = manifest.files[`.corpus-proposals/${id}.json`];
      expect(digest, 'the manifest hashes the proposal file').toBe(createHash('sha256').update(original).digest('hex'));

      const before = everything(root);
      await expect(open().purgeProposal(id, evidence)).rejects.toMatchObject({ code: 'READ_ONLY', message: expect.stringMatching(/migration/) });
      expect(everything(root)).toBe(before);
      // The host removes the artifacts, as for `purge`; then the erasure leaves no digest of the proposal behind.
      rmSync(join(root, '.corpus-store-migration'), { recursive: true });
      await expect(open().purgeProposal(id, evidence)).resolves.toEqual({ proposalId: id, alreadyErased: false });
      expect(everything(root)).not.toContain(digest);
      noContent();
    });

    test('a crash during the recovery’s own folder cleanup is finished by the next recovery', async () => {
      const id = await propose([], { category: 'private-category-741', title: 'private-title-741' });
      await store.applyCreate(id, 'reviewer-1');
      const first = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/purge-proposal-crash.ts', import.meta.url)), base, profile, 'committed', id], { encoding: 'utf8', timeout: 60_000 });
      expect(first.status, first.stderr).toBe(23);
      const second = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/purge-proposal-recover-crash.ts', import.meta.url)), base, profile, id], { encoding: 'utf8', timeout: 60_000 });
      expect(second.status, second.stderr).toBe(24);
      // The cleanup did not finish, so the journal that names the folder is still there to finish it.
      expect(existsSync(join(root, '.station-knowledge-transaction.json'))).toBe(true);
      expect(existsSync(join(root, 'private-category-741'))).toBe(true);
      await open().getProposal(id);
      expect(existsSync(join(root, 'private-category-741'))).toBe(false);
      expect(existsSync(join(root, '.station-knowledge-transaction.json'))).toBe(false);
    });

    test('a crash while the journal is being removed has already removed the folder, and recovery only clears the journal', async () => {
      const id = await propose([], { category: 'private-category-741', title: 'private-title-741' });
      await store.applyCreate(id, 'reviewer-1');
      const interrupted = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/purge-proposal-crash.ts', import.meta.url)), base, profile, 'journal-removal', id], { encoding: 'utf8', timeout: 60_000 });
      expect(interrupted.status, interrupted.stderr).toBe(23);
      expect(existsSync(join(root, '.station-knowledge-transaction.json'))).toBe(true);
      expect(existsSync(join(root, 'private-category-741'))).toBe(false);
      await open().getProposal(id);
      expect(existsSync(join(root, '.station-knowledge-transaction.json'))).toBe(false);
    });

    test('a crash after the cleanup removed the innermost folder is finished by the next recovery, through the missing leaf', async () => {
      const id = await propose([], { category: 'private-category-741.nested.deeper', title: 'private-title-741' });
      const recordId = await store.applyCreate(id, 'reviewer-1');
      const note = (JSON.parse(readFileSync(join(root, 'path-index.json'), 'utf8')) as { by_id: Record<string, { path: string }> }).by_id[recordId].path;
      const innermost = join(root, dirname(note));
      expect(dirname(note).split('/').length, 'the category routes into nested folders').toBeGreaterThan(2);
      const first = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/purge-proposal-crash.ts', import.meta.url)), base, profile, 'committed', id], { encoding: 'utf8', timeout: 60_000 });
      expect(first.status, first.stderr).toBe(23);
      const second = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/purge-proposal-recover-crash.ts', import.meta.url)), base, profile, id, innermost], { encoding: 'utf8', timeout: 60_000 });
      expect(second.status, second.stderr).toBe(24);
      expect(existsSync(innermost), 'the interrupted pass removed the innermost folder').toBe(false);
      expect(existsSync(join(root, 'private-category-741')), 'its ancestors are still there').toBe(true);
      expect(existsSync(join(root, '.station-knowledge-transaction.json'))).toBe(true);
      await open().getProposal(id);
      expect(existsSync(join(root, 'private-category-741'))).toBe(false);
      expect(existsSync(join(root, '.station-knowledge-transaction.json'))).toBe(false);
    });

    test('a crash at the commit marker leaves no emptied folder named for the erased record once the store recovers', async () => {
      const id = await propose([], { category: 'private-category-741', title: 'private-title-741' });
      await store.applyCreate(id, 'reviewer-1');
      expect(existsSync(join(root, 'private-category-741'))).toBe(true);
      for (const phase of ['committed', 'final-publish']) {
        const interrupted = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/purge-proposal-crash.ts', import.meta.url)), base, profile, phase, id], { encoding: 'utf8', timeout: 60_000 });
        expect(interrupted.status, interrupted.stderr).toBe(23);
        await open().getProposal(id);
        expect(existsSync(join(root, 'private-category-741')), phase).toBe(false);
        expect(everything(root), phase).not.toContain('private-title-741');
        if (phase === 'committed') {
          // Erase a second one at the other phase.
          const next = await propose([], { category: 'private-category-741', title: 'private-title-741', aliases: ['team/needle-alias-2'] });
          await store.applyCreate(next, 'reviewer-1');
          const second = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/purge-proposal-crash.ts', import.meta.url)), base, profile, 'final-publish', next], { encoding: 'utf8', timeout: 60_000 });
          expect(second.status, second.stderr).toBe(23);
          await open().getProposal(next);
          expect(existsSync(join(root, 'private-category-741')), 'final-publish').toBe(false);
          break;
        }
      }
    });
  }

  if (profile === 'vault') {
    test('a vault that opens read-only refuses it, and one holding migration artifacts refuses every proposal', async () => {
      const readOnlyRoot = join(base, 'kit-v1');
      cpSync(fileURLToPath(new URL('./fixtures/kit-v1/kit-vault', import.meta.url)), readOnlyRoot, { recursive: true });
      await expect(open(readOnlyRoot).purgeProposal('anything', evidence)).rejects.toMatchObject({ code: 'READ_ONLY' });

      const pending = await propose([]);
      const applied = await propose([], { body: 'Another secret NEEDLE-CAND' });
      await store.applyCreate(applied, 'reviewer-1');
      mkdirSync(join(root, '.corpus-store-migration'), { recursive: true });
      writeFileSync(join(root, '.corpus-store-migration', 'manifest.json'), '{}');
      const before = everything(root);
      for (const target of [applied, pending]) await expect(store.purgeProposal(target, evidence), target).rejects.toMatchObject({ code: 'READ_ONLY' });
      expect(everything(root)).toBe(before);
    });
  }
});
