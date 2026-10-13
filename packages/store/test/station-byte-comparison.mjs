import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const stationRepo = process.argv[2];
if (!stationRepo) throw new Error('Usage: station-byte-comparison.mjs <Station repository> [report.json]');
const revision = '2479f38b1ab062e2d9cd6df9f8fa2cdbeee1d136';
const base = realpathSync(mkdtempSync(join(tmpdir(), 'corpus-station-bytes-')));
const snapshot = join(base, 'snapshot');
const corpusRequire = createRequire(import.meta.url);
const corpusRepo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const corpusRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: corpusRepo, encoding: 'utf8' }).trim();
assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: corpusRepo, encoding: 'utf8' }).trim(), '', 'Commit the comparison baseline first');
try {
  const inventory = execFileSync('git', ['ls-tree', '-r', '--name-only', revision], { cwd: stationRepo, encoding: 'utf8' }).trim().split('\n');
  const explicit = new Set(['src-server/knowledge-store/errors.ts', 'src-server/knowledge-index/path-safety.ts', 'src-server/utils/logger.ts', 'src-server/utils/paths.ts', 'src-server/utils/is-record.ts', 'src-server/telemetry/metrics.ts']);
  const files = inventory.filter((file) => file.startsWith('packages/shared/') && !file.includes('/__tests__/') || file.startsWith('src-server/knowledge-store/adapters/') && !file.includes('/__tests__/') || explicit.has(file));
  for (const file of files) {
    const destination = join(snapshot, file); mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, execFileSync('git', ['show', `${revision}:${file}`], { cwd: stationRepo }));
  }
  writeFileSync(join(snapshot, 'package.json'), '{"type":"module"}\n');
  for (const name of ['js-yaml', 'pino', 'pino-pretty', '@opentelemetry/api']) {
    const entry = realpathSync(join(resolve(stationRepo), 'node_modules', name));
    const destination = join(snapshot, 'node_modules', name); mkdirSync(dirname(destination), { recursive: true });
    symlinkSync(entry, destination, 'dir');
  }
  const shared = join(snapshot, 'node_modules/@kontourai/station-shared');
  mkdirSync(dirname(shared), { recursive: true }); symlinkSync(join(snapshot, 'packages/shared'), shared, 'dir');
  const result = spawnSync(process.execPath, ['--import', corpusRequire.resolve('tsx'), fileURLToPath(new URL('./station-byte-worker.mjs', import.meta.url)), snapshot, base, process.argv[3] ?? ''], { encoding: 'utf8', timeout: 120000, env: { ...process.env, STATION_HOME: join(base, 'station-home'), CORPUS_COMPARISON_SHA: corpusRevision } });
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, 'Station comparison did not complete');
} finally { rmSync(base, { recursive: true, force: true }); }
