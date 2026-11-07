import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(packageRoot, '../..');
const artifacts = process.argv[2] ? resolve(process.argv[2]) : null;
const temporary = mkdtempSync(join(tmpdir(), 'corpus-pack-consumers-'));
function sha256(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
function run(command, args, cwd, timeout = 180_000) { return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout }); }
function pack(cwd) {
  const output = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], cwd));
  return join(temporary, output[0].filename);
}
try {
  const store = pack(packageRoot);
  const storeHash = sha256(store);
  console.log(JSON.stringify({ artifact: store, sha256: storeHash }));
  const conformance = pack(join(repo, 'packages/conformance'));
  const conformanceHash = sha256(conformance);
  console.log(JSON.stringify({ artifact: conformance, sha256: conformanceHash }));
  const verified = [{ file: store, hash: storeHash }, { file: conformance, hash: conformanceHash }];
  const docs = pack(repo);
  console.log(JSON.stringify({ artifact: docs, sha256: sha256(docs) }));
  const js = join(temporary, 'js-consumer');
  const ts = join(temporary, 'ts-consumer');
  const docsConsumer = join(temporary, 'docs-consumer');
  for (const directory of [js, ts, docsConsumer]) {
    mkdirSync(directory);
    cpSync(join(repo, 'LICENSE'), join(directory, 'LICENSE'));
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module', scripts: {} }));
  }
  console.log(run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', store, conformance], js));
  writeFileSync(join(js, 'probe.mjs'), `
import assert from 'node:assert/strict';
import { KitDefaultStoreAdapter, KitObsidianStoreAdapter, standaloneFileMutationLock, reviewedConfidenceCandidateDigest } from '@kontourai/corpus-store';
import { KnowledgeStoreCorruptionError } from '@kontourai/corpus-store/errors';
import { observeExactKnowledgeRecordFile } from '@kontourai/corpus-store/observation';
const metadata = await import('@kontourai/corpus-store/package.json', { with: { type: 'json' } });
assert.equal(metadata.default.name, '@kontourai/corpus-store');
assert.equal(typeof KnowledgeStoreCorruptionError, 'function');
assert.equal(typeof observeExactKnowledgeRecordFile, 'function');
assert.equal(typeof standaloneFileMutationLock, 'function');
for (const Constructor of [KitDefaultStoreAdapter, KitObsidianStoreAdapter]) {
 const adapter = new Constructor({ storeRoot: new URL('./' + Constructor.name, import.meta.url).pathname, coordinationDirectory: new URL('./coordination', import.meta.url).pathname, coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock, allowReviewedConfidence: true, allowPurge: true });
 const id = await adapter.create({ type: 'raw', title: 'Installed', body: 'Consumer body', category: 'testing', provenance: { agent: 'consumer' } });
 assert.equal((await adapter.get(id)).body, 'Consumer body');
 for (const item of ['review-target', 'review-source']) await adapter.create({ id: item, type: 'raw', title: item, body: 'body', category: 'testing', confidence: 0.3, provenance: { agent: 'consumer' } });
 const target = await adapter.reviewedConfidenceSnapshot('review-target');
 const source = await adapter.reviewedConfidenceSnapshot('review-source');
 const candidate = { rootBinding: target.rootBinding, recordId: 'review-target', revision: target.revision, oldConfidence: 0.3, newConfidence: 0.7, evidence: [{ id: 'review-source', revision: source.revision }] };
 const request = { ...candidate, candidateDigest: reviewedConfidenceCandidateDigest(candidate), authorizationDigest: 'sha256:' + 'a'.repeat(64), requestKey: 'packed', agent: 'reviewer' };
 const receipt = await adapter.applyReviewedConfidence(request);
 assert.deepEqual(await adapter.applyReviewedConfidence(request), receipt);
 assert.equal((await adapter.get('review-target')).confidence, 0.7);
 await adapter.update('review-source', { body: 'changed' }, { agent: 'editor' });
 await assert.rejects(adapter.applyReviewedConfidence(request), { code: 'STALE_REVISION' });
 await adapter.purge(['review-source'], { agent: 'eraser', rationale: 'requested' });
 await assert.rejects(adapter.applyReviewedConfidence(request), { code: 'REQUEST_KEY_CONFLICT' });
}
{
 const closed = new KitDefaultStoreAdapter({ storeRoot: new URL('./closed', import.meta.url).pathname, coordinationDirectory: new URL('./coordination', import.meta.url).pathname, coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock });
 const id = await closed.create({ type: 'raw', title: 'Installed', body: 'Consumer body', category: 'testing', provenance: { agent: 'consumer' } });
 await assert.rejects(closed.purge([id], { agent: 'consumer', rationale: 'test' }), { code: 'READ_ONLY' });
 await assert.rejects(closed.purgeProposal('proposal', { agent: 'consumer', rationale: 'test' }), { code: 'READ_ONLY' });
}
await assert.rejects(import('@kontourai/corpus-store/src/default-store.ts'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
await assert.rejects(import('@kontourai/corpus-store/storage'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
`);
  run(process.execPath, ['probe.mjs'], js);
  // The installed bin converts a copy of the committed Knowledge Kit vault.
  const bin = join(js, 'node_modules/.bin/corpus-store');
  const usage = spawnSync(bin, [], { encoding: 'utf8' });
  assert.equal(usage.status, 2, usage.stderr);
  assert.match(usage.stderr, /usage: corpus-store migrate/);
  cpSync(join(packageRoot, 'test/fixtures/kit-v1/kit-vault'), join(js, 'kit-vault'), { recursive: true });
  const migrated = JSON.parse(run(bin, ['migrate', join(js, 'kit-vault')], js));
  assert.equal(migrated.outcome, 'migrated');
  assert.equal(migrated.records, 6);
  const manifest = JSON.parse(readFileSync(join(js, 'kit-vault/.corpus-store-migration/manifest.json'), 'utf8'));
  assert.deepEqual(manifest.tool, { name: '@kontourai/corpus-store', version: JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version });
  for (const file of ['conformance.mjs', 'conformance-harness.mjs', 'store-child.mjs', 'expected-fails.json']) cpSync(join(packageRoot, 'test', file), join(js, file));
  // Every vector runs on both profiles, several in child processes; a loaded CI runner needs more than the default.
  console.log(run(process.execPath, ['conformance.mjs'], js, 600_000));
  console.log(run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', store, 'typescript@5.9.3', '@types/node@24.19.2'], ts));
  writeFileSync(join(ts, 'probe.ts'), `
import { assertAdapterBoundTo, KitDefaultStoreAdapter, KitObsidianStoreAdapter, type KnowledgeStoreAdapter, type RootBoundAdapter, type KnowledgeStoreCreateProposals, type KnowledgeStorePurger, type PurgeResult, type ProposalPurgeResult, type StoreOptions, type FileMutationLock, type KitRecord, type KnowledgeStoreReviewedConfidence, type ReviewedConfidenceSnapshot, type ReviewedConfidenceRequest, type ReviewedConfidenceReceipt, reviewedConfidenceCandidateDigest } from '@kontourai/corpus-store';
import { MissingEvidenceError } from '@kontourai/corpus-store/errors';
import { observeExactKnowledgeRecordFile } from '@kontourai/corpus-store/observation';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
const lock: FileMutationLock = async (_path) => () => {};
const options: StoreOptions = { storeRoot: resolve('typed-store'), coordinationDirectory: resolve('typed-coordination'), coordinationIdentity: () => () => {}, lock, clock: () => 0, ids: () => 'id', diagnostics: { warn() {} }, transactionObserver(_operation, _outcome) {} };
const stores: KnowledgeStoreAdapter[] = [new KitDefaultStoreAdapter(options), new KitObsidianStoreAdapter(options)];
const reviewed: KnowledgeStoreReviewedConfidence = new KitDefaultStoreAdapter({ ...options, storeRoot: resolve('typed-reviewed'), allowReviewedConfidence: true });
const reviewedStore = reviewed as KitDefaultStoreAdapter;
for (const item of ['typed-target', 'typed-source']) await reviewedStore.create({ id: item, type: 'raw', title: item, body: 'body', category: 'testing', confidence: 0.3, provenance: { agent: 'consumer' } });
const typedTarget: ReviewedConfidenceSnapshot = await reviewed.reviewedConfidenceSnapshot('typed-target');
const typedSource: ReviewedConfidenceSnapshot = await reviewed.reviewedConfidenceSnapshot('typed-source');
const typedCandidate = { rootBinding: typedTarget.rootBinding, recordId: 'typed-target', revision: typedTarget.revision, oldConfidence: 0.3, newConfidence: 0.7, evidence: [{ id: 'typed-source', revision: typedSource.revision }] };
const typedRequest: ReviewedConfidenceRequest = { ...typedCandidate, candidateDigest: reviewedConfidenceCandidateDigest(typedCandidate), authorizationDigest: 'sha256:' + 'a'.repeat(64), requestKey: 'typed', agent: 'reviewer' };
const typedReceipt: ReviewedConfidenceReceipt = await reviewed.applyReviewedConfidence(typedRequest);
assert.deepEqual(await reviewed.applyReviewedConfidence(typedRequest), typedReceipt);
assert.equal((await reviewedStore.get('typed-target'))?.confidence, 0.7);
async function read(): Promise<KitRecord | null> { return stores[0].get('id'); }
const id = await stores[0].create({ type: 'raw', title: 'Typed consumer', body: 'Typed body', category: 'testing', provenance: { agent: 'consumer' } });
assert.equal((await stores[0].get(id))?.body, 'Typed body');
// @ts-expect-error purge is privileged and is not part of the ordinary adapter type.
void stores[0].purge;
const purger: KnowledgeStorePurger = new KitDefaultStoreAdapter({ ...options, allowPurge: true });
const outcome: PurgeResult = await purger.purge([id], { agent: 'privacy-officer', rationale: 'erasure request' });
assert.deepEqual(outcome.purged, [id]);
assert.equal((await stores[0].get(id))?.status, 'purged');
// A proposal is erased by its own id through the same privileged type, and an unknown id is NOT_FOUND.
const erasedProposal: Promise<ProposalPurgeResult> = purger.purgeProposal('no-such-proposal', { agent: 'privacy-officer', rationale: 'erasure request' });
await assert.rejects(erasedProposal, { code: 'NOT_FOUND' });
function invalidConfigurations(): void {
  // @ts-expect-error Coordination identity must be supplied even with an explicit lock and directory.
  new KitDefaultStoreAdapter({ storeRoot: resolve("invalid-identity"), lock, coordinationDirectory: resolve("invalid-coordination") });
  // @ts-expect-error All host coordination services are required.
  new KitDefaultStoreAdapter({ storeRoot: resolve('invalid-default') });
  // @ts-expect-error A standalone lock still needs an explicit directory.
  new KitObsidianStoreAdapter({ storeRoot: resolve('invalid-vault'), lock });
}
void invalidConfigurations;
// The concept-proposal apply and reject keep their signatures; the create-proposal verbs are separate methods.
// Compile-time only: none of this runs.
function bindingTypes(adapter: KnowledgeStoreAdapter, root: string): RootBoundAdapter {
  assertAdapterBoundTo(adapter, root);
  return adapter;
}
void bindingTypes;
function proposalTypes(): void {
  const conceptApply: Parameters<KitDefaultStoreAdapter['apply']> = ['target', 'proposer', { agent: 'a', new_body: 'b', rationale: 'r' }];
  const conceptReject: Parameters<KitObsidianStoreAdapter['reject']> = ['target', 'proposer', { agent: 'a', reason: 'r' }];
  const proposals: KnowledgeStoreCreateProposals[] = [new KitDefaultStoreAdapter(options), new KitObsidianStoreAdapter(options)];
  const proposalId: Promise<string> = proposals[0].proposeCreate({ type: 'raw', title: 't', body: 'b', category: 'testing', provenance: { agent: 'consumer' } }, 'proposer', { agent: 'consumer', proposal: 'p' });
  const applied: Promise<string> = proposals[0].applyCreate('proposal', 'reviewer');
  const rejected: Promise<void> = proposals[1].rejectCreate('proposal', 'reviewer', 'rationale');
  void conceptApply; void conceptReject; void proposalId; void applied; void rejected;
}
void proposalTypes;
void read; void MissingEvidenceError; void observeExactKnowledgeRecordFile;
`);
  run(process.execPath, [join(ts, 'node_modules/typescript/bin/tsc'), '--outDir', 'compiled', '--strict', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', 'probe.ts'], ts);
  run(process.execPath, ['compiled/probe.js'], ts);
  console.log(run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', docs], docsConsumer));
  // Run the installed, unbuilt docs CLI on this actual repository, not a self-authored fixture.
  console.log(run(process.execPath, [join(docsConsumer, 'node_modules/@kontourai/corpus/bin/corpus.mjs'), 'check'], repo));
  const rootMetadata = JSON.parse(readFileSync(join(docsConsumer, 'node_modules/@kontourai/corpus/package.json')));
  assert.equal(rootMetadata.scripts.prepare, undefined);
  assert.equal(rootMetadata.scripts.build, undefined);
  if (artifacts) {
    mkdirSync(artifacts, { recursive: true });
    const sums = [];
    for (const { file, hash } of verified) {
      assert.equal(sha256(file), hash, 'verified tarball changed during consumer tests');
      const filename = basename(file);
      const destination = join(artifacts, filename);
      cpSync(file, destination);
      assert.equal(sha256(destination), hash, 'exported tarball differs from verified tarball');
      sums.push(`${hash}  ${filename}`);
    }
    writeFileSync(join(artifacts, 'SHA256SUMS'), sums.join('\n') + '\n');
  }
  console.log(JSON.stringify({ node: process.version, storeSha256: verified[0].hash, conformanceSha256: verified[1].hash, js: 'PASS', ts: 'PASS', docsPackedBuildFree: 'PASS' }));
} finally {
  // Retain the entire consumer root even if a nested child has not settled.
  console.error(`Packed-consumer artifacts retained at ${temporary}; audit ownership and processes before removal.`);
}
