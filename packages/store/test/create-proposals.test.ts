import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  KitDefaultStoreAdapter,
  KitObsidianStoreAdapter,
  standaloneFileMutationLock,
  type CreateInput,
  type KnowledgeStoreAdapter,
  type KnowledgeStoreCreateProposals,
} from '../src/index.js';
import { SelfApprovalError, isKnowledgeStoreError } from '../src/errors.js';

type Store = KnowledgeStoreAdapter & KnowledgeStoreCreateProposals;

const evidence = { agent: 'distiller', proposal: 'Keep this finding from the session' };
const candidate = (fields: Partial<CreateInput> = {}): CreateInput => ({
  id: 'proposed-record',
  type: 'raw',
  title: 'Proposed finding',
  body: 'Users stall at account setup.',
  category: 'engineering',
  provenance: { agent: 'distiller', session_id: 'session-1', source_ids: ['transcript:abc#sitting-7'], note: 'sitting sitting-7' },
  ...fields,
});

/** Every file under `root`, relative, sorted, with its bytes: a before/after snapshot. */
function tree(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else result[relative(root, path)] = readFileSync(path, 'utf8');
    }
  };
  if (existsSync(root)) walk(root);
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

async function code(promise: Promise<unknown>): Promise<string | undefined> {
  try { await promise; } catch (error) { return (error as { code?: string }).code ?? `no-code:${(error as Error).message}`; }
  return undefined;
}

