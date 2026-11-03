// Reproducible validation faults. Run only from a clean committed tree.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const output = resolve(process.argv[2] ?? '/tmp/corpus-source-ref-faults');
mkdirSync(output, { recursive: true });
const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout.trim();
assert.equal(git('status', '--porcelain'), '', 'Commit and confirm a clean tree');
const run = (label, pattern, good, testFile = 'test/create-proposals.test.ts') => {
  const r = spawnSync('npm', ['run', 'test', '--workspace=@kontourai/corpus-store', '--', testFile, '-t', pattern], { cwd: root, encoding: 'utf8', timeout: 300000 });
  const log = (r.stdout ?? '') + (r.stderr ?? ''); writeFileSync(join(output, `${label}.log`), log);
  assert.equal(r.error, undefined); if (good) assert.equal(r.status, 0, log); else { assert.notEqual(r.status, 0, log); assert.ok(log.includes(`FAIL  ${testFile}`), 'fault must reach the selected test'); assert.match(log, /AssertionError:|MissingEvidenceError:|KnowledgeStoreCorruptionError:/); }
  console.log(`${label}: exit ${r.status}`);
};
const cases = [
  ['digest-omitted-refs', 'src/shared/create-proposals.ts',
    'hash(canonical({ candidate: stored, proposerId, evidence: { agent, proposal } }))',
    'hash(canonical({ candidate: existing && stored.provenance.source_refs === undefined ? { ...stored, provenance: { ...stored.provenance, source_refs: existing.candidate.provenance.source_refs } } : stored, proposerId, evidence: { agent, proposal } }))',
    'keyed retry with omitted source references'],
  ['digest-refs', 'src/shared/create-proposals.ts',
    ['hash(canonical({ candidate: stored, proposerId, evidence: { agent, proposal } }))', 'hash(canonical({ candidate: proposal.candidate, proposerId: proposal.proposer_id, evidence: proposal.evidence }))'],
    ['hash(canonical({ candidate: { ...stored, provenance: { ...stored.provenance, source_refs: undefined } }, proposerId, evidence: { agent, proposal } }))', 'hash(canonical({ candidate: { ...proposal.candidate, provenance: { ...proposal.candidate.provenance, source_refs: undefined } }, proposerId: proposal.proposer_id, evidence: proposal.evidence }))'],
    'keyed retries bind structured source references'],
  ['proposal-postcheck', 'src/shared/create-proposals.ts', 'if (JSON.stringify(stored.provenance.source_refs) !== JSON.stringify(sourceRefs))', 'if (sourceRefs !== undefined && JSON.stringify(stored.provenance.source_refs) !== JSON.stringify(sourceRefs))', 'proposal stores the validated copy'],
  ['vault-copy', 'src/obsidian-store.ts', '...(sourceRefs !== undefined ? { source_refs: sourceRefs } : {}),', '...(sourceRefs !== undefined ? { source_refs: input.provenance.source_refs } : {}),', 'direct create safely'],
  ['vault-estimate', 'src/obsidian-store.ts', "assertCreateFields(candidate, 'proposeCreate'),", 'undefined,', 'keyed proposal note sizing includes structured source references', 'test/vault-note-bound.test.ts'],
  ['proposal-copy', 'src/shared/create-proposals.ts', 'if (sourceRefs !== undefined) projected.provenance = { ...projected.provenance, source_refs: sourceRefs };', 'if (false) projected.provenance = { ...projected.provenance, source_refs: sourceRefs };', 'proposal stores the validated copy'],
  ['default-copy', 'src/default-store.ts', '...(sourceRefs !== undefined ? { source_refs: sourceRefs } : {}),', '...(sourceRefs !== undefined ? { source_refs: input.provenance.source_refs } : {}),', 'direct create safely'],
  ['copy-alias', 'src/shared/source-refs.ts', '  return result;', '  return value as KitSourceRef[];', 'direct create safely'],
  ['byte-count', 'src/shared/source-refs.ts', "Buffer.byteLength(v, 'utf8')", 'v.length', 'accepted source reference boundaries'],
  ['max-count', 'src/shared/source-refs.ts', 'value.length > 256', 'value.length >= 256', 'accepted source reference boundaries'],
  ['max-bytes', 'src/shared/source-refs.ts', "Buffer.byteLength(v, 'utf8') <= 4096", "Buffer.byteLength(v, 'utf8') < 4096", 'accepted source reference boundaries'],
  ['range-equal', 'src/shared/source-refs.ts', '(end as number) < (start as number)', '(end as number) <= (start as number)', 'accepted source reference boundaries'],
  ['sparse', 'src/shared/source-refs.ts', "if (!Object.hasOwn(value, i)) return null;", "if (!Object.hasOwn(value, i)) continue;", 'direct create safely'],
  ['count', 'src/shared/source-refs.ts', 'value.length > 256', 'value.length > 999', 'structured source refs'],
  ['blank', 'src/shared/source-refs.ts', 'v.trim().length > 0', 'true', 'structured source refs'],
  ['range-start', 'src/shared/source-refs.ts', '(start as number) < 1', '(start as number) < 0', 'structured source refs'],
  ['range-safe', 'src/shared/source-refs.ts', '!Number.isSafeInteger(end)', '!Number.isInteger(end)', 'structured source refs'],
  ['sitting', 'src/shared/source-refs.ts', "sitting_id !== undefined && !bounded(sitting_id)", "false", 'structured source refs'],
  ['read', 'src/shared/record-schema.ts', "record.provenance.source_refs !== undefined && !validSourceRefs(record.provenance.source_refs)", 'false', 'invalid source refs on disk'],
];
for (const [name, file, before, after, pattern, testFile] of cases) {
  const path = join(root, 'packages/store', file); const original = readFileSync(path, 'utf8');
  const beforeList = Array.isArray(before) ? before : [before]; const afterList = Array.isArray(after) ? after : [after];
  let changed = original; for (let i = 0; i < beforeList.length; i++) { assert.ok(changed.includes(beforeList[i]), `missing anchor: ${name}`); changed = changed.replace(beforeList[i], afterList[i]); }
  run(`${name}-baseline`, pattern, true, testFile);
  try { writeFileSync(path, changed); run(`${name}-injected`, pattern, false, testFile); }
  finally { writeFileSync(path, original); }
  run(`${name}-restored`, pattern, true, testFile);
}
assert.equal(git('status', '--porcelain'), '', 'Restore every injection');
