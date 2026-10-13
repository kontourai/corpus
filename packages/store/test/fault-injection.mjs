import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(packageRoot, '../..');
const output = resolve(process.argv[2] ?? '/tmp/corpus-store-fault-proof');
mkdirSync(output, { recursive: true });
const status = spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
assert.equal(status.status, 0);
assert.equal(status.stdout.trim(), '', 'Commit and confirm a clean tree before fault injection');
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
function run(label, args, success) {
  const result = spawnSync('npm', args, { cwd: repo, encoding: 'utf8', timeout: 240_000 });
  const log = (result.stdout ?? '') + (result.stderr ?? '');
  writeFileSync(join(output, label + '.log'), log);
  assert.equal(result.error, undefined, `Execution error for ${label}`);
  if (success) assert.equal(result.status, 0, log);
  else assert.notEqual(result.status, 0, `${label} must fail`);
  console.log(`${label}: exit ${result.status}`);
  return { label, exit: result.status, log };
}
const results = [];
const injections = [
  {
    name: 'lock', file: 'src/shared/file-transactions.ts',
    mutate: (source) => source.replace('release = await this.services.lock(this.lockPath);', 'release = () => {}; // injected missing lock'),
    args: ['run', 'conformance', '--workspace=@kontourai/corpus-store', '--', 'concurrent-create', 'concurrent-update'],
    failure: /parallel-|editor-|Expected values/,
  },
  {
    name: 'codec', file: 'src/shared/frontmatter.ts',
    mutate: (source) => source.replace('let value: unknown;', 'let value: unknown;').replace('schema: FAILSAFE_SCHEMA', '').replace('const repaired = repairLegacyDash(rawYaml);', 'const repaired = rawYaml;'),
    args: ['run', 'test', '--workspace=@kontourai/corpus-store', '--', 'test/codec.test.ts'],
    failure: /preserves old Kit scalar 1\.10[\s\S]*preserves old Kit scalar -/,
  },
  {
    name: 'expected-fail', file: 'test/expected-fails.json',
    mutate: (source) => JSON.stringify({ ...JSON.parse(source), 'create-roundtrip': { profiles: ['default', 'vault'], awaits: 'Injected incorrect expected failure', errorPattern: '.*' } }, null, 2) + '\n',
    args: ['run', 'conformance', '--workspace=@kontourai/corpus-store'],
    failure: /Expected-fail vector passed; remove it from the list/,
  },
];
for (const injection of injections) {
  const path = join(packageRoot, injection.file);
  const original = readFileSync(path, 'utf8');
  run(injection.name + '-build-baseline', ['run', 'build', '--workspace=@kontourai/corpus-store'], true);
  const baseline = run(injection.name + '-baseline', injection.args, true);
  try {
    const mutated = injection.mutate(original);
    assert.notEqual(mutated, original);
    writeFileSync(path, mutated);
    run(injection.name + '-build-injected', ['run', 'build', '--workspace=@kontourai/corpus-store'], true);
    const injected = run(injection.name + '-injected', injection.args, false);
    assert.match(injected.log, injection.failure, 'Must fail for the intended injected regression');
    results.push({ name: injection.name, baseline: baseline.exit, injected: injected.exit });
  } finally { writeFileSync(path, original); }
  run(injection.name + '-build-restored', ['run', 'build', '--workspace=@kontourai/corpus-store'], true);
  const restored = run(injection.name + '-restored', injection.args, true);
  results.at(-1).restored = restored.exit;
}
writeFileSync(join(output, 'results.json'), JSON.stringify({ revision, node: process.version, results }, null, 2) + '\n');
assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).stdout.trim(), '');
