// Reproducible faults for the purge preview and its revision (kontourai/corpus#69). Run only from a clean committed tree.
// Each case weakens one rule in the source and requires the unit test that names it, and the conformance vectors that
// cover it, to fail for the stated reason. It then restores the file, rebuilds, and requires both to pass again.
//   node test/preview-faults.mjs [output-directory] [--from=NAME] [--check-targets]
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const output = resolve(process.argv.find((arg, i) => i > 1 && !arg.startsWith('--')) ?? '/tmp/corpus-preview-faults');
const testFile = 'test/purge-preview.test.ts';
const workspace = '--workspace=@kontourai/corpus-store';
const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout.trim();
const npm = (label, args) => {
  const r = spawnSync('npm', args, { cwd: root, encoding: 'utf8', timeout: 900000 });
  const log = (r.stdout ?? '') + (r.stderr ?? '');
  writeFileSync(join(output, `${label}.log`), log);
  assert.equal(r.error, undefined);
  return { status: r.status, log };
};
const build = (label) => assert.equal(npm(label, ['run', 'build', workspace]).status, 0, `${label}: build failed`);
const unit = (label, pattern, failure) => {
  const { status, log } = npm(label, ['run', 'test', workspace, '--', testFile, ...(pattern ? ['-t', pattern] : [])]);
  if (!failure) assert.equal(status, 0, log);
  else {
    assert.notEqual(status, 0, `${label}: the fault was not caught\n${log}`);
    // A run that selected nothing, or that broke the build, is not a catch.
    assert.ok(log.includes(`FAIL  ${testFile}`), `${label}: the fault must fail the selected test\n${log}`);
    assert.match(log, failure, `${label}: failed for another reason\n${log}`);
  }
  console.log(`${label}: exit ${status}`);
};
const conformance = (label, vectors, failure) => {
  const { status, log } = npm(label, ['run', 'conformance', workspace, '--', ...vectors]);
  if (!failure) assert.equal(status, 0, log);
  else {
    assert.notEqual(status, 0, `${label}: the fault was not caught\n${log}`);
    for (const id of vectors) assert.ok(log.includes(`"id": "${id}"`) && log.includes('"passed": false'), `${label}: expected ${id} to fail\n${log}`);
    assert.match(log, failure, `${label}: failed for another reason\n${log}`);
  }
  console.log(`${label}: exit ${status}`);
};
const ALL_VECTORS = [
  'purge-preview-parity-cascade', 'purge-preview-parity-cycle', 'purge-preview-parity-already-purged', 'purge-preview-parity-proposals',
  'purge-preview-proposal-parity-pending', 'purge-preview-proposal-parity-rejected', 'purge-preview-proposal-parity-applied',
  'purge-preview-proposal-parity-erased', 'purge-preview-writes-nothing', 'purge-preview-revision-stable',
  'purge-preview-stale-record-write', 'purge-preview-stale-record-create', 'purge-preview-stale-proposal-write',
  'purge-preview-stale-request-key', 'purge-preview-stale-proposal-settled', 'purge-preview-request-key-retry-not-stale',
  'purge-preview-proposal-stale', 'purge-preview-input-validation',
];
const NOT_STALE_UNIT = /expected undefined to be 'STALE_REVISION'/;
const STALE_VECTOR = /purge must reject/;
const DEFAULT_PREVIEW = "return { ...this.purgeResultOf(this.planPurgeLocked(requested)), revision };";
const VAULT_PREVIEW = DEFAULT_PREVIEW;
const D = 'src/default-store.ts';
const V = 'src/obsidian-store.ts';
const cases = [];
// [name, file, before, after, unit test name pattern, unit failure, conformance vectors, conformance failure]
const add = (...c) => cases.push(c);
for (const [tag, file] of [['default', D], ['vault', V]]) {
  // The preview must be the committed plan's lists, so a preview that reports less than the result is caught.
  add(`${tag}-preview-drops-survivors`, file, DEFAULT_PREVIEW, "return { ...this.purgeResultOf(this.planPurgeLocked(requested)), survivors: [], revision };",
    'previewPurge names exactly what purge then does', /survivors|toEqual|to equal/, ['purge-preview-parity-cascade'], /preview\.survivors/);
  // A preview that erases is not a preview.
  add(`${tag}-preview-commits`, file, DEFAULT_PREVIEW, "return { ...this.purgeLocked(requested, { agent: 'preview', rationale: 'preview' }), revision };",
    'neither preview writes a byte', /expected .* to be |to equal|toBe/, ['purge-preview-writes-nothing'], /after|depAfter/);
  // A preview that carries content.
  add(`${tag}-preview-leaks-titles`, file, DEFAULT_PREVIEW,
    "{ const x = this.planPurgeLocked(requested); return { ...this.purgeResultOf(x), revision, titles: [...x.records.values()].map((r) => r.title) } as PurgePreview; }",
    'a preview contains ids, states and a revision, and none of the content', /ZEBRA-TITLE|to contain|not.*toContain|expected/, [], /./);
  // Preview must not need purge to be enabled.
  add(`${tag}-preview-needs-allow-purge`, file, "    const requested = validatePreviewPurgeInput(ids);\n",
    "    const requested = validatePreviewPurgeInput(ids);\n    if (this.services.allowPurge !== true) throw new ReadOnlyStoreError('previewPurge', 'disabled');\n",
    'a store built without allowPurge can preview', /READ_ONLY|disabled|expected/, [], /./);
  add(`${tag}-proposal-preview-drops-record`, file,
    tag === 'default' ? "        ...(step && 'purge' in step ? { record: this.purgeResultOf(step.purge) } : {})," : "        ...(plan.record ? { record: this.purgeResultOf(plan.record) } : {}),",
    '', 'an applied proposal: the preview shows the record', /record|undefined/, ['purge-preview-proposal-parity-applied'], /preview\.record/);
  // The revision must cover records and proposals, or an intervening write goes unnoticed.
  add(`${tag}-assert-revision-noop`, file, "if (expected !== undefined && this.revisionLocked() !== expected) throw new StaleRevisionError(op);",
    "if (false as boolean) throw new StaleRevisionError(op);", 'STALE_REVISION when a record is updated', NOT_STALE_UNIT, ['purge-preview-stale-record-write', 'purge-preview-proposal-stale'], STALE_VECTOR);
  add(`${tag}-purge-proposal-skips-revision`, file, "        this.assertRevision('purgeProposal', expected);\n", '',
    'STALE_REVISION for purgeProposal when a record is updated', NOT_STALE_UNIT, ['purge-preview-proposal-stale'], /purgeProposal must reject/);
}
add('default-revision-ignores-records', D, "for (const id of this.listIds().sort()) revision.add(", "for (const id of [] as string[]) revision.add(",
  'STALE_REVISION when a record is created', NOT_STALE_UNIT, ['purge-preview-stale-record-create', 'purge-preview-stale-record-write'], STALE_VECTOR);
