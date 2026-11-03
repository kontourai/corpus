import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

  test('request key limits reject whitespace and count UTF-8 bytes', async () => {
    const before = tree(root);
    for (const requestKey of ['', '   ', '\t\n', 'x'.repeat(1025), 'é'.repeat(513), '\ud800', '\udc00', null, 7]) {
      expect(await code(store.proposeCreate(candidate(), 'agent-a', evidence, { requestKey: requestKey as string }))).toBe('MISSING_EVIDENCE');
      expect(tree(root)).toEqual(before);
    }
    for (const requestKey of ['x'.repeat(1024), 'é'.repeat(512), '😀'.repeat(256)]) {
      const id = await store.proposeCreate(candidate(), 'agent-a', evidence, { requestKey });
      expect(await store.proposeCreate(candidate(), 'agent-a', evidence, { requestKey })).toBe(id);
    }
    expect(await store.listProposals()).toHaveLength(3);
  });

  test('erasure scrubs request digest and refuses every retry for the retained key', async () => {
    const input = candidate({ id: 'erased-record' }); const options = { requestKey: 'erased-request' };
    const id = await store.proposeCreate(input, 'agent-a', evidence, options);
    await store.applyCreate(id, 'reviewer');
    // Exercise the shared proposal-write seam used by the sibling purge implementation.
    // This is a simulated scrub, not proof that the unmerged purge operation ran.
    const internal = store as unknown as {
      files: { mutate<T>(op: string, body: () => T): Promise<T> };
      proposals: { get(id: string): Record<string, unknown>; write(value: Record<string, unknown>): void };
    };
    await internal.files.mutate('simulate-erasure', () => {
      const proposal = internal.proposals.get(id);
      internal.proposals.write({ ...proposal, candidate: { ...input, title: '[purged]', body: '', category: 'purged' }, evidence: { agent: evidence.agent, proposal: '[purged]' }, erasure: { at: '2026-11-03T00:00:00.000Z', agent: 'eraser', rationale: 'requested' } });
    });
    const path = join(root, '.corpus-proposals', `${id}.json`); const bytes = readFileSync(path, 'utf8');
    const scrubbed = JSON.parse(bytes);
    expect(scrubbed.request_key_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(scrubbed).not.toHaveProperty('request_digest');
    expect(scrubbed).not.toHaveProperty('request_digest_version');
    expect(bytes).not.toContain(input.body); expect(bytes).not.toContain(evidence.proposal);
    const before = tree(root);
    for (const attempt of [input, { ...input, body: 'different' }]) {
      await expect(store.proposeCreate(attempt, 'agent-a', evidence, options)).rejects.toMatchObject({ code: 'REQUEST_KEY_CONFLICT', message: expect.stringContaining('retired after content scrub') });
      expect(tree(root)).toEqual(before);
    }
    writeFileSync(path, JSON.stringify({ ...scrubbed, request_digest: 'a'.repeat(64), request_digest_version: 1 }));
    await expect(store.getProposal(id)).rejects.toMatchObject({ name: 'KnowledgeStoreCorruptionError' });
  });

  test('partial content scrub retires its request digest and refuses reuse', async () => {
    const input = candidate({ id: 'partial', links: [{ target_id: 'erased-source', kind: 'related', label: 'erased-label' }] });
    const options = { requestKey: 'partial-request' };
    const id = await store.proposeCreate(input, 'agent-a', evidence, options);
    const internal = store as unknown as {
      files: { mutate<T>(op: string, body: () => T): Promise<T> };
      proposals: { get(id: string): Record<string, unknown>; write(value: Record<string, unknown>): void };
    };
    // Simulates #41's partial scrub: a label is removed without full erasure.
    await internal.files.mutate('simulate-label-scrub', () => {
      const proposal = internal.proposals.get(id);
      internal.proposals.write({ ...proposal, candidate: { ...input, links: [{ target_id: 'erased-source', kind: 'related' }] } });
    });
    const path = join(root, '.corpus-proposals', `${id}.json`); const bytes = readFileSync(path, 'utf8'); const scrubbed = JSON.parse(bytes);
    expect(scrubbed.request_key_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(scrubbed.request_key_retired).toBe(true);
    expect(await store.getProposal(id)).toMatchObject({ request_key_retired: true });
    expect(scrubbed).not.toHaveProperty('request_digest'); expect(scrubbed).not.toHaveProperty('request_digest_version');
    expect(bytes).not.toContain('erased-label');
    const before = tree(root);
    for (const attempt of [input, { ...input, body: 'different' }]) {
      expect(await code(store.proposeCreate(attempt, 'agent-a', evidence, options))).toBe('REQUEST_KEY_CONFLICT');
      expect(tree(root)).toEqual(before);
    }
  });

  test('request key digest canonicalizes nested object keys', async () => {
    const first = candidate({ links: [{ target_id: 'source-x', kind: 'related', label: 'label' }] });
    const reordered = candidate({
      provenance: { note: 'sitting sitting-7', source_ids: ['transcript:abc#sitting-7'], session_id: 'session-1', agent: 'distiller' },
      links: [{ label: 'label', kind: 'related', target_id: 'source-x' }],
    });
    const options = { requestKey: 'nested-order' };
    const id = await store.proposeCreate(first, 'agent-a', evidence, options);
    expect(await open().proposeCreate(reordered, 'agent-a', evidence, options)).toBe(id);
    expect((await store.getProposal(id))?.request_digest).toBe('58ebe4238514a655424b6bba85d879e3fb39ffed0c3e822adad098d3becacc67');
  });

  test('request key retries return the original receipt and conflicts write nothing', async () => {
    const options = { requestKey: 'request-1' };
    const id = await store.proposeCreate(candidate(), 'agent-a', evidence, options);
    const before = tree(root);
    expect(await open().proposeCreate(candidate(), 'agent-a', evidence, options)).toBe(id);
    expect(tree(root)).toEqual(before);
    expect(await code(store.proposeCreate(candidate({ title: 'different' }), 'agent-a', evidence, options))).toBe('REQUEST_KEY_CONFLICT');
    expect(tree(root)).toEqual(before);
    expect(await code(store.proposeCreate(candidate(), 'agent-b', evidence, options))).toBe('REQUEST_KEY_CONFLICT');
    expect(await code(store.proposeCreate(candidate(), 'agent-a', { ...evidence, proposal: 'different' }, options))).toBe('REQUEST_KEY_CONFLICT');
    expect(tree(root)).toEqual(before);
    expect(await store.listProposals()).toHaveLength(1);
    await store.applyCreate(id, 'reviewer');
    expect(await open().proposeCreate(candidate(), 'agent-a', evidence, options)).toBe(id);
    expect((await store.getProposal(id))?.state).toBe('applied');
    const other = await store.proposeCreate(candidate({ id: 'other' }), 'agent-a', evidence);
    await store.rejectCreate(other, 'reviewer', 'no');
    const rejected = await store.proposeCreate(candidate({ id: 'rejected' }), 'agent-a', evidence, { requestKey: 'request-2' });
    await store.rejectCreate(rejected, 'reviewer', 'no');
    expect(await store.proposeCreate(candidate({ id: 'rejected' }), 'agent-a', evidence, { requestKey: 'request-2' })).toBe(rejected);
  });

  test.each(['before', 'after'] as const)('keyed proposal recovers after a crash %s publication', async (mode) => {
    const child = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/keyed-proposal-crash.ts', import.meta.url)), base, _profile, mode], { encoding: 'utf8', timeout: 30_000 });
    expect(child.status, child.stderr).toBe(mode === 'before' ? 98 : 99);
    const journal = join(root, '.station-knowledge-transaction.json');
    expect(JSON.parse(readFileSync(journal, 'utf8'))).toMatchObject({ phase: 'prepared', operation: 'proposeCreate' });
    const proposalPath = join(root, '.corpus-proposals', 'crash-2.json');
    expect(existsSync(proposalPath)).toBe(mode === 'after');
    // Before publication the one-file proposal has no after-image to undo;
    // this proves recovery clears the journal and retains neither key nor proposal.
    const recovered = await store.listProposals();
    expect(recovered.map((proposal) => proposal.id)).toEqual(mode === 'before' ? [] : ['crash-2']);
    expect(existsSync(journal)).toBe(false);
    const input = candidate({ id: 'crash-record', title: 'Crash', body: 'body', provenance: { agent: 'writer' } });
    const receipt = await store.proposeCreate(input, 'writer', { agent: 'writer', proposal: 'keep' }, { requestKey: 'crash' });
    if (mode === 'after') expect(receipt).toBe('crash-2');
    expect((await store.listProposals()).map((proposal) => proposal.id)).toEqual([receipt]);
    expect(await store.proposeCreate(input, 'writer', { agent: 'writer', proposal: 'keep' }, { requestKey: 'crash' })).toBe(receipt);
  });

  test('direct create safely stores shared reference objects and rejects sparse or inherited shapes', async () => {
    const range = { start: 1, end: 2 };
    const ref = { kind: 'session-transcript' as const, harness: 'h', session_id: 's', transcript_ref: 't', range };
    const refs = Array.from({ length: 60 }, () => ref);
    await store.create(candidate({ id: 'shared-refs', provenance: { agent: 'writer', source_refs: refs } }));
    expect((await store.get('shared-refs'))?.provenance.source_refs).toEqual(refs);
    const sharedNote = Object.entries(tree(root)).find(([name, body]) => name.endsWith('.md') && body.includes('id: shared-refs'))?.[1];
    expect(sharedNote).toBeDefined(); expect(sharedNote).not.toMatch(/&ref_\d+|\*ref_\d+/);
    await store.create(candidate({ id: 'unrelated' }));
    const sparse = new Array(1);
    const inherited = Object.assign(Object.create({ kind: 'session-transcript' }), { harness: 'h', session_id: 's', transcript_ref: 't' });
    const hidden = { ...ref }; Object.defineProperty(hidden, 'kind', { value: 'session-transcript', enumerable: false });
    const customJson = [ref]; Object.defineProperty(customJson, 'toJSON', { value: () => [], enumerable: false });
    for (const invalid of [sparse, [inherited], [hidden], customJson]) {
      const before = tree(root);
      const bad = candidate({ id: 'invalid-ref', provenance: { agent: 'writer', source_refs: invalid } });
      expect(await code(store.create(bad))).toBe('MISSING_EVIDENCE');
      expect(await code(store.proposeCreate(bad, 'writer', evidence))).toBe('MISSING_EVIDENCE');
      expect(tree(root)).toEqual(before);
    }
  });

  test('proposal stores the validated copy even when the array inherits toJSON', async () => {
    const ref = { kind: 'session-transcript' as const, harness: 'h', session_id: 's', transcript_ref: 't' };
    class Refs extends Array<typeof ref> { toJSON() { return []; } }
    const refs = new Refs(ref);
    const input = candidate({ id: 'inherited-array', provenance: { agent: 'writer', source_refs: refs } });
    const id = await store.proposeCreate(input, 'writer', evidence);
    expect((await store.getProposal(id))?.candidate.provenance.source_refs).toEqual([ref]);
    await store.applyCreate(id, 'reviewer');
    expect((await store.get('inherited-array'))?.provenance.source_refs).toEqual([ref]);
    const deceptive = { agent: 'writer', source_refs: [ref], toJSON() { return { agent: 'writer', source_refs: [] }; } };
    const before = tree(root);
    expect(await code(store.proposeCreate(candidate({ id: 'deceptive', provenance: deceptive }), 'writer', evidence))).toBe('MISSING_EVIDENCE');
    expect(tree(root)).toEqual(before);
    const injected = { agent: 'writer', toJSON() { return { agent: 'writer', source_refs: [ref] }; } };
    expect(await code(store.proposeCreate(candidate({ id: 'injected', provenance: injected }), 'writer', evidence))).toBe('MISSING_EVIDENCE');
    let reads = 0;
    const changing = { agent: 'writer', get source_refs() { return reads++ === 0 ? undefined : [ref]; } };
    expect(await code(store.proposeCreate(candidate({ id: 'changing', provenance: changing }), 'writer', evidence))).toBe('MISSING_EVIDENCE');
    expect(tree(root)).toEqual(before);
  });

  test('keyed retries bind structured source references', async () => {
    const ref = { kind: 'session-transcript' as const, harness: 'h', session_id: 's', transcript_ref: 'ref-1' };
    const input = candidate({ id: 'keyed-source', provenance: { agent: 'writer', source_refs: [ref] } });
    const options = { requestKey: 'source-ref-key' };
    const id = await store.proposeCreate(input, 'writer', evidence, options);
    const before = tree(root);
    expect(await store.proposeCreate(input, 'writer', evidence, options)).toBe(id);
    for (const provenance of [{ agent: 'writer', source_refs: [{ ...ref, transcript_ref: 'ref-2' }] }, { agent: 'writer' }]) {
      expect(await code(store.proposeCreate(candidate({ id: 'keyed-source', provenance }), 'writer', evidence, options))).toBe('REQUEST_KEY_CONFLICT');
      expect(tree(root)).toEqual(before);
    }
  });

  test('keyed retry with omitted source references conflicts without writes', async () => {
    const ref = { kind: 'session-transcript' as const, harness: 'h', session_id: 's', transcript_ref: 'ref-1' };
    const options = { requestKey: 'omit-source-ref' };
    await store.proposeCreate(candidate({ id: 'omit-ref', provenance: { agent: 'writer', source_refs: [ref] } }), 'writer', evidence, options);
    const before = tree(root);
    expect(await code(store.proposeCreate(candidate({ id: 'omit-ref', provenance: { agent: 'writer' } }), 'writer', evidence, options))).toBe('REQUEST_KEY_CONFLICT');
    expect(tree(root)).toEqual(before);
  });

  test('empty and omitted source references are distinct for keyed retries', async () => {
    for (const [key, initial, retry] of [
      ['empty-first', { source_refs: [] }, {}],
      ['absent-first', {}, { source_refs: [] }],
    ] as const) {
      const options = { requestKey: key };
      await store.proposeCreate(candidate({ id: 'empty-vs-absent', provenance: { agent: 'writer', ...initial } }), 'writer', evidence, options);
      const before = tree(root);
      expect(await code(store.proposeCreate(candidate({ id: 'empty-vs-absent', provenance: { agent: 'writer', ...retry } }), 'writer', evidence, options))).toBe('REQUEST_KEY_CONFLICT');
      expect(tree(root)).toEqual(before);
    }
  });

  test('accepted source reference boundaries and undefined optional fields survive both paths', async () => {
    const ref = { kind: 'session-transcript' as const, harness: 'é'.repeat(2048), session_id: 'x'.repeat(4096), transcript_ref: 't', sitting_id: undefined, range: undefined };
    const withBoundary = { ...ref, range: { start: 1, end: 1 } };
    const refs = Array.from({ length: 256 }, () => withBoundary);
    const input = candidate({ id: 'boundary', provenance: { agent: 'writer', source_refs: refs } });
    await store.create(input);
    expect((await store.get('boundary'))?.provenance.source_refs).toEqual(refs.map(({ sitting_id: _sitting, ...rest }) => rest));
    const proposal = await store.proposeCreate(candidate({ id: 'undefined-optionals', provenance: { agent: 'writer', source_refs: [ref] } }), 'writer', evidence);
    expect((await store.getProposal(proposal))?.candidate.provenance.source_refs).toEqual([{ kind: ref.kind, harness: ref.harness, session_id: ref.session_id, transcript_ref: ref.transcript_ref }]);
    expect(await code(store.create(candidate({ id: 'too-many-bytes', provenance: { agent: 'writer', source_refs: [{ ...withBoundary, harness: 'é'.repeat(2049) }] } })))).toBe('MISSING_EVIDENCE');
  });

  test('updating a record with shared YAML aliases keeps bounded serialized size', async () => {
    await store.create(candidate({ id: 'yaml-alias-record' }));
    const file = Object.entries(tree(root)).find(([name, body]) => name.endsWith('.md') && body.includes('id: yaml-alias-record'))?.[0];
    expect(file).toBeDefined(); const path = join(root, file!);
    const original = readFileSync(path, 'utf8');
    let extra = '\nanchor_0: &alias_0 [x]';
    for (let n = 1; n <= 14; n++) extra += `\nanchor_${n}: &alias_${n} [*alias_${n - 1}, *alias_${n - 1}]`;
    writeFileSync(path, original.replace('\n---\n', `${extra}\n---\n`));
    await store.update('yaml-alias-record', { tags: ['updated'] }, { agent: 'writer' });
    expect(Buffer.byteLength(readFileSync(path))).toBeLessThan(20000);
    expect((await store.get('yaml-alias-record'))?.tags).toContain('updated');
  });

  test('structured source refs survive staging and creation and reject invalid shapes', async () => {
    const refs = [{ kind: 'session-transcript' as const, harness: 'harness', session_id: 's-1', transcript_ref: 'opaque-ref', sitting_id: 'sit-1', range: { start: 1, end: 7 } }];
    const input = candidate({ provenance: { agent: 'writer', source_refs: refs, note: 'free text' } });
    const id = await store.proposeCreate(input, 'writer', evidence);
    expect((await store.getProposal(id))?.candidate.provenance.source_refs).toEqual(refs);
    await store.applyCreate(id, 'reviewer');
    expect((await store.get('proposed-record'))?.provenance.source_refs).toEqual(refs);
    for (const invalid of [
      [{ ...refs[0], extra: 'no' }], [{ ...refs[0], kind: 'future' }],
      [{ ...refs[0], harness: 'x'.repeat(4097) }], [{ ...refs[0], range: { start: 4, end: 3 } }],
      [{ ...refs[0], range: { start: 1, end: 2, extra: true } }],
      [{ ...refs[0], range: { start: 0, end: 2 } }], [{ ...refs[0], range: { start: 1, end: Number.MAX_SAFE_INTEGER + 1 } }],
      [{ ...refs[0], harness: '   ' }], [{ ...refs[0], sitting_id: 'x'.repeat(4097) }],
      Array.from({ length: 257 }, () => refs[0]),
    ]) {
      const bad = candidate({ id: 'invalid', provenance: { agent: 'writer', source_refs: invalid as never } });
      const before = tree(root);
      expect(await code(store.proposeCreate(bad, 'writer', evidence))).toBe('MISSING_EVIDENCE');
      expect(await code(store.create(bad))).toBe('MISSING_EVIDENCE');
      expect(tree(root)).toEqual(before);
    }
  });

  test('invalid source refs on disk are reported as corrupt provenance', async () => {
    const ref = { kind: 'session-transcript' as const, harness: 'marker', session_id: 's', transcript_ref: 't' };
    await store.create(candidate({ id: 'bad-source-read', provenance: { agent: 'writer', source_refs: [ref] } }));
    const file = Object.entries(tree(root)).find(([name, body]) => name.endsWith('.md') && body.includes('id: bad-source-read'))?.[0];
    expect(file).toBeDefined();
    const path = join(root, file!);
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('harness: marker');
    writeFileSync(path, text.replace('harness: marker', 'harness: [invalid]'));
    await expect(store.get('bad-source-read')).rejects.toMatchObject({ name: 'KnowledgeStoreCorruptionError', message: expect.stringContaining('provenance.source_refs') });
    await expect(store.listByType('raw')).rejects.toMatchObject({ name: 'KnowledgeStoreCorruptionError' });
  });

  test('pending and rejected proposals are outside the working set and every ordinary read', async () => {
    await store.create({ ...candidate({ id: 'ordinary' }), title: 'Ordinary' });
    const pending = await store.proposeCreate(candidate({ id: 'pending-record', aliases: ['pending-slug'], ttl_seconds: 1 }), 'agent-a', evidence);
    const rejected = await store.proposeCreate(candidate({ id: 'rejected-record' }), 'agent-a', evidence);
    await store.rejectCreate(rejected, 'reviewer', 'not durable');

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
    expect(await store.applyCreate(proposalId, 'reviewer-b')).toBe('proposed-record');

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
    const recordId = await store.applyCreate(proposalId, 'reviewer-b');
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
    const error = await store.applyCreate(proposalId, 'agent-a').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SelfApprovalError);
    expect(error).toMatchObject({ code: 'SELF_APPROVAL' });
    expect(isKnowledgeStoreError(error)).toBe(true);
    expect(tree(root)).toEqual(before);
    expect(await store.get('proposed-record')).toBeNull();
    expect((await store.getProposal(proposalId))?.state).toBe('pending');
    // A different reviewer still can; the refusal consumed nothing.
    expect(await store.applyCreate(proposalId, 'agent-b')).toBe('proposed-record');
  });

  test('reject keeps the proposal as rejected with its rationale and creates no record', async () => {
    const proposalId = await store.proposeCreate(candidate(), 'agent-a', evidence);
    await store.rejectCreate(proposalId, 'reviewer-b', 'Duplicates an existing finding');
    expect(await store.getProposal(proposalId)).toMatchObject({
      state: 'rejected', reviewer_id: 'reviewer-b', rationale: 'Duplicates an existing finding', candidate: candidate(),
    });
    expect(await store.get('proposed-record')).toBeNull();
    // A settled proposal is final.
    expect(await code(store.applyCreate(proposalId, 'reviewer-c'))).toBe('MISSING_EVIDENCE');
    expect(await code(store.rejectCreate(proposalId, 'reviewer-c', 'again'))).toBe('MISSING_EVIDENCE');
    expect(await store.get('proposed-record')).toBeNull();
  });

  test('the proposer may withdraw its own proposal by rejecting it', async () => {
    const proposalId = await store.proposeCreate(candidate(), 'agent-a', evidence);
    await store.rejectCreate(proposalId, 'agent-a', 'withdrawn');
    expect((await store.getProposal(proposalId))?.state).toBe('rejected');
  });

  test('an applied proposal cannot be applied or rejected again', async () => {
    const proposalId = await store.proposeCreate(candidate(), 'agent-a', evidence);
    await store.applyCreate(proposalId, 'reviewer-b');
    expect(await code(store.applyCreate(proposalId, 'reviewer-b'))).toBe('MISSING_EVIDENCE');
    expect(await code(store.rejectCreate(proposalId, 'reviewer-b', 'late'))).toBe('MISSING_EVIDENCE');
    expect((await store.listByType('raw')).length).toBe(1);
  });

  test('apply keeps every create requirement and a refusal leaves the proposal pending', async () => {
    const compiled = await store.proposeCreate(candidate({ type: 'compiled' }), 'agent-a', evidence);
    const before = tree(root);
    expect(await code(store.applyCreate(compiled, 'reviewer-b'))).toBe('MISSING_EVIDENCE');
    expect(tree(root)).toEqual(before);
    expect((await store.getProposal(compiled))?.state).toBe('pending');

    await store.create(candidate({ id: 'taken-slug-owner', aliases: ['taken-slug'] }));
    const clash = await store.proposeCreate(candidate({ id: 'clash', aliases: ['taken-slug'] }), 'agent-a', evidence);
    expect(await code(store.applyCreate(clash, 'reviewer-b'))).toBe('SLUG_CONFLICT');
    expect((await store.getProposal(clash))?.state).toBe('pending');
    expect(await store.get('clash')).toBeNull();

    // The id was free at proposal time and taken before apply.
    const raced = await store.proposeCreate(candidate({ id: 'raced' }), 'agent-a', evidence);
    await store.create(candidate({ id: 'raced' }));
    expect(await code(store.applyCreate(raced, 'reviewer-b'))).toBe('MISSING_EVIDENCE');
    expect((await store.getProposal(raced))?.state).toBe('pending');
  });

  test('the record and the settled proposal publish together: a failure after the record write leaves neither', async () => {
    const proposalId = await store.proposeCreate(candidate(), 'agent-a', evidence);
    const before = tree(root);
    const proposals = (store as unknown as { proposals: { settle(...args: unknown[]): void } }).proposals;
    const settle = vi.spyOn(proposals, 'settle').mockImplementation(() => { throw new Error('injected failure after the record write'); });
    await expect(store.applyCreate(proposalId, 'reviewer-b')).rejects.toThrow('injected failure');
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
      ['blank evidence agent', () => store.proposeCreate(candidate(), 'agent-a', { agent: ' ', proposal: 'x' })],
      ['non-string evidence', () => store.proposeCreate(candidate(), 'agent-a', { agent: 1 as never, proposal: 'x' })],
      ['nonfinite ttl', () => store.proposeCreate(candidate({ ttl_seconds: Number.NaN }), 'agent-a', evidence)],
      ['infinite ttl', () => store.proposeCreate(candidate({ ttl_seconds: Number.POSITIVE_INFINITY }), 'agent-a', evidence)],
    ];
    for (const [label, run] of cases) expect([label, await code(run())]).toEqual([label, 'MISSING_EVIDENCE']);
    await store.create(candidate({ id: 'existing' }));
    expect(await code(store.proposeCreate(candidate({ id: 'existing' }), 'agent-a', evidence))).toBe('MISSING_EVIDENCE');
    expect(await store.listProposals()).toEqual([]);
  });

  test('request key metadata counts toward the proposal file bound', async () => {
    const sampleId = await store.proposeCreate(candidate({ id: 'bound' }), 'agent-a', evidence);
    const sample = await store.getProposal(sampleId);
    expect(sample).not.toBeNull();
    const bodyBytes = Buffer.byteLength(sample!.candidate.body);
    const serialized = Buffer.byteLength(`${JSON.stringify(sample, null, 2)}\n`);
    const proposalLimit = 16 * 1024 * 1024 - 64 * 1024;
    // Leave enough slack for a possible extra ID digit but less than keyed metadata needs.
    const body = 'x'.repeat(proposalLimit - (serialized - bodyBytes) - 16);
    const before = tree(root);
    let failure: unknown;
    try { await store.proposeCreate(candidate({ id: 'bound', body }), 'agent-a', evidence, { requestKey: 'bound-key' }); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'MISSING_EVIDENCE', message: expect.stringContaining('create proposal exceeds') });
    expect(tree(root)).toEqual(before);
    const unkeyed = await store.proposeCreate(candidate({ id: 'bound', body }), 'agent-a', evidence);
    expect((await store.getProposal(unkeyed))?.candidate.body.length).toBe(body.length);
    const retry = await store.proposeCreate(candidate({ id: 'bound' }), 'agent-a', evidence, { requestKey: 'bound-key' });
    expect(await store.proposeCreate(candidate({ id: 'bound' }), 'agent-a', evidence, { requestKey: 'bound-key' })).toBe(retry);
  }, 120_000);

  test('a proposal too large to read back is refused up front, so the queries keep working', async () => {
    const kept = await store.proposeCreate(candidate({ id: 'kept' }), 'agent-a', evidence);
    const huge = candidate({ id: 'huge', body: 'a'.repeat(16 * 1024 * 1024) });
    expect(await code(store.proposeCreate(huge, 'agent-a', evidence))).toBe('MISSING_EVIDENCE');
    expect((await store.listProposals()).map((p) => p.id)).toEqual([kept]);
    // The largest proposal that is accepted can still be applied.
    const large = await store.proposeCreate(candidate({ id: 'large', body: 'a'.repeat(16 * 1024 * 1024 - 100 * 1024) }), 'agent-a', evidence);
    expect(await store.applyCreate(large, 'reviewer')).toBe('large');
    expect((await store.getProposal(large))?.state).toBe('applied');
  });

  test('an inherited freshness field is not part of the candidate, as for create', async () => {
    const inherited = Object.assign(Object.create({ ttl_seconds: 30 }), candidate());
    await store.create(Object.assign(Object.create({ ttl_seconds: 30 }), candidate({ id: 'direct' })));
    const proposalId = await store.proposeCreate(inherited, 'agent-a', evidence);
    expect((await store.getProposal(proposalId))?.candidate).not.toHaveProperty('ttl_seconds');
    await store.applyCreate(proposalId, 'reviewer');
    expect(await store.get('proposed-record')).not.toHaveProperty('ttl_seconds');
    expect(await store.get('direct')).not.toHaveProperty('ttl_seconds');
  });

  test('a category named proposals coexists with proposals', async () => {
    await store.create(candidate({ id: 'in-category', category: 'proposals' }));
    const proposalId = await store.proposeCreate(candidate({ id: 'next', category: 'proposals' }), 'agent-a', evidence);
    expect(await store.applyCreate(proposalId, 'reviewer')).toBe('next');
    expect((await store.listByCategory('proposals')).map((r) => r.id).sort()).toEqual(['in-category', 'next']);
    const another = await store.proposeCreate(candidate({ id: 'another', category: 'proposals' }), 'agent-a', evidence);
    expect(await store.applyCreate(another, 'reviewer')).toBe('another');
  });

  test('evidence and candidate fields are read once, so an accessor cannot store what was not validated', async () => {
    let reads = 0;
    const flipping = { get agent() { return ++reads === 1 ? 'agent-a' : ' '; }, proposal: 'p' };
    const proposalId = await store.proposeCreate(candidate(), 'agent-a', flipping);
    expect(await store.getProposal(proposalId)).toMatchObject({ evidence: { agent: 'agent-a', proposal: 'p' } });
    let titleReads = 0;
    const accessor = { ...candidate({ id: 'accessor' }), get title() { return ++titleReads === 1 ? 'Title' : ' '; } };
    const second = await store.proposeCreate(accessor, 'agent-a', evidence);
    expect((await store.getProposal(second))?.candidate.title).toBe('Title');
    expect(await store.applyCreate(second, 'reviewer')).toBe('accessor');
  });

  test('a candidate class instance with prototype fields is read as create reads it', async () => {
    class Candidate { get title() { return 'From prototype'; } get ttl_seconds() { return 30; } }
    const make = (id: string) => {
      const { title: _title, ...fields } = candidate({ id });
      return Object.assign(new Candidate(), fields) as unknown as CreateInput;
    };
    const instance = make('instance');
    await store.create(make('direct'));
    const proposalId = await store.proposeCreate(instance, 'agent-a', evidence);
    await store.applyCreate(proposalId, 'reviewer');
    expect(await store.get('instance')).toMatchObject({ title: (await store.get('direct'))!.title });
    expect(await store.get('instance')).not.toHaveProperty('ttl_seconds');
  });

  test('settlement text is bounded, so every accepted proposal can be settled', async () => {
    const proposalId = await store.proposeCreate(candidate({ body: 'a'.repeat(16 * 1024 * 1024 - 80 * 1024) }), 'agent-a', evidence);
    expect(await code(store.applyCreate(proposalId, 'r'.repeat(2000)))).toBe('MISSING_EVIDENCE');
    expect(await code(store.rejectCreate(proposalId, 'reviewer', 'x'.repeat(20 * 1024)))).toBe('MISSING_EVIDENCE');
    await store.rejectCreate(proposalId, 'r'.repeat(1000), 'x'.repeat(16 * 1024 - 2));
    expect((await store.getProposal(proposalId))?.state).toBe('rejected');
  });

  test('an explicit candidate id is capped, so the settled proposal always fits', async () => {
    expect(await code(store.proposeCreate(candidate({ id: 'i'.repeat(2000) }), 'agent-a', evidence))).toBe('MISSING_EVIDENCE');
    const proposalId = await store.proposeCreate(
      candidate({ id: 'i'.repeat(150), body: 'a'.repeat(16 * 1024 * 1024 - 64 * 1024 - 2000) }), 'agent-a', evidence);
    expect(await store.applyCreate(proposalId, 'r'.repeat(1000))).toBe('i'.repeat(150));
  });

  test('apply and reject refuse an unknown proposal, a blank reviewer and a blank rationale', async () => {
    expect(await code(store.applyCreate('no-such-proposal', 'reviewer'))).toBe('NOT_FOUND');
    expect(await code(store.rejectCreate('no-such-proposal', 'reviewer', 'why'))).toBe('NOT_FOUND');
    expect(await code(store.applyCreate('../escape', 'reviewer'))).toBe('NOT_FOUND');
    expect(await store.getProposal('../escape')).toBeNull();
    const proposalId = await store.proposeCreate(candidate(), 'agent-a', evidence);
    expect(await code(store.applyCreate(proposalId, ''))).toBe('MISSING_EVIDENCE');
    expect(await code(store.rejectCreate(proposalId, '', 'why'))).toBe('MISSING_EVIDENCE');
    expect(await code(store.rejectCreate(proposalId, 'reviewer', '  '))).toBe('MISSING_EVIDENCE');
    expect((await store.getProposal(proposalId))?.state).toBe('pending');
  });

  test('listProposals filters by state, orders by proposal time, and refuses an unknown state', async () => {
    const first = await store.proposeCreate(candidate({ id: 'one' }), 'agent-a', evidence);
    const second = await store.proposeCreate(candidate({ id: 'two' }), 'agent-a', evidence);
    const third = await store.proposeCreate(candidate({ id: 'three' }), 'agent-a', evidence);
    await store.applyCreate(first, 'reviewer');
    await store.rejectCreate(third, 'reviewer', 'no');
    const ids = async (options?: Parameters<Store['listProposals']>[0]) => (await store.listProposals(options)).map((p) => p.id);
    expect(await ids()).toEqual([first, second, third]);
    expect(await ids({ state: 'pending' })).toEqual([second]);
    expect(await ids({ state: 'applied' })).toEqual([first]);
    expect(await ids({ state: ['applied', 'rejected'] })).toEqual([first, third]);
    expect(await code(store.listProposals({ state: 'proposed' as never }))).toBe('MISSING_EVIDENCE');
    expect(await code(store.listProposals({ state: ['pending', 'bogus'] as never }))).toBe('MISSING_EVIDENCE');
  });

  test('the concept-proposal apply and reject are unchanged and never take the create form', async () => {
    const concept = await store.create(candidate({ id: 'concept-1', type: 'concept' }));
    const proposer = await store.create(candidate({ id: 'proposer-1' }));
    await store.propose(concept, proposer, { agent: 'a', proposal: 'new wording' });
    // Two arguments are not a create-proposal application: the concept form needs its evidence.
    expect(await code((store as any).apply(concept, proposer))).toBe('MISSING_EVIDENCE');
    expect(await code((store as any).reject(concept, proposer, 'why'))).toBe('MISSING_EVIDENCE');
    const pending = await store.proposeCreate(candidate({ id: 'still-pending' }), 'agent-a', evidence);
    expect(await code((store as any).apply(pending, 'reviewer'))).toBe('MISSING_EVIDENCE');
    expect((await store.getProposal(pending))?.state).toBe('pending');
    expect(await store.get('still-pending')).toBeNull();
    await store.apply(concept, proposer, { agent: 'a', new_body: 'new wording', rationale: 'better' });
    expect((await store.get(concept))?.body).toBe('new wording');
    await store.reject(concept, proposer, { agent: 'a', reason: 'changed my mind' });
    expect((await store.listProposals({ state: 'pending' })).map((p) => p.id)).toEqual([pending]);
  });

  test('a corrupt proposal file is refused, not skipped', async () => {
    const proposalId = await store.proposeCreate(candidate(), 'agent-a', evidence);
    const path = join(root, '.corpus-proposals', `${proposalId}.json`);
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    for (const broken of ['{not json', JSON.stringify({ ...stored, id: 'other' }), JSON.stringify({ ...stored, state: 'applied' }), JSON.stringify({ ...stored, state: 'weird' })]) {
      writeFileSync(path, broken);
      await expect(store.getProposal(proposalId)).rejects.toMatchObject({ name: 'KnowledgeStoreCorruptionError' });
      await expect(store.listProposals()).rejects.toMatchObject({ name: 'KnowledgeStoreCorruptionError' });
    }
  });

  test('a live keyed proposal with tampered content is refused as corrupt', async () => {
    const id = await store.proposeCreate(candidate(), 'agent-a', evidence, { requestKey: 'tamper-key' });
    const path = join(root, '.corpus-proposals', `${id}.json`);
    const proposal = JSON.parse(readFileSync(path, 'utf8')); proposal.candidate.body = 'tampered';
    writeFileSync(path, JSON.stringify(proposal)); const before = tree(root);
    await expect(store.getProposal(id)).rejects.toMatchObject({ name: 'KnowledgeStoreCorruptionError' });
    await expect(store.listProposals()).rejects.toMatchObject({ name: 'KnowledgeStoreCorruptionError' });
    await expect(store.applyCreate(id, 'reviewer')).rejects.toMatchObject({ name: 'KnowledgeStoreCorruptionError' });
    expect(tree(root)).toEqual(before);
  });

  test('keyed proposal with extra stored evidence is refused as corrupt', async () => {
    const id = await store.proposeCreate(candidate(), 'agent-a', evidence, { requestKey: 'extra-evidence-key' });
    const path = join(root, '.corpus-proposals', `${id}.json`);
    const proposal = JSON.parse(readFileSync(path, 'utf8')); proposal.evidence.extra = 'unvalidated';
    writeFileSync(path, JSON.stringify(proposal)); const before = tree(root);
    await expect(store.getProposal(id)).rejects.toMatchObject({ name: 'KnowledgeStoreCorruptionError' });
    await expect(store.applyCreate(id, 'reviewer')).rejects.toMatchObject({ name: 'KnowledgeStoreCorruptionError' });
    expect(tree(root)).toEqual(before);
  });

  test('keyed requests fail closed on corrupt neighbours and invalid metadata', async () => {
    const options = { requestKey: 'metadata-key' };
    const id = await store.proposeCreate(candidate(), 'agent-a', evidence, options);
    const path = join(root, '.corpus-proposals', `${id}.json`);
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    expect(stored.request_digest_version).toBe(1);
    for (const broken of [
      '{bad json', JSON.stringify({ ...stored, request_digest: 'invalid' }),
      JSON.stringify({ ...stored, request_digest_version: 2 }),
      JSON.stringify({ ...stored, request_digest_version: undefined }),
      JSON.stringify({ ...stored, request_key_hash: undefined, request_digest: undefined }),
    ]) {
      writeFileSync(path, broken);
      const before = tree(root);
      await expect(store.proposeCreate(candidate(), 'agent-a', evidence, options)).rejects.toMatchObject({ name: 'KnowledgeStoreCorruptionError' });
      await expect(store.proposeCreate(candidate(), 'agent-a', evidence, { requestKey: 'new-key' })).rejects.toMatchObject({ name: 'KnowledgeStoreCorruptionError' });
      expect(tree(root)).toEqual(before);
    }
    writeFileSync(path, '{bad json');
    expect(await store.proposeCreate(candidate(), 'agent-a', evidence)).not.toBe(id);
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
      await second.applyCreate(proposalId, 'reviewer');
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
      expect(await code(store.applyCreate('p', 'reviewer'))).toBe('READ_ONLY');
      expect(await code(store.rejectCreate('p', 'reviewer', 'no'))).toBe('READ_ONLY');
      expect(await store.listProposals()).toEqual([]);
      expect(tree(root)).toEqual(before);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('create proposals and the vault record scans', () => {
  let base: string;
  let root: string;
  let vault: KitObsidianStoreAdapter;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'corpus-create-proposals-scan-'));
    root = join(base, 'store');
    vault = new KitObsidianStoreAdapter({
      storeRoot: root,
      coordinationDirectory: join(base, 'coordination'),
      coordinationIdentity: () => () => {},
      lock: standaloneFileMutationLock,
    });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }), 300_000);

  test('a note under the proposals directory is still a record the identity scans see', async () => {
    // Only the directory's .json proposals are skipped: externally placed notes keep counting.
    mkdirSync(join(root, '.corpus-proposals'), { recursive: true });
    writeFileSync(join(root, '.corpus-proposals', 'planted.md'), '---\nid: planted\ntype: raw\ntitle: Planted\ncategory: engineering\nprovenance:\n  agent: someone\ncreated_at: 2026-01-01T00:00:00.000Z\nupdated_at: 2026-01-01T00:00:00.000Z\n---\nbody\n');
    await expect(vault.create(candidate({ id: 'other' }))).rejects.toMatchObject({ name: 'KnowledgeStoreCorruptionError' });
  });

  test('retained proposal files do not count toward the identity-scan entry bound', async () => {
    const directory = join(root, '.corpus-proposals');
    mkdirSync(directory, { recursive: true });
    // More entries than the vault's 10,000-entry record-identity scan allows. Hard links are
    // the cheap way to make that many files.
    writeFileSync(join(base, 'proposal.json'), '{}');
    for (let i = 0; i < 10_001; i++) linkSync(join(base, 'proposal.json'), join(directory, `retained-${i}.json`));
    expect(await vault.create(candidate({ id: 'first' }))).toBe('first');
    expect(await vault.create(candidate({ id: 'second' }))).toBe('second');
  }, 300_000);
});