describe.each([
  ['default', KitDefaultStoreAdapter],
  ['vault', KitObsidianStoreAdapter],
] as const)('create proposals (%s profile)', (_profile, Constructor) => {
  let base: string;
  let root: string;
  let ticks: number;
  let sequence: number;
  let store: Store;
  const open = (storeRoot = root): Store => new Constructor({
    storeRoot,
    coordinationDirectory: join(base, 'coordination'),
    coordinationIdentity: () => () => {},
    lock: standaloneFileMutationLock,
    clock: () => Date.UTC(2026, 10, 3) + ticks++ * 1000,
    ids: () => `generated-${++sequence}`,
  });

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'corpus-create-proposals-'));
    root = join(base, 'store');
    ticks = 0;
    sequence = 0;
    store = open();
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  test('proposeCreate stores a pending proposal with the whole candidate and its provenance, and no record', async () => {
    const proposalId = await store.proposeCreate(candidate(), 'agent-a', evidence);
    expect(proposalId).toMatch(/^generated-\d+$/);
    expect(await store.getProposal(proposalId)).toEqual({
      id: proposalId,
      state: 'pending',
      candidate: candidate(),
      proposer_id: 'agent-a',
      evidence,
      proposed_at: '2026-11-03T00:00:00.000Z',
    });
    expect(await store.get('proposed-record')).toBeNull();
    expect(await store.get(proposalId)).toBeNull();
    expect(await store.listByType('raw')).toEqual([]);
  });

  test('pending and rejected proposals are outside the working set and every ordinary read', async () => {
    await store.create({ ...candidate({ id: 'ordinary' }), title: 'Ordinary' });
    const pending = await store.proposeCreate(candidate({ id: 'pending-record', aliases: ['pending-slug'], ttl_seconds: 1 }), 'agent-a', evidence);
    const rejected = await store.proposeCreate(candidate({ id: 'rejected-record' }), 'agent-a', evidence);
    await store.reject(rejected, 'reviewer', 'not durable');

    const ids = (records: { id: string }[]) => records.map((record) => record.id);
    for (const options of [undefined, { includeHistory: true }, { includeRetired: true }, { stale: true, now: Date.UTC(2030, 0, 1) }, { stale: false }]) {
      expect(ids(await store.listByType('raw', options))).not.toContain('pending-record');
      expect(ids(await store.listByType('raw', options))).not.toContain('rejected-record');
    }
    expect(ids(await store.listByType('raw'))).toEqual(['ordinary']);
    expect(ids(await store.listByCategory('engineering'))).toEqual(['ordinary']);
    expect(ids(await store.listByCategory('engineering', { prefix: true, includeHistory: true }))).toEqual(['ordinary']);
    for (const handle of [pending, rejected, 'pending-record', 'rejected-record', 'pending-slug', 'generated-']) {
      expect(await store.get(handle)).toBeNull();
    }
    expect(await store.getLinks(pending)).toEqual({ forward: [], reverse: [] });
    // A rebuilt index sees only records.
    expect(await (store as unknown as { reindex(): Promise<{ records: number }> }).reindex()).toMatchObject({ records: 1 });
    expect((await store.listProposals({ state: 'pending' })).map((p) => p.id)).toEqual([pending]);
    expect((await store.listProposals({ state: 'rejected' })).map((p) => p.id)).toEqual([rejected]);
  });

  test('apply creates the record in one transaction, linked back to the proposal and its evidence', async () => {
    const proposalId = await store.proposeCreate(candidate({ tags: ['t'], links: [] }), 'agent-a', evidence);
    expect(await store.apply(proposalId, 'reviewer-b')).toBe('proposed-record');

    const record = await store.get('proposed-record');
    expect(record).toMatchObject({
      id: 'proposed-record',
      type: 'raw',
      title: 'Proposed finding',
      body: 'Users stall at account setup.',
      tags: ['t'],
      status: 'active',
      provenance: candidate().provenance,
    });
    expect(record?.mutation_log).toEqual([{
      op: 'apply-create',
      at: record!.created_at,
      agent: 'reviewer-b',
      evidence: { proposal_id: proposalId, proposer_id: 'agent-a', proposal_evidence: evidence },
    }]);
    expect(await store.getProposal(proposalId)).toMatchObject({
      state: 'applied', reviewer_id: 'reviewer-b', record_id: 'proposed-record', decided_at: record!.created_at,
    });
    expect((await store.listByType('raw')).map((r) => r.id)).toEqual(['proposed-record']);
    expect(await store.listProposals({ state: 'pending' })).toEqual([]);
  });

  test('apply names an id for a candidate without one, and applies its links and aliases', async () => {
    await store.create(candidate({ id: 'source-record' }));
    const proposalId = await store.proposeCreate(
      candidate({ id: undefined, type: 'compiled', aliases: ['proposed-slug'], links: [{ target_id: 'source-record', kind: 'source' }] }),
      'agent-a',
      evidence,
    );
    const recordId = await store.apply(proposalId, 'reviewer-b');
    // The id comes from the store's id service at apply, not from the proposal.
    expect(recordId).toMatch(/^generated-\d+$/);
    expect(recordId).not.toBe(proposalId);
    expect((await store.getProposal(proposalId))?.record_id).toBe(recordId);
    expect((await store.get('proposed-slug'))?.id).toBe(recordId);
    expect((await store.getLinks('source-record')).reverse).toEqual([{ source_id: recordId, kind: 'source' }]);
  });

  test('apply refuses the proposer: SELF_APPROVAL, nothing written, still pending', async () => {
    const proposalId = await store.proposeCreate(candidate(), 'agent-a', evidence);
    const before = tree(root);
    const error = await store.apply(proposalId, 'agent-a').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SelfApprovalError);
    expect(error).toMatchObject({ code: 'SELF_APPROVAL' });
    expect(isKnowledgeStoreError(error)).toBe(true);
    expect(tree(root)).toEqual(before);
    expect(await store.get('proposed-record')).toBeNull();
    expect((await store.getProposal(proposalId))?.state).toBe('pending');
    // A different reviewer still can; the refusal consumed nothing.
    expect(await store.apply(proposalId, 'agent-b')).toBe('proposed-record');
  });

  test('reject keeps the proposal as rejected with its rationale and creates no record', async () => {
    const proposalId = await store.proposeCreate(candidate(), 'agent-a', evidence);
    await store.reject(proposalId, 'reviewer-b', 'Duplicates an existing finding');
    expect(await store.getProposal(proposalId)).toMatchObject({
      state: 'rejected', reviewer_id: 'reviewer-b', rationale: 'Duplicates an existing finding', candidate: candidate(),
    });
    expect(await store.get('proposed-record')).toBeNull();
    // A settled proposal is final.
    expect(await code(store.apply(proposalId, 'reviewer-c'))).toBe('MISSING_EVIDENCE');
    expect(await code(store.reject(proposalId, 'reviewer-c', 'again'))).toBe('MISSING_EVIDENCE');
    expect(await store.get('proposed-record')).toBeNull();
  });

  test('the proposer may withdraw its own proposal by rejecting it', async () => {
    const proposalId = await store.proposeCreate(candidate(), 'agent-a', evidence);
    await store.reject(proposalId, 'agent-a', 'withdrawn');
    expect((await store.getProposal(proposalId))?.state).toBe('rejected');
  });

  test('an applied proposal cannot be applied or rejected again', async () => {
    const proposalId = await store.proposeCreate(candidate(), 'agent-a', evidence);
    await store.apply(proposalId, 'reviewer-b');
    expect(await code(store.apply(proposalId, 'reviewer-b'))).toBe('MISSING_EVIDENCE');
    expect(await code(store.reject(proposalId, 'reviewer-b', 'late'))).toBe('MISSING_EVIDENCE');
    expect((await store.listByType('raw')).length).toBe(1);
  });

  test('apply keeps every create requirement and a refusal leaves the proposal pending', async () => {
    const compiled = await store.proposeCreate(candidate({ type: 'compiled' }), 'agent-a', evidence);
    const before = tree(root);
    expect(await code(store.apply(compiled, 'reviewer-b'))).toBe('MISSING_EVIDENCE');
    expect(tree(root)).toEqual(before);
    expect((await store.getProposal(compiled))?.state).toBe('pending');

    await store.create(candidate({ id: 'taken-slug-owner', aliases: ['taken-slug'] }));
    const clash = await store.proposeCreate(candidate({ id: 'clash', aliases: ['taken-slug'] }), 'agent-a', evidence);
    expect(await code(store.apply(clash, 'reviewer-b'))).toBe('SLUG_CONFLICT');
    expect((await store.getProposal(clash))?.state).toBe('pending');
    expect(await store.get('clash')).toBeNull();

    // The id was free at proposal time and taken before apply.
    const raced = await store.proposeCreate(candidate({ id: 'raced' }), 'agent-a', evidence);
    await store.create(candidate({ id: 'raced' }));
    expect(await code(store.apply(raced, 'reviewer-b'))).toBe('MISSING_EVIDENCE');
    expect((await store.getProposal(raced))?.state).toBe('pending');
  });

  test('the record and the settled proposal publish together: a failure after the record write leaves neither', async () => {
    const proposalId = await store.proposeCreate(candidate(), 'agent-a', evidence);
    const before = tree(root);
    const proposals = (store as unknown as { proposals: { settle(...args: unknown[]): void } }).proposals;
    const settle = vi.spyOn(proposals, 'settle').mockImplementation(() => { throw new Error('injected failure after the record write'); });
    await expect(store.apply(proposalId, 'reviewer-b')).rejects.toThrow('injected failure');
    settle.mockRestore();
    expect(tree(root)).toEqual(before);
    expect(await store.get('proposed-record')).toBeNull();
    expect((await store.getProposal(proposalId))?.state).toBe('pending');
  });

  test('proposeCreate refuses what create would refuse, and missing evidence', async () => {
    const cases: [string, () => Promise<unknown>][] = [
      ['missing title', () => store.proposeCreate(candidate({ title: ' ' }), 'agent-a', evidence)],
      ['missing body', () => store.proposeCreate(candidate({ body: '' }), 'agent-a', evidence)],
      ['bad type', () => store.proposeCreate(candidate({ type: 'nope' as never }), 'agent-a', evidence)],
      ['bad category', () => store.proposeCreate(candidate({ category: 'a..b' }), 'agent-a', evidence)],
      ['no provenance agent', () => store.proposeCreate(candidate({ provenance: {} as never }), 'agent-a', evidence)],
      ['bad ttl', () => store.proposeCreate(candidate({ ttl_seconds: -1 }), 'agent-a', evidence)],
      ['no candidate', () => store.proposeCreate(undefined as never, 'agent-a', evidence)],
      ['not serializable', () => store.proposeCreate(candidate({ tags: [1n as never] }), 'agent-a', evidence)],
      ['no proposer', () => store.proposeCreate(candidate(), '', evidence)],
      ['no evidence', () => store.proposeCreate(candidate(), 'agent-a', undefined as never)],
      ['no evidence agent', () => store.proposeCreate(candidate(), 'agent-a', { agent: '', proposal: 'x' })],
      ['blank evidence proposal', () => store.proposeCreate(candidate(), 'agent-a', { agent: 'a', proposal: '  ' })],
    ];
    for (const [label, run] of cases) expect([label, await code(run())]).toEqual([label, 'MISSING_EVIDENCE']);
    await store.create(candidate({ id: 'existing' }));
    expect(await code(store.proposeCreate(candidate({ id: 'existing' }), 'agent-a', evidence))).toBe('MISSING_EVIDENCE');
    expect(await store.listProposals()).toEqual([]);
  });

  test('apply and reject refuse an unknown proposal, a blank reviewer and a blank rationale', async () => {
    expect(await code(store.apply('no-such-proposal', 'reviewer'))).toBe('NOT_FOUND');
    expect(await code(store.reject('no-such-proposal', 'reviewer', 'why'))).toBe('NOT_FOUND');
    expect(await code(store.apply('../escape', 'reviewer'))).toBe('NOT_FOUND');
    expect(await store.getProposal('../escape')).toBeNull();
    const proposalId = await store.proposeCreate(candidate(), 'agent-a', evidence);
    expect(await code(store.apply(proposalId, ''))).toBe('MISSING_EVIDENCE');
    expect(await code(store.reject(proposalId, '', 'why'))).toBe('MISSING_EVIDENCE');
    expect(await code(store.reject(proposalId, 'reviewer', '  '))).toBe('MISSING_EVIDENCE');
    expect((await store.getProposal(proposalId))?.state).toBe('pending');
  });

  test('listProposals filters by state, orders by proposal time, and refuses an unknown state', async () => {
    const first = await store.proposeCreate(candidate({ id: 'one' }), 'agent-a', evidence);
    const second = await store.proposeCreate(candidate({ id: 'two' }), 'agent-a', evidence);
    const third = await store.proposeCreate(candidate({ id: 'three' }), 'agent-a', evidence);
    await store.apply(first, 'reviewer');
    await store.reject(third, 'reviewer', 'no');
    const ids = async (options?: Parameters<Store['listProposals']>[0]) => (await store.listProposals(options)).map((p) => p.id);
    expect(await ids()).toEqual([first, second, third]);
    expect(await ids({ state: 'pending' })).toEqual([second]);
    expect(await ids({ state: 'applied' })).toEqual([first]);
    expect(await ids({ state: ['applied', 'rejected'] })).toEqual([first, third]);
    expect(await code(store.listProposals({ state: 'proposed' as never }))).toBe('MISSING_EVIDENCE');
    expect(await code(store.listProposals({ state: ['pending', 'bogus'] as never }))).toBe('MISSING_EVIDENCE');
  });

  test('the concept-proposal forms of apply and reject keep their meaning', async () => {
    const concept = await store.create(candidate({ id: 'concept-1', type: 'concept' }));
    const proposer = await store.create(candidate({ id: 'proposer-1' }));
    await store.propose(concept, proposer, { agent: 'a', proposal: 'new wording' });
    // Passing the third argument, even undefined, is the concept form: it needs evidence.
    expect(await code(store.apply(concept, proposer, undefined as never))).toBe('MISSING_EVIDENCE');
    await store.apply(concept, proposer, { agent: 'a', new_body: 'new wording', rationale: 'better' });
    expect((await store.get(concept))?.body).toBe('new wording');
    await store.reject(concept, proposer, { agent: 'a', reason: 'changed my mind' });
    expect(await code(store.reject(concept, proposer, undefined as never))).toBe('MISSING_EVIDENCE');
    expect(await store.listProposals()).toEqual([]);
  });

  test('a corrupt proposal file is refused, not skipped', async () => {
    const proposalId = await store.proposeCreate(candidate(), 'agent-a', evidence);
    const path = join(root, 'proposals', `${proposalId}.json`);
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    for (const broken of ['{not json', JSON.stringify({ ...stored, id: 'other' }), JSON.stringify({ ...stored, state: 'applied' }), JSON.stringify({ ...stored, state: 'weird' })]) {
      writeFileSync(path, broken);
      await expect(store.getProposal(proposalId)).rejects.toMatchObject({ name: 'KnowledgeStoreCorruptionError' });
      await expect(store.listProposals()).rejects.toMatchObject({ name: 'KnowledgeStoreCorruptionError' });
    }
  });

  test('the store writes only under the root it was given and the host coordination directory', async () => {
    const home = join(base, 'ambient-home');
    mkdirSync(home);
    const env = { HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
    Object.assign(process.env, { HOME: home, XDG_DATA_HOME: home, XDG_CONFIG_HOME: home });
    try {
      const other = join(base, 'second-store');
      const second = open(other);
      const proposalId = await second.proposeCreate(candidate(), 'agent-a', evidence);
      await second.apply(proposalId, 'reviewer');
      // The first store, over a different root, sees none of it.
      expect(await store.listProposals()).toEqual([]);
      expect(await store.get('proposed-record')).toBeNull();
      expect(tree(home)).toEqual({});
    } finally {
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
    expect(() => new Constructor({} as never)).toThrow('storeRoot is required');
    expect(readdirSync(base).sort()).toEqual(['ambient-home', 'coordination', 'second-store', 'store']);
  });
});

describe('create proposals on a read-only vault', () => {
  test('every create-proposal mutation refuses READ_ONLY and reads still work', async () => {
    const base = mkdtempSync(join(tmpdir(), 'corpus-create-proposals-ro-'));
    try {
      const root = join(base, 'kit-vault');
      cpSync(fileURLToPath(new URL('./fixtures/kit-v1/kit-vault', import.meta.url)), root, { recursive: true });
      const store = new KitObsidianStoreAdapter({
        storeRoot: root,
        coordinationDirectory: join(base, 'coordination'),
        coordinationIdentity: () => () => {},
        lock: standaloneFileMutationLock,
      });
      const before = tree(root);
      expect(await code(store.proposeCreate(candidate(), 'agent-a', evidence))).toBe('READ_ONLY');
      expect(await code(store.apply('p', 'reviewer'))).toBe('READ_ONLY');
      expect(await code(store.reject('p', 'reviewer', 'no'))).toBe('READ_ONLY');
      expect(await store.listProposals()).toEqual([]);
      expect(tree(root)).toEqual(before);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
