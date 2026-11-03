import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { KitDefaultStoreAdapter, KitObsidianStoreAdapter, standaloneFileMutationLock } from '../src/index.js';

function bytes(directory: string): string {
  if (!existsSync(directory)) return '';
  return readdirSync(directory, { withFileTypes: true }).map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? bytes(path) : readFileSync(path).toString('utf8');
  }).join('\n');
}
const evidence = { agent: 'writer', proposal: 'ERASED_EVIDENCE_SENTINEL' };
const candidate = { id: 'record', type: 'raw' as const, title: 'title', body: 'ERASED_BODY_SENTINEL', category: 'engineering', provenance: { agent: 'writer' } };

describe.each([['default', KitDefaultStoreAdapter], ['vault', KitObsidianStoreAdapter]] as const)('keyed purge integration %s', (_profile, Constructor) => {
  test('full purge erases the digest and refuses identical and different retries', async () => {
    const base = mkdtempSync(join(tmpdir(), 'corpus-key-purge-'));
    try {
      const root = join(base, 'store'); const coordinationDirectory = join(base, 'coordination');
      const store = new Constructor({ storeRoot: root, coordinationDirectory, coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock, allowPurge: true });
      const options = { requestKey: 'opaque-random-key' };
      const id = await store.proposeCreate(candidate, 'writer', evidence, options);
      const digest = (await store.getProposal(id))!.request_digest!;
      await store.applyCreate(id, 'reviewer');
      const result = await store.purge(['record'], { agent: 'eraser', rationale: 'requested' });
      expect(result.proposalsScrubbed).toContain(id);
      const proposal = await store.getProposal(id);
      expect(proposal).toMatchObject({ request_key_retired: true, state: 'applied' });
      expect(proposal).not.toHaveProperty('request_digest');
      expect((await store.get('record'))?.status).toBe('purged');
      const after = bytes(root) + bytes(coordinationDirectory);
      for (const secret of [candidate.body, evidence.proposal, digest, Buffer.from(digest).toString('base64')]) expect(after).not.toContain(secret);
      for (const attempt of [candidate, { ...candidate, body: 'different' }]) {
        await expect(store.proposeCreate(attempt, 'writer', evidence, options)).rejects.toMatchObject({ code: 'REQUEST_KEY_CONFLICT' });
        expect(bytes(root) + bytes(coordinationDirectory)).toBe(after);
      }
    } finally { rmSync(base, { recursive: true, force: true }); }
  }, 120_000);

  test('partial label scrub retires the key and removes the old content digest', async () => {
    const base = mkdtempSync(join(tmpdir(), 'corpus-key-partial-'));
    try {
      const root = join(base, 'store'); const coordinationDirectory = join(base, 'coordination');
      const store = new Constructor({ storeRoot: root, coordinationDirectory, coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock, allowPurge: true });
      await store.create({ ...candidate, id: 'source', body: 'ordinary' });
      const input = { ...candidate, id: 'pending', body: 'ordinary', links: [{ target_id: 'source', kind: 'related', label: 'ERASED_LABEL_SENTINEL' }] };
      const options = { requestKey: 'opaque-partial-key' };
      const id = await store.proposeCreate(input, 'writer', evidence, options);
      const digest = (await store.getProposal(id))!.request_digest!;
      await store.purge(['source'], { agent: 'eraser', rationale: 'requested' });
      const proposal = await store.getProposal(id);
      expect(proposal).toMatchObject({ state: 'pending', request_key_retired: true });
      expect(proposal).not.toHaveProperty('request_digest');
      expect(proposal?.candidate.links?.[0]).not.toHaveProperty('label');
      const after = bytes(root) + bytes(coordinationDirectory);
      expect(after).not.toContain('ERASED_LABEL_SENTINEL'); expect(after).not.toContain(digest);
      await expect(store.proposeCreate(input, 'writer', evidence, options)).rejects.toMatchObject({ code: 'REQUEST_KEY_CONFLICT' });
      expect(bytes(root) + bytes(coordinationDirectory)).toBe(after);
    } finally { rmSync(base, { recursive: true, force: true }); }
  }, 120_000);
});