add('vault-revision-ignores-records', V, "Object.entries(pathIndex.by_id).sort(", "Object.entries(pathIndex.by_id).filter(() => false).sort(",
  'STALE_REVISION when a record is created', NOT_STALE_UNIT, ['purge-preview-stale-record-create', 'purge-preview-stale-record-write'], STALE_VECTOR);
add('default-revision-ignores-note-bytes', D, "revision.add('record', id, this.files.readText(this.recordPath(id)));", "revision.add('record', id, '');",
  'STALE_REVISION when a record is updated', NOT_STALE_UNIT, ['purge-preview-stale-record-write'], STALE_VECTOR);
add('vault-revision-ignores-note-bytes', V, "text = this.files.readText(this.getAbsPath(id, pathIndex)!);", "text = '';",
  'STALE_REVISION when a record is updated', NOT_STALE_UNIT, ['purge-preview-stale-record-write'], STALE_VECTOR);
add('revision-ignores-proposals', 'src/shared/create-proposals.ts', "      .sort()\n      .map((name) => {", "      .sort()\n      .filter(() => false)\n      .map((name) => {",
  'STALE_REVISION when a proposal is staged', NOT_STALE_UNIT, ['purge-preview-stale-proposal-write', 'purge-preview-stale-request-key'], STALE_VECTOR);
