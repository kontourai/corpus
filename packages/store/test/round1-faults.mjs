import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const output = resolve(process.argv[2] ?? join(tmpdir(), 'corpus-round1-faults'));
mkdirSync(output, { recursive: true });
const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
assert.equal(git('status', '--porcelain').stdout.trim(), '', 'Commit a clean baseline before mutation');
const revision = git('rev-parse', 'HEAD').stdout.trim();
const store = 'packages/store/';
const owner = store + 'src/shared/frontmatter.ts';
const focused = (...files) => ['run', 'test', '--workspace=@kontourai/corpus-store', '--', ...files];
const controls = [
  { id: 'B1', file: owner, mutate: (s) => s.replace("kind === 'number' && plain", "kind === 'number' && path[0] !== 'mutation_log' && plain"), args: focused('test/codec.test.ts', 'test/round1.test.ts'), reason: /supersede evidence|typed field inventory|mutation-default/ },
  { id: 'B2-read', file: owner, mutate: (s) => s.replace("kind === 'unknown' && plain", "false && kind === 'unknown' && plain"), args: focused('test/codec.test.ts', 'test/round1.test.ts'), reason: /unknown extensions|unchanged unknown (3|true|null)/ },
  { id: 'B2-source', file: owner, mutate: (s) => s.replace('  Object.defineProperty(record, SOURCE,', '  // Object.defineProperty(record, SOURCE,'), args: focused('test/codec.test.ts', 'test/round1.test.ts'), reason: /exactly re-emits|preserve their unchanged scalar siblings/ },
  { id: 'B3', file: store + 'src/services.ts', mutate: (s) => "import { standaloneFileMutationLock } from './standalone-lock.js';\n" + s.replace(/  if \(typeof options\?\.lock[^\n]+\n/, '').replace(/  if \(typeof options\.coordinationDirectory[^\n]+\n/, '').replace('resolve(options.coordinationDirectory)', 'resolve(options.coordinationDirectory ?? resolve((options).storeRoot ?? ".", "coordination"))').replace('lock: options.lock,', 'lock: options.lock ?? standaloneFileMutationLock,').replace('(options).storeRoot', '(options as { storeRoot?: string }).storeRoot'), args: focused('test/round1.test.ts'), reason: /requires an explicit lock/ },
  { id: 'M1', file: store + 'src/shared/file-transactions.ts', mutate: (s) => s.replace('    recheckIdentity?.();', '    // injected omitted identity recheck').replace('    this.recheckCoordinationIdentity?.();', '    // injected omitted writer identity recheck'), args: focused('test/round1.test.ts'), reason: /coordination identity refuses/ },
  { id: 'M2-assertion', file: store + 'test/conformance.mjs', mutate: (s) => s.replace('isDeepStrictEqual(result.assertion, decision.assertions[profile])', 'true'), args: focused('test/adjudication.test.ts'), reason: /bind to the exact assertion/ },
  { id: 'M2-selected', file: store + 'test/conformance.mjs', mutate: (s) => s.replace('const result = adjudicate(report, profile, expected, { selected: selected.length > 0 });', 'const result = selected.length ? { passed: report.passed, unexpected: report.results.filter((entry) => !entry.passed) } : adjudicate(report, profile, expected);'), args: focused('test/adjudication.test.ts'), reason: /selected-vector CLI applies/ },
  { id: 'M3-publication', file: store + 'src/default-store.ts', mutate: (s) => s.replace("import { mkdirSync } from 'node:fs';", "import { mkdirSync, writeFileSync } from 'node:fs';"), args: focused('test/adapter-boundary.test.ts'), reason: /writeFileSync/ },
  { id: 'M3-owner', file: store + 'src/standalone-lock.ts', mutate: (s) => s.replace('`${process.pid}-${randomUUID()}`', '`${process.ppid}-${randomUUID()}`'), args: focused('test/file-transactions.test.ts'), reason: /serializes mutations across real processes/ },
  { id: 'L1', file: 'docs/store-extraction.md', mutate: (s) => s + '\nMachine-private receipt: /tmp/corpus-program/local-log.txt\n', command: process.execPath, args: ['--test', 'test/public-store-docs.test.mjs'], reason: /machine-private receipt paths/ },
  { id: 'L2', file: store + 'src/default-store.ts', mutate: (s) => s.replace('Object.defineProperty(this, "files", { enumerable: false });', 'Object.defineProperty(this, "files", { enumerable: true });'), args: focused('test/round1.test.ts'), reason: /out of enumerable adapter properties/ },
  { id: 'L3', file: owner, mutate: (s) => s.replace("if (kind === 'number' && plain && typeof typed === 'number') value = typed;", "if (kind === 'number' && typeof original === 'string' && Number.isFinite(Number(original))) value = Number(original);"), args: focused('test/round1.test.ts'), reason: /quoted numeric TTL remains corruption/ },
  { id: 'B3-types', file: store + 'src/services.ts', mutate: (s) => s.replace('coordinationDirectory: string;', 'coordinationDirectory?: string;').replace('lock: FileMutationLock;', 'lock?: FileMutationLock;'), args: ['run', 'verify:pack', '--workspace=@kontourai/corpus-store'], reason: /Unused '@ts-expect-error' directive/ },
  { id: 'B4-packed-dependency', file: 'package.json', mutate: (s) => { const pkg = JSON.parse(s); delete pkg.dependencies['npm-package-arg']; return JSON.stringify(pkg, null, 2) + '\n'; }, args: ['run', 'verify:pack', '--workspace=@kontourai/corpus-store'], reason: /Cannot find package ['"]npm-package-arg/ },
];
function run(label, args, success, command = 'npm') {
  const result = spawnSync(command, args, { cwd: repo, encoding: 'utf8', timeout: 240000 });
  const log = (result.stdout ?? '') + (result.stderr ?? '');
  writeFileSync(join(output, label + '.log'), log);
  assert.equal(result.error, undefined, `${label}: execution error`);
  assert.equal(result.signal, null, `${label}: interrupted command`);
  if (success) assert.equal(result.status, 0, log); else assert.notEqual(result.status, 0, `${label} must fail`);
  console.log(`${label}: exit ${result.status}`);
  return { exit: result.status, log };
}
run('build-baseline', ['run', 'build', '--workspace=@kontourai/corpus-store'], true);
const results = [];
const selected = process.argv.slice(3);
for (const control of controls.filter((control) => !selected.length || selected.includes(control.id))) {
  const file = join(repo, control.file);
  const original = readFileSync(file, 'utf8');
  const baseline = run(control.id + '-baseline', control.args, true, control.command);
  let injected;
  try {
    const mutated = control.mutate(original); assert.notEqual(mutated, original);
    writeFileSync(file, mutated);
    if (control.id === 'B4-packed-dependency' || control.id === 'B3-types') run('build-injected', ['run', 'build', '--workspace=@kontourai/corpus-store'], true);
    injected = run(control.id + '-injected', control.args, false, control.command);
    assert.match(injected.log, control.reason, `${control.id}: wrong rejection reason`);
  } finally { writeFileSync(file, original); }
  if (control.id === 'B4-packed-dependency' || control.id === 'B3-types') run('build-restored', ['run', 'build', '--workspace=@kontourai/corpus-store'], true);
  const restored = run(control.id + '-restored', control.args, true, control.command);
  results.push({ id: control.id, baseline: baseline.exit, injected: injected.exit, restored: restored.exit });
  writeFileSync(join(output, 'results.json'), JSON.stringify({ revision, node: process.version, results }, null, 2) + '\n');
  assert.equal(git('status', '--porcelain').stdout.trim(), '', `${control.id}: failed to restore baseline`);
}
writeFileSync(join(output, 'results.json'), JSON.stringify({ revision, node: process.version, results }, null, 2) + '\n');
