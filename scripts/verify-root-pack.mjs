// Packed-consumer check for the root @kontourai/corpus package.
//
// Packs the root once, checks the tarball's file list against the allow-list,
// installs that exact tarball (its dependencies come from the registry) into a
// fresh project with --ignore-scripts, and runs the installed `corpus` and
// `docs-kit` bins against a real-shaped fixture corpus with decision records
// and against this repository. With an output directory argument it then
// exports the same, unchanged tarball and a SHA256SUMS line for publication.
//
// Usage: node scripts/verify-root-pack.mjs [output-directory]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitEnv } from '../src/git.mjs';
import { packedFileProblems, trackedShippedFiles } from './root-package-files.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = process.argv[2] ? resolve(process.argv[2]) : null;
const metadata = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
const temporary = mkdtempSync(join(tmpdir(), 'corpus-root-pack-'));
const env = {
  ...gitEnv(),
  GIT_AUTHOR_NAME: 'corpus pack check',
  GIT_AUTHOR_EMAIL: 'corpus-pack-check@example.invalid',
  GIT_COMMITTER_NAME: 'corpus pack check',
  GIT_COMMITTER_EMAIL: 'corpus-pack-check@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
};

function sha256(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
}
/** Run an installed bin; returns { status, output } so rejection paths can be asserted. */
function bin(name, args, cwd) {
  const result = spawnSync(join(consumer, 'node_modules', '.bin', name), args, { cwd, env, encoding: 'utf8', timeout: 180_000 });
  if (result.error) throw result.error;
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}
function expectStatus(result, status, label) {
  assert.equal(result.status, status, `${label}: expected exit ${status}\n${result.output}`);
  return result.output;
}
function git(cwd, args) { return run('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'init.defaultBranch=main', ...args], cwd); }
function commitAll(cwd, message) { git(cwd, ['add', '-A']); git(cwd, ['commit', '-q', '-m', message]); }

const consumer = join(temporary, 'consumer');
try {
  // Pack once; everything below exercises and exports this one file.
  const [packed] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], repo));
  const tarball = join(temporary, packed.filename);
  const hash = sha256(tarball);
  assert.equal(packed.name, '@kontourai/corpus');
  assert.equal(packed.version, metadata.version);
  assert.deepEqual(packedFileProblems(packed.files.map((file) => file.path), trackedShippedFiles(repo)), []);

  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), `${JSON.stringify({ private: true, type: 'module' })}\n`);
  console.log(run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', tarball], consumer));
  const installed = join(consumer, 'node_modules', '@kontourai', 'corpus');
  const installedMetadata = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  assert.equal(installedMetadata.version, metadata.version);
  for (const script of ['preinstall', 'install', 'postinstall', 'prepare', 'build']) {
    assert.equal(installedMetadata.scripts?.[script], undefined, `the published package must not define a ${script} script`);
  }
  // The library entry point and the schema export resolve from the installed package.
  writeFileSync(join(consumer, 'probe.mjs'), `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const corpus = await import('@kontourai/corpus');
assert.equal(typeof corpus.validateDecisions, 'function');
const require = createRequire(import.meta.url);
assert.equal(require('@kontourai/corpus/schemas/decision-record.schema.json').type, 'object');
await assert.rejects(import('@kontourai/corpus/src/cli.mjs'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
`);
  run(process.execPath, ['probe.mjs'], consumer);

  // A real-shaped corpus: the "valid" docs fixture plus one product's decision
  // records copied from test/fixtures, with the decisions gate declared.
  const fixture = join(temporary, 'sample');
  cpSync(join(repo, 'test/fixtures/valid'), fixture, { recursive: true });
  const records = join(repo, 'test/fixtures/decision-records/datum');
  mkdirSync(join(fixture, 'docs/decisions'), { recursive: true });
  for (const file of readdirSync(records).filter((name) => name.endsWith('.md') && name !== 'index.md')) {
    cpSync(join(records, file), join(fixture, 'docs/decisions', file));
  }
  const manifestFile = join(fixture, 'corpus.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  manifest.decisions = { dir: 'docs/decisions' };
  manifest.exclude = [...(manifest.exclude ?? []), 'docs/decisions/**'];
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  git(fixture, ['init', '-q']);
  commitAll(fixture, 'sample corpus');
  console.log(expectStatus(bin('corpus', ['decisions', 'index', '--root', fixture], repo), 0, 'corpus decisions index'));
  commitAll(fixture, 'decisions index');

  const check = expectStatus(bin('corpus', ['check', '--root', fixture], repo), 0, 'corpus check');
  assert.match(check, /PASS decisions \(\d+ records? in docs\/decisions\)/);
  assert.match(check, /PASS links/);
  console.log(check);
  const decisions = expectStatus(bin('corpus', ['decisions', 'check', '--root', fixture], repo), 0, 'corpus decisions check');
  assert.match(decisions, /corpus decisions check passed/);
  console.log(decisions);
  const alias = expectStatus(bin('docs-kit', ['check', '--root', fixture], repo), 0, 'docs-kit check');
  assert.match(alias, /PASS decisions/);
  console.log(alias);

  // The installed gate rejects: a record with an unknown status fails (exit 1).
  const record = readdirSync(join(fixture, 'docs/decisions')).find((name) => name !== 'index.md');
  const recordFile = join(fixture, 'docs/decisions', record);
  writeFileSync(recordFile, readFileSync(recordFile, 'utf8').replace(/^status: .*$/m, 'status: accepted'));
  const rejected = expectStatus(bin('corpus', ['decisions', 'check', '--root', fixture], repo), 1, 'corpus decisions check on an invalid record');
  assert.match(rejected, /FAIL decisions/);
  assert.match(rejected, /unknown status 'accepted'/);

  // The installed CLI on this repository itself, as CI's dogfood step does from source.
  console.log(expectStatus(bin('corpus', ['check'], repo), 0, 'corpus check on this repository'));

  assert.equal(sha256(tarball), hash, 'the tarball changed during the consumer checks');
  if (artifacts) {
    mkdirSync(artifacts, { recursive: true });
    const destination = join(artifacts, basename(tarball));
    cpSync(tarball, destination);
    assert.equal(sha256(destination), hash, 'the exported tarball differs from the verified tarball');
    writeFileSync(join(artifacts, 'SHA256SUMS'), `${hash}  ${basename(tarball)}\n`);
  }
  console.log(JSON.stringify({ node: process.version, package: `${packed.name}@${packed.version}`, files: packed.files.length, sha256: hash, exported: artifacts !== null }));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
