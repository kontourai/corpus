import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { KitDefaultStoreAdapter, KitObsidianStoreAdapter, reviewedConfidenceCandidateDigest, standaloneFileMutationLock } from '../src/index.js';
import { VAULT_NOTE_MAX_BYTES } from '../src/obsidian-store.js';

test('candidate digest has a literal portable encoding', () => {
  expect(reviewedConfidenceCandidateDigest({ rootBinding: '0'.repeat(64), recordId: 'target', revision: `record-rev1:${'1'.repeat(64)}`, oldConfidence: 0.3, newConfidence: 0.7, evidence: [{ id: 'source', revision: `record-rev1:${'2'.repeat(64)}` }] })).toBe('sha256:bd8fca6aaf5d78aa8e6881bf8e69903039ddc146783ebea8402e7a07cdbd81af');
});

describe.each([['default', KitDefaultStoreAdapter], ['vault', KitObsidianStoreAdapter]] as const)('reviewed confidence snapshot %s', (profile, Constructor) => {
  test('binds exact stored bytes and root identity, without using a prefix or whole-store revision', async () => {
    const base = mkdtempSync(join(tmpdir(), 'corpus-reviewed-confidence-'));
    try {
      const options = (name: string) => ({ storeRoot: join(base, name), coordinationDirectory: join(base, 'coordination'), coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock });
      const store = new Constructor(options('first'));
      const other = new Constructor(options('second'));
      const input = { id: 'record-one', type: 'raw' as const, title: 'Record', body: 'body', category: 'test', confidence: 0.3, provenance: { agent: 'creator' } };
      await store.create(input); await other.create(input);
      const before = await store.reviewedConfidenceSnapshot('record-one');
      expect(before.record.confidence).toBe(0.3);
      expect((await store.reviewedConfidenceSnapshot('record-one')).revision).toBe(before.revision);
      expect((await other.reviewedConfidenceSnapshot('record-one')).revision).not.toBe(before.revision);
      await expect(store.reviewedConfidenceSnapshot('record-o')).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await store.create({ ...input, id: 'unrelated' });
      expect((await store.reviewedConfidenceSnapshot('record-one')).revision).toBe(before.revision);
      const root = options('first').storeRoot;
      const path = profile === 'default' ? join(root, 'records', 'record-one.md') : join(root, JSON.parse(readFileSync(join(root, 'path-index.json'), 'utf8')).by_id['record-one'].path);
      writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from('\n')]));
      expect((await store.reviewedConfidenceSnapshot('record-one')).revision).not.toBe(before.revision);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  test('applies once, rejects changed evidence and key reuse, and retires receipt on evidence erasure', async () => {
    const base = mkdtempSync(join(tmpdir(), 'corpus-reviewed-apply-'));
    try {
      const root = join(base, 'store');
      const options = { storeRoot: root, coordinationDirectory: join(base, 'coordination'), coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock, allowReviewedConfidence: true, allowPurge: true };
      const store = new Constructor(options);
      const create = (id: string) => store.create({ id, type: 'raw', title: id, body: 'body', category: 'test', confidence: 0.3, provenance: { agent: 'creator' } });
      await create('target'); await create('source');
      const target = await store.reviewedConfidenceSnapshot('target');
      const source = await store.reviewedConfidenceSnapshot('source');
      const candidate = { rootBinding: target.rootBinding, recordId: 'target', revision: target.revision, oldConfidence: 0.3, newConfidence: 0.7, evidence: [{ id: 'source', revision: source.revision }] };
      const request = { ...candidate, candidateDigest: reviewedConfidenceCandidateDigest(candidate), authorizationDigest: `sha256:${'a'.repeat(64)}`, requestKey: 'one', agent: 'reviewer' };
      await expect(store.applyReviewedConfidence({ ...request, newConfidence: 0.8 })).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });
      expect((await store.reviewedConfidenceSnapshot('target')).revision).toBe(target.revision);
      const receipt = await store.applyReviewedConfidence(request);
      expect((await store.get('target'))?.confidence).toBe(0.7);
      expect(await new Constructor(options).applyReviewedConfidence(request)).toEqual(receipt);
      const changed = { ...candidate, newConfidence: 0.8 };
      await expect(store.applyReviewedConfidence({ ...request, ...changed, candidateDigest: reviewedConfidenceCandidateDigest(changed) })).rejects.toMatchObject({ code: 'REQUEST_KEY_CONFLICT' });
      await store.update('source', { body: 'changed' }, { agent: 'editor' });
      const afterUpdate = await store.reviewedConfidenceSnapshot('target');
      await expect(store.applyReviewedConfidence(request)).rejects.toMatchObject({ code: 'STALE_REVISION' });
      expect((await store.reviewedConfidenceSnapshot('target')).revision).toBe(afterUpdate.revision);
      await store.purge(['source'], { agent: 'eraser', rationale: 'request' });
      const receiptFile = join(root, '.corpus-reviewed-confidence', `${receipt.receiptId}.json`);
      expect(readFileSync(receiptFile, 'utf8')).not.toContain(request.candidateDigest.slice(7));
      expect(JSON.parse(readFileSync(receiptFile, 'utf8'))).toEqual({ version: 1, key: receipt.receiptId, retired: true });
      await expect(store.applyReviewedConfidence(request)).rejects.toMatchObject({ code: 'REQUEST_KEY_CONFLICT' });
      const closed = new Constructor({ ...options, allowReviewedConfidence: false });
      await expect(closed.applyReviewedConfidence(request)).rejects.toMatchObject({ code: 'READ_ONLY' });
      const unreadable = new Proxy({}, { get() { throw new Error('must not read'); } });
      await expect(closed.applyReviewedConfidence(unreadable as never)).rejects.toMatchObject({ code: 'READ_ONLY' });
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  test('target erasure retires the receipt and refuses a replay', async () => {
    const base = mkdtempSync(join(tmpdir(), 'corpus-reviewed-target-'));
    try {
      const options = { storeRoot: join(base, 'store'), coordinationDirectory: join(base, 'coordination'), coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock, allowReviewedConfidence: true, allowPurge: true };
      const store = new Constructor(options);
      for (const id of ['target', 'source']) await store.create({ id, type: 'raw', title: id, body: 'body', category: 'test', confidence: 0.3, provenance: { agent: 'creator' } });
      const target = await store.reviewedConfidenceSnapshot('target'); const source = await store.reviewedConfidenceSnapshot('source');
      const candidate = { rootBinding: target.rootBinding, recordId: 'target', revision: target.revision, oldConfidence: 0.3, newConfidence: 0.7, evidence: [{ id: 'source', revision: source.revision }] };
      const request = { ...candidate, candidateDigest: reviewedConfidenceCandidateDigest(candidate), authorizationDigest: `sha256:${'a'.repeat(64)}`, requestKey: 'target', agent: 'reviewer' };
      const receipt = await store.applyReviewedConfidence(request);
      await store.purge(['target'], { agent: 'eraser', rationale: 'request' });
      expect(JSON.parse(readFileSync(join(options.storeRoot, '.corpus-reviewed-confidence', `${receipt.receiptId}.json`), 'utf8'))).toEqual({ version: 1, key: receipt.receiptId, retired: true });
      await expect(store.applyReviewedConfidence(request)).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  test('purge preview revision covers and validates retained receipts', async () => {
    const base = mkdtempSync(join(tmpdir(), 'corpus-reviewed-preview-'));
    try {
      const options = { storeRoot: join(base, 'store'), coordinationDirectory: join(base, 'coordination'), coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock, allowReviewedConfidence: true, allowPurge: true };
      const store = new Constructor(options);
      for (const id of ['target', 'source']) await store.create({ id, type: 'raw', title: id, body: 'body', category: 'test', confidence: 0.3, provenance: { agent: 'creator' } });
      const proposal = await store.proposeCreate({ id: 'candidate', type: 'raw', title: 'Candidate', body: 'body', category: 'test', provenance: { agent: 'creator' } }, 'proposer', { agent: 'creator', proposal: 'review' });
      const target = await store.reviewedConfidenceSnapshot('target'); const source = await store.reviewedConfidenceSnapshot('source');
      const candidate = { rootBinding: target.rootBinding, recordId: 'target', revision: target.revision, oldConfidence: 0.3, newConfidence: 0.7, evidence: [{ id: 'source', revision: source.revision }] };
      const request = { ...candidate, candidateDigest: reviewedConfidenceCandidateDigest(candidate), authorizationDigest: `sha256:${'a'.repeat(64)}`, requestKey: 'preview', agent: 'reviewer' };
      const receipt = await store.applyReviewedConfidence(request);
      const preview = await store.previewPurgeProposal(proposal);
      const receiptFile = join(options.storeRoot, '.corpus-reviewed-confidence', `${receipt.receiptId}.json`);
      const changed = JSON.parse(readFileSync(receiptFile, 'utf8')); changed.appliedAt = '2001-01-01T00:00:00.000Z';
      writeFileSync(receiptFile, JSON.stringify(changed) + '\n');
      await expect(store.purgeProposal(proposal, { agent: 'eraser', rationale: 'request' }, { expectedRevision: preview.revision })).rejects.toMatchObject({ code: 'STALE_REVISION' });
      writeFileSync(receiptFile, '{');
      await expect(store.previewPurgeProposal(proposal)).rejects.toThrow(/reviewed confidence receipt is corrupt/);
      expect((await store.getProposal(proposal))?.state).toBe('pending');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  test.each(['target', 'evidence'])('missing proposal-created %s still retires its receipt', async (role) => {
    const base = mkdtempSync(join(tmpdir(), 'corpus-reviewed-proposal-'));
    try {
      const options = { storeRoot: join(base, 'store'), coordinationDirectory: join(base, 'coordination'), coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock, allowReviewedConfidence: true, allowPurge: true };
      const store = new Constructor(options);
      await store.create({ id: 'other', type: 'raw', title: 'Other', body: 'body', category: 'test', confidence: 0.3, provenance: { agent: 'creator' } });
      const proposal = await store.proposeCreate({ id: 'created', type: 'raw', title: 'Created', body: 'body', category: 'test', confidence: 0.3, provenance: { agent: 'creator' } }, 'proposer', { agent: 'creator', proposal: 'review' });
      await store.applyCreate(proposal, 'reviewer');
      const targetId = role === 'target' ? 'created' : 'other';
      const sourceId = role === 'target' ? 'other' : 'created';
      const target = await store.reviewedConfidenceSnapshot(targetId); const source = await store.reviewedConfidenceSnapshot(sourceId);
      const candidate = { rootBinding: target.rootBinding, recordId: targetId, revision: target.revision, oldConfidence: 0.3, newConfidence: 0.7, evidence: [{ id: sourceId, revision: source.revision }] };
      const request = { ...candidate, candidateDigest: reviewedConfidenceCandidateDigest(candidate), authorizationDigest: `sha256:${'a'.repeat(64)}`, requestKey: 'missing-created', agent: 'reviewer' };
      const receipt = await store.applyReviewedConfidence(request);
      const receiptFile = join(options.storeRoot, '.corpus-reviewed-confidence', `${receipt.receiptId}.json`);
      const retainedInput = JSON.parse(readFileSync(receiptFile, 'utf8')).input;
      let path = join(options.storeRoot, 'records', 'created.md');
      if (profile === 'vault') {
        const indexPath = join(options.storeRoot, 'path-index.json');
        const index = JSON.parse(readFileSync(indexPath, 'utf8'));
        path = join(options.storeRoot, index.by_id.created.path);
        delete index.by_path[index.by_id.created.path]; delete index.by_id.created;
        writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
      }
      rmSync(path);
      await store.purgeProposal(proposal, { agent: 'eraser', rationale: 'request' });
      const retired = readFileSync(receiptFile, 'utf8');
      expect(retired).not.toContain(retainedInput);
      expect(JSON.parse(retired)).toEqual({ version: 1, key: receipt.receiptId, retired: true });
      await expect(new Constructor(options).applyReviewedConfidence(request)).rejects.toBeDefined();
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  if (profile === 'vault') test('a reviewed update that would exceed the vault note limit refuses atomically', async () => {
    const base = mkdtempSync(join(tmpdir(), 'corpus-reviewed-vault-limit-'));
    try {
      const options = { storeRoot: join(base, 'store'), coordinationDirectory: join(base, 'coordination'), coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock, allowReviewedConfidence: true };
      const store = new KitObsidianStoreAdapter(options);
      for (const id of ['target', 'source']) await store.create({ id, type: id === 'target' ? 'concept' : 'raw', title: id, body: 'body', category: 'test', confidence: 0.3, provenance: { agent: 'creator' } });
      const indexPath = join(options.storeRoot, 'path-index.json');
      const index = JSON.parse(readFileSync(indexPath, 'utf8'));
      const targetPath = join(options.storeRoot, index.by_id.target.path);
      const original = readFileSync(targetPath, 'utf8');
      const boundary = original.indexOf('\n---\n') + 5;
      const padding = VAULT_NOTE_MAX_BYTES - 32 - Buffer.byteLength(original);
      writeFileSync(targetPath, original.slice(0, boundary) + 'x'.repeat(padding) + original.slice(boundary));
      const before = readFileSync(targetPath); const graph = readFileSync(join(options.storeRoot, 'graph-index.json')); const indexBefore = readFileSync(indexPath);
      const target = await store.reviewedConfidenceSnapshot('target'); const source = await store.reviewedConfidenceSnapshot('source');
      expect(target.record.body.length).toBeGreaterThanOrEqual(padding);
      const candidate = { rootBinding: target.rootBinding, recordId: 'target', revision: target.revision, oldConfidence: 0.3, newConfidence: 0.7, evidence: [{ id: 'source', revision: source.revision }] };
      const request = { ...candidate, candidateDigest: reviewedConfidenceCandidateDigest(candidate), authorizationDigest: `sha256:${'a'.repeat(64)}`, requestKey: 'limit', agent: 'reviewer' };
      await expect(store.applyReviewedConfidence(request)).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });
      expect(readFileSync(targetPath)).toEqual(before);
      expect(readFileSync(join(options.storeRoot, 'graph-index.json'))).toEqual(graph);
      expect(readFileSync(indexPath)).toEqual(indexBefore);
      expect(existsSync(join(options.storeRoot, '.corpus-reviewed-confidence'))).toBe(false);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  test('stale target, missing or changed evidence, and wrong root refuse without an update', async () => {
    const base = mkdtempSync(join(tmpdir(), 'corpus-reviewed-stale-'));
    try {
      const options = { storeRoot: join(base, 'store'), coordinationDirectory: join(base, 'coordination'), coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock, allowReviewedConfidence: true };
      const store = new Constructor(options);
      for (const id of ['target', 'source']) await store.create({ id, type: 'raw', title: id, body: 'body', category: 'test', confidence: 0.3, provenance: { agent: 'creator' } });
      const target = await store.reviewedConfidenceSnapshot('target'); const source = await store.reviewedConfidenceSnapshot('source');
      const candidate = { rootBinding: target.rootBinding, recordId: 'target', revision: target.revision, oldConfidence: 0.3, newConfidence: 0.7, evidence: [{ id: 'source', revision: source.revision }] };
      const request = { ...candidate, candidateDigest: reviewedConfidenceCandidateDigest(candidate), authorizationDigest: `sha256:${'a'.repeat(64)}`, requestKey: 'stale', agent: 'reviewer' };
      const otherCandidate = { ...candidate, rootBinding: '0'.repeat(64) };
      await expect(store.applyReviewedConfidence({ ...request, ...otherCandidate, candidateDigest: reviewedConfidenceCandidateDigest(otherCandidate) })).rejects.toMatchObject({ code: 'ROOT_BINDING_MISMATCH' });
      const missingCandidate = { ...candidate, evidence: [{ id: 'missing', revision: source.revision }] };
      await expect(store.applyReviewedConfidence({ ...request, ...missingCandidate, candidateDigest: reviewedConfidenceCandidateDigest(missingCandidate) })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await store.update('source', { body: 'changed' }, { agent: 'editor' });
      await expect(store.applyReviewedConfidence(request)).rejects.toMatchObject({ code: 'STALE_REVISION' });
      expect((await store.reviewedConfidenceSnapshot('target')).revision).toBe(target.revision);
      const freshSource = await store.reviewedConfidenceSnapshot('source');
      await store.update('target', { body: 'changed' }, { agent: 'editor' });
      const staleCandidate = { ...candidate, evidence: [{ id: 'source', revision: freshSource.revision }] };
      const before = await store.reviewedConfidenceSnapshot('target');
      await expect(store.applyReviewedConfidence({ ...request, ...staleCandidate, candidateDigest: reviewedConfidenceCandidateDigest(staleCandidate) })).rejects.toMatchObject({ code: 'STALE_REVISION' });
      expect((await store.reviewedConfidenceSnapshot('target')).revision).toBe(before.revision);
      expect(before.record.confidence).toBe(0.3);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  test('copies the reviewed request before a queued lock can be released', async () => {
    const base = mkdtempSync(join(tmpdir(), 'corpus-reviewed-queued-'));
    let release!: () => void;
    try {
      let armed = false; let entered!: () => void;
      const atLock = new Promise<void>((resolve) => { entered = resolve; });
      const held = new Promise<void>((resolve) => { release = resolve; });
      const lock = async (path: string) => {
        const unlock = await standaloneFileMutationLock(path);
        if (armed) { armed = false; entered(); await held; }
        return unlock;
      };
      const store = new Constructor({ storeRoot: join(base, 'store'), coordinationDirectory: join(base, 'coordination'), coordinationIdentity: () => () => {}, lock, allowReviewedConfidence: true });
      for (const id of ['target', 'source']) await store.create({ id, type: 'raw', title: id, body: 'body', category: 'test', confidence: 0.3, provenance: { agent: 'creator' } });
      const target = await store.reviewedConfidenceSnapshot('target'); const source = await store.reviewedConfidenceSnapshot('source');
      const candidate = { rootBinding: target.rootBinding, recordId: 'target', revision: target.revision, oldConfidence: 0.3, newConfidence: 0.7, evidence: [{ id: 'source', revision: source.revision }] };
      const request = { ...candidate, candidateDigest: reviewedConfidenceCandidateDigest(candidate), authorizationDigest: `sha256:${'a'.repeat(64)}`, requestKey: 'queued', agent: 'reviewer' };
      armed = true;
      const applying = store.applyReviewedConfidence(request);
      await atLock;
      request.newConfidence = 0.9; request.evidence[0].id = 'other';
      release();
      await applying;
      expect((await store.get('target'))?.confidence).toBe(0.7);
    } finally { release?.(); rmSync(base, { recursive: true, force: true }); }
  });

  test('concurrent different updates from one revision cannot both commit', async () => {
    const base = mkdtempSync(join(tmpdir(), 'corpus-reviewed-race-'));
    try {
      const options = { storeRoot: join(base, 'store'), coordinationDirectory: join(base, 'coordination'), coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock, allowReviewedConfidence: true };
      const a = new Constructor(options); const b = new Constructor(options);
      for (const id of ['target', 'source']) await a.create({ id, type: 'raw', title: id, body: 'body', category: 'test', confidence: 0.3, provenance: { agent: 'creator' } });
      const target = await a.reviewedConfidenceSnapshot('target'); const source = await a.reviewedConfidenceSnapshot('source');
      const request = (score: number, key: string) => {
        const candidate = { rootBinding: target.rootBinding, recordId: 'target', revision: target.revision, oldConfidence: 0.3, newConfidence: score, evidence: [{ id: 'source', revision: source.revision }] };
        return { ...candidate, candidateDigest: reviewedConfidenceCandidateDigest(candidate), authorizationDigest: `sha256:${'b'.repeat(64)}`, requestKey: key, agent: 'reviewer' };
      };
      const results = await Promise.allSettled([a.applyReviewedConfidence(request(0.6, 'a')), b.applyReviewedConfidence(request(0.8, 'b'))]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const failure = results.find((result) => result.status === 'rejected');
      expect(failure).toMatchObject({ status: 'rejected', reason: { code: 'STALE_REVISION' } });
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  test('independent processes racing one revision produce exactly one effect', async () => {
    const base = mkdtempSync(join(tmpdir(), 'corpus-reviewed-process-race-'));
    try {
      const options = { storeRoot: join(base, 'store'), coordinationDirectory: join(base, 'coordination'), coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock, allowReviewedConfidence: true };
      const store = new Constructor(options);
      for (const id of ['target', 'source']) await store.create({ id, type: 'raw', title: id, body: 'body', category: 'test', confidence: 0.3, provenance: { agent: 'creator' } });
      const target = await store.reviewedConfidenceSnapshot('target'); const source = await store.reviewedConfidenceSnapshot('source');
      const request = (score: number, key: string) => {
        const candidate = { rootBinding: target.rootBinding, recordId: 'target', revision: target.revision, oldConfidence: 0.3, newConfidence: score, evidence: [{ id: 'source', revision: source.revision }] };
        return { ...candidate, candidateDigest: reviewedConfidenceCandidateDigest(candidate), authorizationDigest: `sha256:${'b'.repeat(64)}`, requestKey: key, agent: 'reviewer' };
      };
      const fixture = fileURLToPath(new URL('./fixtures/reviewed-confidence-racer.mjs', import.meta.url));
      const racers = [request(0.6, 'a'), request(0.8, 'b')].map((input) => {
        const child = spawn(process.execPath, ['--import', 'tsx', fixture, profile, options.storeRoot, options.coordinationDirectory, JSON.stringify(input)], { stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = ''; let stderr = '';
        const ready = new Promise<void>((resolve, reject) => {
          child.once('error', reject);
          child.stdout.on('data', (chunk) => { stdout += String(chunk); if (stdout.includes('ready\n')) resolve(); });
          child.once('close', (code) => { if (!stdout.includes('ready\n')) reject(new Error(`racer exited before ready: ${code} ${stderr}`)); });
        });
        child.stderr.on('data', (chunk) => { stderr += String(chunk); });
        const done = new Promise<string>((resolve, reject) => { child.once('error', reject); child.once('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`racer failed: ${code} ${stderr}`))); });
        void done.catch(() => {});
        return { child, ready, done };
      });
      try {
        await Promise.all(racers.map((racer) => racer.ready));
        for (const racer of racers) racer.child.stdin.end('go');
        const output = await Promise.all(racers.map((racer) => racer.done));
        expect(output.filter((line) => line.includes('applied\n'))).toHaveLength(1);
        expect(output.filter((line) => line.includes('error:STALE_REVISION\n'))).toHaveLength(1);
        expect((await store.get('target'))?.mutation_log?.filter((entry) => entry.op === 'update')).toHaveLength(1);
      } finally {
        for (const racer of racers) if (racer.child.exitCode === null && racer.child.signalCode === null) racer.child.kill();
        await Promise.allSettled(racers.map((racer) => racer.done));
      }
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  test.each(['prepared', 'first-publish', 'final-publish', 'committed'])('recovers %s crash and an identical retry yields one durable effect', async (phase) => {
    const base = mkdtempSync(join(tmpdir(), 'corpus-reviewed-crash-'));
    try {
      const options = { storeRoot: join(base, 'store'), coordinationDirectory: join(base, 'coordination'), coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock, allowReviewedConfidence: true };
      const store = new Constructor(options);
      for (const id of ['target', 'source']) await store.create({ id, type: 'raw', title: id, body: 'body', category: 'test', confidence: 0.3, provenance: { agent: 'creator' } });
      const target = await store.reviewedConfidenceSnapshot('target'); const source = await store.reviewedConfidenceSnapshot('source');
      const candidate = { rootBinding: target.rootBinding, recordId: 'target', revision: target.revision, oldConfidence: 0.3, newConfidence: 0.7, evidence: [{ id: 'source', revision: source.revision }] };
      const request = { ...candidate, candidateDigest: reviewedConfidenceCandidateDigest(candidate), authorizationDigest: `sha256:${'a'.repeat(64)}`, requestKey: 'crash', agent: 'reviewer' };
      const child = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/reviewed-confidence-crash.mjs', import.meta.url)), profile, options.storeRoot, options.coordinationDirectory, phase, JSON.stringify(request)], { encoding: 'utf8' });
      expect(child.status, child.stderr).toBe(23);
      const reopened = new Constructor(options);
      const recovered = await reopened.get('target');
      const shouldBeApplied = phase === 'final-publish' || phase === 'committed';
      expect(recovered?.confidence).toBe(shouldBeApplied ? 0.7 : 0.3);
      expect(recovered?.mutation_log?.filter((entry) => entry.op === 'update')).toHaveLength(shouldBeApplied ? 1 : 0);
      const receiptDirectory = join(options.storeRoot, '.corpus-reviewed-confidence');
      expect(existsSync(receiptDirectory) ? readdirSync(receiptDirectory).filter((name) => name.endsWith('.json')).length : 0).toBe(shouldBeApplied ? 1 : 0);
      const receipt = await reopened.applyReviewedConfidence(request);
      expect(await new Constructor(options).applyReviewedConfidence(request)).toEqual(receipt);
      const record = await reopened.get('target');
      expect(record?.confidence).toBe(0.7);
      expect(record?.mutation_log?.filter((entry) => entry.op === 'update')).toHaveLength(1);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  test.each(['first-publish', 'final-publish', 'committed'])('recovers %s interruption while erasing receipt evidence', async (phase) => {
    const base = mkdtempSync(join(tmpdir(), 'corpus-reviewed-purge-crash-'));
    try {
      const options = { storeRoot: join(base, 'store'), coordinationDirectory: join(base, 'coordination'), coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock, allowReviewedConfidence: true, allowPurge: true };
      const store = new Constructor(options);
      for (const id of ['target', 'source']) await store.create({ id, type: 'raw', title: id, body: 'body', category: 'test', confidence: 0.3, provenance: { agent: 'creator' } });
      const target = await store.reviewedConfidenceSnapshot('target'); const source = await store.reviewedConfidenceSnapshot('source');
      const candidate = { rootBinding: target.rootBinding, recordId: 'target', revision: target.revision, oldConfidence: 0.3, newConfidence: 0.7, evidence: [{ id: 'source', revision: source.revision }] };
      const request = { ...candidate, candidateDigest: reviewedConfidenceCandidateDigest(candidate), authorizationDigest: `sha256:${'a'.repeat(64)}`, requestKey: 'purge-crash', agent: 'reviewer' };
      const receipt = await store.applyReviewedConfidence(request);
      const receiptFile = join(options.storeRoot, '.corpus-reviewed-confidence', `${receipt.receiptId}.json`);
      const retainedInput = JSON.parse(readFileSync(receiptFile, 'utf8')).input;
      const child = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/reviewed-confidence-crash.mjs', import.meta.url)), profile, options.storeRoot, options.coordinationDirectory, `purge-${phase}`, JSON.stringify(request)], { encoding: 'utf8' });
      expect(child.status, child.stderr).toBe(23);
      const journalPath = join(options.storeRoot, '.station-knowledge-transaction.json');
      if (phase === 'committed') {
        const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
        expect(journal.entries.every((entry: { before: unknown }) => entry.before === null)).toBe(true);
        for (const entry of journal.entries as { before: string | null; after: string | null }[]) {
          for (const image of [entry.before, entry.after]) if (image !== null) expect(Buffer.from(image, 'base64').toString('utf8')).not.toContain(retainedInput);
        }
      }
      const reopened = new Constructor(options);
      const recovered = await reopened.get('source');
      expect(existsSync(journalPath)).toBe(false);
      if (phase === 'first-publish') {
        expect(recovered).toEqual(source.record);
        expect(JSON.parse(readFileSync(receiptFile, 'utf8')).input).toBe(retainedInput);
      } else {
        expect(recovered?.status).toBe('purged');
        expect(readFileSync(receiptFile, 'utf8')).not.toContain(retainedInput);
        expect(JSON.parse(readFileSync(receiptFile, 'utf8'))).toEqual({ version: 1, key: receipt.receiptId, retired: true });
      }
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});
