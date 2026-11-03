import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { KitDefaultStoreAdapter, KitObsidianStoreAdapter, standaloneFileMutationLock } from '../src/index.js';
import { tombstoneOf, type TombstoneShape } from '../src/shared/purge.js';
const refs = [{ kind: 'session-transcript' as const, harness: 'h', session_id: 'session', transcript_ref: 'ERASED_TRANSCRIPT_REFERENCE', sitting_id: 'sit' }];
const raw = (id: string) => ({ id, type: 'raw' as const, title: id, body: 'body', category: 'engineering', provenance: { agent: 'writer' } });
function bytes(dir: string): string {
  if (!existsSync(dir)) return '';
  return readdirSync(dir, { withFileTypes: true }).map((entry) => entry.isDirectory() ? bytes(join(dir, entry.name)) : readFileSync(join(dir, entry.name)).toString('utf8')).join('\n');
}
describe.each([['default', KitDefaultStoreAdapter], ['vault', KitObsidianStoreAdapter]] as const)('source attribution purge %s', (_profile, Constructor) => {
  test('pending-only support is scrubbed, and cascade tombstones drop attribution', async () => {
    const base = mkdtempSync(join(tmpdir(), 'corpus-source-purge-'));
    try {
      const root = join(base, 'store'); const coordinationDirectory = join(base, 'coordination');
      const store = new Constructor({ storeRoot: root, coordinationDirectory, coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock, allowPurge: true });
      await store.create(raw('source'));
      await store.create({ ...raw('dependent'), provenance: { agent: 'writer', source_ids: ['source'], source_refs: refs } });
      const candidate = { ...raw('proposed'), provenance: { agent: 'writer', source_ids: ['source'], source_refs: refs } };
      const proposal = await store.proposeCreate(candidate, 'writer', { agent: 'writer', proposal: 'keep' }, { requestKey: 'opaque-source-key' });
      expect((await store.getProposal(proposal))?.candidate.provenance.source_refs).toEqual(refs);
      expect(bytes(root) + bytes(coordinationDirectory)).toContain('ERASED_TRANSCRIPT_REFERENCE');
      const result = await store.purge(['source'], { agent: 'eraser', rationale: 'requested' });
      expect(result.cascaded).toContain('dependent'); expect(result.proposalsRejected).toContain(proposal);
      const erased = await store.getProposal(proposal); expect(erased?.state).toBe('rejected');
      expect(erased?.candidate.provenance).not.toHaveProperty('source_refs');
      expect((await store.get('dependent'))?.provenance).not.toHaveProperty('source_refs');
      expect(bytes(root) + bytes(coordinationDirectory)).not.toContain('ERASED_TRANSCRIPT_REFERENCE');
      await expect(store.proposeCreate(candidate, 'writer', { agent: 'writer', proposal: 'keep' }, { requestKey: 'opaque-source-key' })).rejects.toMatchObject({ code: 'REQUEST_KEY_CONFLICT' });
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
  test('all tombstone shapes omit source references', async () => {
    const base = mkdtempSync(join(tmpdir(), 'corpus-source-shapes-'));
    try {
      const root = join(base, 'store'); const options = { storeRoot: root, coordinationDirectory: join(base, 'coordination'), coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock, allowPurge: true };
      const store = new Constructor(options); await store.create({ ...raw('record'), provenance: { agent: 'writer', source_refs: refs } });
      const record = (await store.get('record'))!; expect(record.provenance.source_refs).toEqual(refs);
      for (const shape of ['full', 'compact', 'minimal'] as TombstoneShape[]) {
        expect(tombstoneOf(record, '2026-11-03T00:00:00.000Z', { agent: 'eraser', rationale: 'requested' }, undefined, shape).provenance).not.toHaveProperty('source_refs');
      }
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});