add('revision-unkeyed', 'src/shared/revision.ts', "createHmac('sha256', key)", "createHmac('sha256', '')",
  'the same records in a different store have a different revision', /expected 'rev1:[a-f0-9]+…?' not to be 'rev1:/, [], /./);
add('stale-error-code', 'src/errors.ts', "readonly code: KnowledgeStoreErrorCode = 'STALE_REVISION';", "readonly code: KnowledgeStoreErrorCode = 'MISSING_EVIDENCE';",
  'STALE_REVISION when a record is updated', /expected 'MISSING_EVIDENCE' to be 'STALE_REVISION'/, ['purge-preview-stale-record-write'], /strictly equal/);
add('empty-revision-accepted', 'src/shared/purge.ts', "typeof expected !== 'string' || expected === ''", "typeof expected !== 'string'",
  'a revision that no store has is stale, and a malformed one is a usage error', /expected 'STALE_REVISION' to be 'MISSING_EVIDENCE'/, ['purge-preview-input-validation'], /strictly equal/);
add('preview-accepts-empty-ids', 'src/shared/purge.ts', "ids.length === 0 || ", "",
  'the preview refuses what the purge refuses', /expected .* to be 'MISSING_EVIDENCE'|expected undefined/, ['purge-preview-input-validation'], /previewPurge must reject|must reject/);
add('vault-preview-ignores-migration-artifacts', V, "    this.assertNoMigrationArtifacts('purge');\n    const pathIndex = this.loadPathIndex();\n    // Commit rewrites",
  "    const pathIndex = this.loadPathIndex();\n    // Commit rewrites", 'a vault holding migration artifacts refuses the preview', /expected undefined to be 'READ_ONLY'/, [], /./);
add('vault-preview-ignores-read-only-format', V, "      this.assertWritableFormat('previewPurge');\n", '',
  'a vault that opens read-only refuses the preview', /expected .* to be 'READ_ONLY'|expected undefined/, [], /./);
add('proposal-plan-reads-neighbours', 'src/shared/create-proposals.ts', "    const proposal = this.get(proposalId);\n    if (!proposal) throw new KnowledgeRecordNotFoundError(proposalId);\n    assertErasable(proposal);\n    if (proposal.erasure) return { proposal, alreadyErased: true };",
  "    this.list();\n    const proposal = this.get(proposalId);\n    if (!proposal) throw new KnowledgeRecordNotFoundError(proposalId);\n    assertErasable(proposal);\n    if (proposal.erasure) return { proposal, alreadyErased: true };",
  'a corrupt proposal stops a record preview', /KnowledgeStoreCorruptionError|is corrupt|not valid JSON/, [], /./);

// Review of #70 (Sol): a token with no key, a preview that skips the refusals the commit makes, an unreadable neighbour,
// and a revision compared before the lock is taken (a write queued ahead of the erasure would then slip through).
for (const [tag, file] of [['default', D], ['vault', V]]) {
  add(`${tag}-revision-unbound-empty-key`, file, "    if (!this.binding) throw new RootBindingMismatchError();\n    const revision = new StoreRevision(this.binding);\n",
    "    const revision = new StoreRevision(this.binding ?? '');\n", 'a root without an identity marker cannot be previewed', /expected undefined to be 'ROOT_BINDING_MISMATCH'/, [], /./);
}
add('vault-plan-skips-index-validation', V, "    this.loadGraph();\n    this.loadAliasIndex();\n    const records = new Map<string, KitRecord>();", "    const records = new Map<string, KitRecord>();",
  'stops the preview as it stops the purge', /promise resolved/, [], /./);
add('revision-parts-throws-on-unreadable', 'src/shared/create-proposals.ts', "          if (!(error instanceof KnowledgeStoreCorruptionError)) throw error;\n          return { name:", "          throw error;\n          return { name:",
  'too large to read does not stop a pending proposal', /KnowledgeStoreCorruptionError|is corrupt|exceeds/, [], /./);
add('default-purge-checks-revision-outside-lock', D, "    return this.files.mutate('purge', () => {\n      this.assertRevision('purge', expected);\n      return this.purgeLocked(requested, evidence);\n    }, { erasure: true });",
  "    await this.files.read(() => this.assertRevision('purge', expected));\n    return this.files.mutate('purge', () => {\n      return this.purgeLocked(requested, evidence);\n    }, { erasure: true });",
  'one critical section: each takes the store lock once', /expected 2 to be 1/, [], /./);
add('vault-purge-checks-revision-outside-lock', V, "    return this.mutate('purge', () => {\n      this.assertRevision('purge', expected);\n      return this.purgeLocked(requested, evidence);\n    }, { erasure: true });",
  "    await this.files.read(() => this.assertRevision('purge', expected));\n    return this.mutate('purge', () => {\n      return this.purgeLocked(requested, evidence);\n    }, { erasure: true });",
  'one critical section: each takes the store lock once', /expected 2 to be 1/, [], /./);
add('default-purge-proposal-checks-revision-outside-lock', D, "    return this.files.mutate(\n      'purgeProposal',\n      () => {\n        this.assertRevision('purgeProposal', expected);\n",
  "    await this.files.read(() => this.assertRevision('purgeProposal', expected));\n    return this.files.mutate(\n      'purgeProposal',\n      () => {\n",
  'one critical section: each takes the store lock once', /expected 2 to be 1/, [], /./);
add('vault-purge-proposal-checks-revision-outside-lock', V, "    return this.mutate(\n      'purgeProposal',\n      () => {\n        this.assertRevision('purgeProposal', expected);\n",
  "    await this.files.read(() => this.assertRevision('purgeProposal', expected));\n    return this.mutate(\n      'purgeProposal',\n      () => {\n",
  'one critical section: each takes the store lock once', /expected 2 to be 1/, [], /./);

if (process.argv.includes('--check-targets')) {
  for (const [name, file, before] of cases) assert.ok(readFileSync(join(root, 'packages/store', file), 'utf8').includes(before), `missing anchor: ${name}`);
  console.log(`${cases.length} injection targets found`);
  process.exit(0);
}
mkdirSync(output, { recursive: true });
assert.equal(git('status', '--porcelain'), '', 'Commit and confirm a clean tree');
const from = process.argv.find((arg) => arg.startsWith('--from='))?.slice('--from='.length);
if (from) assert.ok(cases.some(([name]) => name === from), `unknown case: ${from}`);
else {
  build('build-baseline');
  unit('unit-baseline', undefined);
  conformance('conformance-baseline', ALL_VECTORS);
}
let started = !from;
for (const [name, file, before, after, pattern, unitFailure, vectors, vectorFailure] of cases) {
  started ||= name === from;
  if (!started) continue;
  const path = join(root, 'packages/store', file);
  const original = readFileSync(path, 'utf8');
  assert.ok(original.includes(before), `missing anchor: ${name}`);
  const changed = original.replace(before, () => after);
  assert.notEqual(changed, original, `the injection changed nothing: ${name}`);
  try {
    writeFileSync(path, changed);
    unit(`${name}-unit-injected`, pattern, unitFailure);
    if (vectors.length) {
      build(`${name}-build-injected`);
      conformance(`${name}-conformance-injected`, vectors, vectorFailure);
    }
  } finally {
    writeFileSync(path, original);
  }
  if (vectors.length) build(`${name}-build-restored`);
  unit(`${name}-unit-restored`, pattern);
  if (vectors.length) conformance(`${name}-conformance-restored`, vectors);
}
assert.equal(git('status', '--porcelain'), '', 'Restore every injection');
console.log(`${cases.length} faults caught and restored`);
