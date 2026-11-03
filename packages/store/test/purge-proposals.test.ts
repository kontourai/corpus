/**
 * Purge and create proposals (owner decisions 2026-11-02 and 2026-11-03). A proposal holds
 * its whole candidate in every state, outside every record path, so a purge has to reach it
 * on its own. Both profiles run every test.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
const proposal = (text = 'because') => ({ agent: 'drafter', proposal: text });

function open(profile: 'default' | 'vault', root: string): Store {
  const Constructor = profile === 'default' ? KitDefaultStoreAdapter : KitObsidianStoreAdapter;
  return new Constructor({
    storeRoot: root,
    coordinationDirectory: join(dirname(root), 'coordination'),
    coordinationIdentity: () => () => {},
    lock: standaloneFileMutationLock,
    allowPurge: true,
  }) as unknown as Store;
}

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

describe.each(['default', 'vault'] as const)('purge and create proposals — %s profile', (profile) => {
  let base: string;
  let root: string;
  let store: Store;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), `corpus-purge-proposals-${profile}-`));
    root = join(base, 'store');
    store = open(profile, root);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const raw = (id: string) =>
    store.create({ id, type: 'raw', title: `title of ${id}`, body: `body of ${id}`, category: 'engineering', provenance: { agent: 'creator' } });
  const candidate = (sources: string[], extra: Partial<CreateInput> = {}): CreateInput => ({
    type: 'concept',
    title: 'Secret Candidate Title',
    body: 'Secret candidate body NEEDLE-CAND',
    category: 'engineering',
    provenance: { agent: 'drafter', session_id: 'session-1', source_ids: sources },
    ...extra,
  });

  test('a pending proposal that rests only on a purged record is rejected with the purge rationale, erased, and can never apply', async () => {
    await raw('src');
    const id = await store.proposeCreate(candidate(['src'], { tags: ['secret-tag'] }), 'proposer-1', proposal('Secret proposal text NEEDLE-EVID'));
    const result = await store.purge(['src'], { ...evidence, note: 'ticket 7' });
    expect(result).toMatchObject({ proposalsRejected: [id], proposalsScrubbed: [id], proposalsBlocked: [] });

    const after = (await store.getProposal(id))!;
    expect(after).toMatchObject({
      id,
      state: 'rejected',
      proposer_id: 'proposer-1',
      reviewer_id: 'privacy-officer',
      rationale: 'erasure request 42',
      evidence: { agent: 'drafter', proposal: '[purged]' },
      erasure: { agent: 'privacy-officer', rationale: 'erasure request 42', note: 'ticket 7' },
      candidate: { type: 'concept', title: '[purged]', body: '', category: 'purged', provenance: { agent: 'drafter', session_id: 'session-1', source_ids: ['src'] } },
    });
    expect(after.candidate).not.toHaveProperty('tags');
    expect(everything(root)).not.toMatch(/NEEDLE-CAND|NEEDLE-EVID|Secret Candidate|secret-tag/);

    await expect(store.applyCreate(id, 'reviewer-1')).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });
    expect(await store.listByType('concept', { includeHistory: true })).toEqual([]);
    // Reopening reads the same proposal back.
    expect(await open(profile, root).getProposal(id)).toEqual(after);
  });

  test('a pending proposal with other support is blocked, not erased, and applyCreate refuses the erased support', async () => {
    await raw('gone');
    await raw('kept');
    const id = await store.proposeCreate(
      candidate(['gone', 'kept'], { links: [{ target_id: 'gone', kind: 'related', label: 'Erased Title' }] }),
      'proposer-1',
      proposal(),
    );
    const result = await store.purge(['gone'], evidence);
    expect(result).toMatchObject({ proposalsRejected: [], proposalsScrubbed: [], proposalsBlocked: [id] });

    const after = (await store.getProposal(id))!;
    expect(after.state).toBe('pending');
    expect(after.candidate.body).toBe('Secret candidate body NEEDLE-CAND');
    expect(after.candidate.provenance.source_ids).toEqual(['gone', 'kept']);
    // The label that names the erased record's title goes; the link stays.
    expect(after.candidate.links).toEqual([{ target_id: 'gone', kind: 'related' }]);
    expect(everything(root)).not.toContain('Erased Title');

    await expect(store.applyCreate(id, 'reviewer-1')).rejects.toMatchObject({ code: 'PURGED' });
    expect((await store.getProposal(id))!.state).toBe('pending');
    expect(await store.listByType('concept', { includeHistory: true })).toEqual([]);
    await store.rejectCreate(id, 'reviewer-1', 'rests on erased support');
    expect((await store.getProposal(id))!.state).toBe('rejected');
  });

  test('a pending proposal with no support, or only outside support, is untouched', async () => {
    await raw('gone');
    const none = await store.proposeCreate(candidate([]), 'proposer-1', proposal());
    const outside = await store.proposeCreate(candidate(['external-conversation-1']), 'proposer-1', proposal());
    const result = await store.purge(['gone'], evidence);
    expect(result).toMatchObject({ proposalsRejected: [], proposalsScrubbed: [], proposalsBlocked: [] });
    for (const id of [none, outside]) expect((await store.getProposal(id))).toMatchObject({ state: 'pending', candidate: { body: 'Secret candidate body NEEDLE-CAND' } });
    await expect(store.applyCreate(outside, 'reviewer-1')).resolves.toEqual(expect.any(String));
  });

  test('a proposal that rests on a record that the cascade erased is erased too', async () => {
    await raw('src');
    await store.create({ id: 'mid', type: 'concept', title: 'mid', body: 'mid', category: 'engineering', provenance: { agent: 'creator', source_ids: ['src'] } });
    const id = await store.proposeCreate(candidate(['mid']), 'proposer-1', proposal());
    const result = await store.purge(['src'], evidence);
    expect(result.cascaded).toEqual(['mid']);
    expect(result.proposalsRejected).toEqual([id]);
    expect(everything(root)).not.toContain('NEEDLE-CAND');
  });

  test('an applied proposal is erased when the record it created is purged, and keeps its state and record id', async () => {
    const id = await store.proposeCreate(candidate([]), 'proposer-1', proposal('Secret proposal text NEEDLE-EVID'));
    const recordId = await store.applyCreate(id, 'reviewer-1');
    const result = await store.purge([recordId], evidence);
    expect(result).toMatchObject({ proposalsRejected: [], proposalsScrubbed: [id] });
    expect(await store.getProposal(id)).toMatchObject({
      state: 'applied',
      record_id: recordId,
      reviewer_id: 'reviewer-1',
      evidence: { proposal: '[purged]' },
      erasure: { agent: 'privacy-officer' },
      candidate: { title: '[purged]', body: '' },
    });
    expect(everything(root)).not.toMatch(/NEEDLE-CAND|NEEDLE-EVID|Secret Candidate/);
    const record = (await store.get(recordId))!;
    expect(record.status).toBe('purged');
    // The tombstone keeps its link back to the proposal, not the proposal's text.
    expect(record.mutation_log![0]).toMatchObject({ op: 'apply-create', evidence: { proposal_id: id, proposer_id: 'proposer-1' } });
    expect(JSON.stringify(record)).not.toContain('NEEDLE-EVID');
  });

  test('an applied proposal whose record survives is untouched, and a rejected one that rests only on erased records is erased with its reviewer text', async () => {
    await raw('s1');
    await raw('s2');
    const keeps = await store.proposeCreate(candidate(['s1', 's2']), 'proposer-1', proposal());
    const keptRecord = await store.applyCreate(keeps, 'reviewer-1');
    const refused = await store.proposeCreate(candidate(['s1'], { title: 'Rejected Secret' }), 'proposer-1', proposal());
    await store.rejectCreate(refused, 'reviewer-2', 'Reviewer prose NEEDLE-REVIEW');
    const result = await store.purge(['s1'], evidence);
    expect(result).toMatchObject({ proposalsRejected: [], proposalsScrubbed: [refused], proposalsBlocked: [] });
    expect((await store.getProposal(keeps))).toMatchObject({ state: 'applied', record_id: keptRecord, candidate: { body: 'Secret candidate body NEEDLE-CAND' } });
    expect((await store.get(keptRecord))?.status).toBe('active');
    expect(await store.getProposal(refused)).toMatchObject({
      state: 'rejected',
      reviewer_id: 'reviewer-2',
      rationale: '[purged]',
      candidate: { title: '[purged]' },
      erasure: { agent: 'privacy-officer' },
    });
    expect(everything(root)).not.toMatch(/NEEDLE-REVIEW|Rejected Secret/);
  });

  test('a later purge does not erase a proposal again, and a proposal erased earlier stays as it was', async () => {
    await raw('src');
    await raw('other');
    const id = await store.proposeCreate(candidate(['src']), 'proposer-1', proposal());
    await store.purge(['src'], evidence);
    const first = await store.getProposal(id);
    const second = await store.purge(['other'], { agent: 'someone-else', rationale: 'another request' });
    expect(second).toMatchObject({ proposalsRejected: [], proposalsScrubbed: [] });
    expect(await store.getProposal(id)).toEqual(first);
    expect((await store.purge(['src'], evidence)).alreadyPurged).toEqual(['src']);
  });

  test('proposeCreate refuses a candidate that cites a purged record as a source, and allows a plain reference', async () => {
    await raw('gone');
    await store.purge(['gone'], evidence);
    await expect(store.proposeCreate(candidate(['gone']), 'proposer-1', proposal())).rejects.toMatchObject({ code: 'PURGED' });
    await expect(
      store.proposeCreate(candidate([], { type: 'compiled', links: [{ target_id: 'gone', kind: 'source' }] }), 'proposer-1', proposal()),
    ).rejects.toMatchObject({ code: 'PURGED' });
    const related = await store.proposeCreate(candidate([], { links: [{ target_id: 'gone', kind: 'related' }] }), 'proposer-1', proposal());
    expect((await store.getProposal(related))?.state).toBe('pending');
    expect(await store.listProposals()).toHaveLength(1);
  });

  test('a corrupt proposal stops the purge before anything is written', async () => {
    await raw('src');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(root, '.corpus-proposals'), { recursive: true });
    writeFileSync(join(root, '.corpus-proposals', 'broken.json'), '{not json');
    const before = everything(root);
    await expect(store.purge(['src'], evidence)).rejects.toThrow();
    expect(everything(root)).toBe(before);
    expect((await store.get('src'))?.status).toBe('active');
  });

  test('an oversized agent, rationale or note is refused so a copied tombstone or proposal stays loadable', async () => {
    await raw('src');
    for (const bad of [
      { agent: 'a'.repeat(1025), rationale: 'r' },
      { agent: 'a', rationale: 'r'.repeat(16 * 1024 + 1) },
      { agent: 'a', rationale: 'r', note: 'n'.repeat(16 * 1024 + 1) },
    ]) {
      await expect(store.purge(['src'], bad)).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });
    }
    expect((await store.get('src'))?.status).toBe('active');
  });
});
