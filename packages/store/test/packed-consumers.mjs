import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(packageRoot, '../..');
const artifacts = process.argv[2] ? resolve(process.argv[2]) : null;
const temporary = mkdtempSync(join(tmpdir(), 'corpus-pack-consumers-'));
function sha256(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
function run(command, args, cwd) { return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 }); }
function pack(cwd) {
  const output = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], cwd));
  return join(temporary, output[0].filename);
}
try {
  const store = pack(packageRoot);
  const conformance = pack(join(repo, 'packages/conformance'));
  const verified = [store, conformance].map((file) => ({ file, hash: sha256(file) }));
  const docs = pack(repo);
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
import { KitDefaultStoreAdapter, KitObsidianStoreAdapter, standaloneFileMutationLock } from '@kontourai/corpus-store';
import { KnowledgeStoreCorruptionError } from '@kontourai/corpus-store/errors';
import { observeExactKnowledgeRecordFile } from '@kontourai/corpus-store/observation';
const metadata = await import('@kontourai/corpus-store/package.json', { with: { type: 'json' } });
assert.equal(metadata.default.name, '@kontourai/corpus-store');
assert.equal(typeof KnowledgeStoreCorruptionError, 'function');
assert.equal(typeof observeExactKnowledgeRecordFile, 'function');
assert.equal(typeof standaloneFileMutationLock, 'function');
for (const Constructor of [KitDefaultStoreAdapter, KitObsidianStoreAdapter]) {
 const adapter = new Constructor({ storeRoot: new URL('./' + Constructor.name, import.meta.url).pathname, coordinationDirectory: new URL('./coordination', import.meta.url).pathname, coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock });
 const id = await adapter.create({ type: 'raw', title: 'Installed', body: 'Consumer body', category: 'testing', provenance: { agent: 'consumer' } });
 assert.equal((await adapter.get(id)).body, 'Consumer body');
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
  console.log(run(process.execPath, ['conformance.mjs'], js));
  console.log(run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', store, 'typescript@5.9.3', '@types/node@24.19.2'], ts));
  writeFileSync(join(ts, 'probe.ts'), `
import { KitDefaultStoreAdapter, KitObsidianStoreAdapter, type KnowledgeStoreAdapter, type StoreOptions, type FileMutationLock, type KitRecord } from '@kontourai/corpus-store';
import { MissingEvidenceError } from '@kontourai/corpus-store/errors';
import { observeExactKnowledgeRecordFile } from '@kontourai/corpus-store/observation';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
const lock: FileMutationLock = async (_path) => () => {};
const options: StoreOptions = { storeRoot: resolve('typed-store'), coordinationDirectory: resolve('typed-coordination'), coordinationIdentity: () => () => {}, lock, clock: () => 0, ids: () => 'id', diagnostics: { warn() {} }, transactionObserver(_operation, _outcome) {} };
const stores: KnowledgeStoreAdapter[] = [new KitDefaultStoreAdapter(options), new KitObsidianStoreAdapter(options)];
async function read(): Promise<KitRecord | null> { return stores[0].get('id'); }
const id = await stores[0].create({ type: 'raw', title: 'Typed consumer', body: 'Typed body', category: 'testing', provenance: { agent: 'consumer' } });
assert.equal((await stores[0].get(id))?.body, 'Typed body');
function invalidConfigurations(): void {
  // @ts-expect-error Coordination identity must be supplied even with an explicit lock and directory.
  new KitDefaultStoreAdapter({ storeRoot: resolve("invalid-identity"), lock, coordinationDirectory: resolve("invalid-coordination") });
  // @ts-expect-error All host coordination services are required.
  new KitDefaultStoreAdapter({ storeRoot: resolve('invalid-default') });
  // @ts-expect-error A standalone lock still needs an explicit directory.
  new KitObsidianStoreAdapter({ storeRoot: resolve('invalid-vault'), lock });
}
void invalidConfigurations;
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
} finally { rmSync(temporary, { recursive: true, force: true }); }
