import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(packageRoot, '../..');
const temporary = mkdtempSync(join(tmpdir(), 'corpus-pack-consumers-'));
function run(command, args, cwd) { return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 }); }
function pack(cwd) {
  const output = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', temporary], cwd));
  return join(temporary, output[0].filename);
}
try {
  const store = pack(packageRoot);
  const conformance = pack(join(repo, 'packages/conformance'));
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
 const adapter = new Constructor({ storeRoot: new URL('./' + Constructor.name, import.meta.url).pathname, coordinationDirectory: new URL('./coordination', import.meta.url).pathname });
 const id = await adapter.create({ type: 'raw', title: 'Installed', body: 'Consumer body', category: 'testing', provenance: { agent: 'consumer' } });
 assert.equal((await adapter.get(id)).body, 'Consumer body');
}
await assert.rejects(import('@kontourai/corpus-store/src/default-store.ts'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
await assert.rejects(import('@kontourai/corpus-store/storage'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
`);
  run(process.execPath, ['probe.mjs'], js);
  for (const file of ['conformance.mjs', 'conformance-harness.mjs', 'store-child.mjs', 'expected-fails.json']) cpSync(join(packageRoot, 'test', file), join(js, file));
  console.log(run(process.execPath, ['conformance.mjs'], js));
  console.log(run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', store, 'typescript@5.9.3', '@types/node@24'], ts));
  writeFileSync(join(ts, 'probe.ts'), `
import { KitDefaultStoreAdapter, KitObsidianStoreAdapter, type KnowledgeStoreAdapter, type StoreOptions, type FileMutationLock, type KitRecord } from '@kontourai/corpus-store';
import { MissingEvidenceError } from '@kontourai/corpus-store/errors';
import { observeExactKnowledgeRecordFile } from '@kontourai/corpus-store/observation';
const lock: FileMutationLock = async (_path) => () => {};
const options: StoreOptions = { storeRoot: '/consumer', coordinationDirectory: '/coordination', lock, clock: () => 0, ids: () => 'id', diagnostics: { warn() {} }, transactionObserver(_operation, _outcome) {} };
const stores: KnowledgeStoreAdapter[] = [new KitDefaultStoreAdapter(options), new KitObsidianStoreAdapter(options)];
async function read(): Promise<KitRecord | null> { return stores[0].get('id'); }
void read; void MissingEvidenceError; void observeExactKnowledgeRecordFile;
`);
  run(process.execPath, [join(ts, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', 'probe.ts'], ts);
  console.log(run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', docs], docsConsumer));
  // Run the installed, unbuilt docs CLI on this actual repository, not a self-authored fixture.
  console.log(run(process.execPath, [join(docsConsumer, 'node_modules/@kontourai/corpus/bin/corpus.mjs'), 'check'], repo));
  const rootMetadata = JSON.parse(readFileSync(join(docsConsumer, 'node_modules/@kontourai/corpus/package.json')));
  assert.equal(rootMetadata.scripts.prepare, undefined);
  assert.equal(rootMetadata.scripts.build, undefined);
  console.log(JSON.stringify({ node: process.version, storeSha256: createHash('sha256').update(readFileSync(store)).digest('hex'), js: 'PASS', ts: 'PASS', docsPackedBuildFree: 'PASS' }));
} finally { rmSync(temporary, { recursive: true, force: true }); }
