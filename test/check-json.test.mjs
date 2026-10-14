import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { GATE_NAMES, STALE_KIND, runChecks } from '../src/check.mjs';
import { FIXTURES, commitAll, fixtureRepo, git, runCli, scratch } from './helpers.mjs';

/** `check --json`: stdout must be exactly one JSON object. */
async function checkJson(args) {
  const result = await runCli(['check', '--json', ...args]);
  let report;
  assert.doesNotThrow(() => (report = JSON.parse(result.stdout)), `stdout is not one JSON object:\n${result.output}`);
  return { ...result, report };
}

/** The `valid` fixture with one commit that changes a covered source and no document. */
function staleRepo(t) {
  const repo = fixtureRepo(t, 'valid');
  appendFileSync(path.join(repo, 'src', 'cli', 'main.js'), 'export const added = true;\n');
  commitAll(repo, 'change covered source only');
  return repo;
}

test('check --json labels each stale document with its kind and lists it as an action (exit 1)', async (t) => {
  const repo = staleRepo(t);
  const { status, stderr, report } = await checkJson(['--root', repo, '--base', 'HEAD~1', '--only', 'freshness']);
  assert.equal(status, 1, stderr);
  assert.equal(report.verdict, 'fail');
  assert.equal(report.exitCode, 1);
  assert.deepEqual(report.only, ['freshness']);
  assert.deepEqual(report.summary, { failures: 2, warnings: 0, errors: 0, staleDocuments: 2 });
  assert.deepEqual(
    report.gates.map(({ name, status: gateStatus }) => [name, gateStatus]),
    [
      ['manifest', 'pass'],
      ['freshness', 'fail'],
    ],
  );
  assert.deepEqual(report.staleDocuments, [
    { source: 'docs/getting-started.md', kind: 'docs-covers', gate: 'freshness', severity: 'failure', changed: ['src/cli/main.js'] },
    { source: 'docs/reference/cli.md', kind: 'docs-covers', gate: 'freshness', severity: 'failure', changed: ['src/cli/main.js'] },
  ]);
  assert.deepEqual(report.actions[0], {
    type: 'docs-covers',
    description: 'docs/getting-started.md is stale: 1 covered file changed since HEAD~1 but the document did not',
    paths: ['docs/getting-started.md', 'src/cli/main.js'],
  });
  assert.equal(report.actions.length, 2);
  // The kind is a published contract: pinned here as a literal, not read back from the constant.
  assert.equal(STALE_KIND.freshness, 'docs-covers');
});

test('check --json --advisory reports stale documents as warnings with verdict warn (exit 0)', async (t) => {
  const repo = staleRepo(t);
  const { status, report } = await checkJson(['--root', repo, '--base', 'HEAD~1', '--advisory']);
  assert.equal(status, 0);
  assert.equal(report.verdict, 'warn');
  assert.equal(report.summary.failures, 0);
  assert.equal(report.summary.warnings, 2);
  assert.deepEqual(
    report.staleDocuments.map(({ source, kind, severity }) => [source, kind, severity]),
    [
      ['docs/getting-started.md', 'docs-covers', 'warning'],
      ['docs/reference/cli.md', 'docs-covers', 'warning'],
    ],
  );
  assert.equal(report.gates.find((gate) => gate.name === 'freshness').status, 'warn');
});

test('check --json tells a broken link from a stale document, and passes a fresh repo', async (t) => {
  const broken = await checkJson(['--root', path.join(FIXTURES, 'broken-link')]);
  assert.equal(broken.status, 1);
  assert.equal(broken.report.verdict, 'fail');
  assert.equal(broken.report.gates.find((gate) => gate.name === 'links').status, 'fail');
  assert.deepEqual(broken.report.staleDocuments, []);
  assert.deepEqual(broken.report.actions, []);
  assert.equal(broken.report.summary.staleDocuments, 0);

  const repo = fixtureRepo(t, 'valid');
  appendFileSync(path.join(repo, 'src', 'cli', 'main.js'), 'export const added = true;\n');
  appendFileSync(path.join(repo, 'docs', 'getting-started.md'), '\nUpdated.\n');
  appendFileSync(path.join(repo, 'docs', 'reference', 'cli.md'), '\nUpdated.\n');
  commitAll(repo, 'source and docs together');
  const fresh = await checkJson(['--root', repo, '--base', 'HEAD~1']);
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.equal(fresh.report.verdict, 'pass');
  assert.deepEqual(fresh.report.staleDocuments, []);
  // builtOn skips: the fixture has no package.json.
  assert.ok(fresh.report.gates.every((gate) => gate.status === (gate.name === 'builtOn' ? 'skip' : 'pass')), JSON.stringify(fresh.report.gates));
  assert.equal(fresh.report.gates.find((gate) => gate.name === 'freshness').note, '3 changed files since HEAD~1');
});

test('check --only runs only the selected gates', async () => {
  const root = path.join(FIXTURES, 'broken-link');
  const links = await runCli(['check', '--root', root, '--only', 'links']);
  assert.equal(links.status, 1, links.output);
  assert.match(links.stderr, /FAIL links/);
  assert.doesNotMatch(links.output, /reachability|topics|purpose/);

  const topics = await runCli(['check', '--root', root, '--only', 'topics, purpose']);
  assert.equal(topics.status, 0, topics.output);
  assert.match(topics.stdout, /PASS manifest\n {2}PASS purpose\n {2}PASS topics\n/);
  assert.doesNotMatch(topics.stdout, /links/);
});

test('check --only refuses an unknown gate or a gate that cannot run, in text and JSON (exit 2)', async (t) => {
  const root = path.join(FIXTURES, 'valid');
  const unknown = await runCli(['check', '--root', root, '--only', 'links,bogus']);
  assert.equal(unknown.status, 2, unknown.output);
  assert.match(unknown.stderr, /--only: unknown gate "bogus"; gates are manifest, purpose, builtOn, links, reachability, topics, redirects, paths, covers, decisions, adr-freeze, freshness/);

  const empty = await runCli(['check', '--root', root, '--only', ' , ']);
  assert.equal(empty.status, 2, empty.output);
  assert.match(empty.stderr, /--only needs at least one gate name/);

  // Asking for freshness without --base would check nothing; it must not pass.
  const noBase = await checkJson(['--root', root, '--only', 'freshness']);
  assert.equal(noBase.status, 2, noBase.output);
  assert.deepEqual(noBase.report, {
    schemaVersion: 1,
    tool: 'corpus',
    command: 'check',
    verdict: 'fail',
    exitCode: 2,
    base: null,
    advisory: false,
    only: ['freshness'],
    error: '--only freshness: the gate did not run (pass --base <git-ref>)',
  });
  assert.match(noBase.stderr, /--only freshness: the gate did not run/);

  const noDecisions = await runCli(['check', '--root', root, '--only', 'decisions']);
  assert.equal(noDecisions.status, 2, noDecisions.output);
  assert.match(noDecisions.stderr, /--only decisions: the gate did not run \(the manifest declares no "decisions" block\)/);

  const noAdrBase = await runCli(['check', '--root', registryRepo(t), '--only', 'adr-freeze']);
  assert.equal(noAdrBase.status, 2, noAdrBase.output);
  assert.match(noAdrBase.stderr, /--only adr-freeze: the gate did not run \(pass --base <git-ref> to refuse ADRs added under docs\/adr\)/);

  const missingManifest = await checkJson(['--root', scratch(t), '--only', 'links']);
  assert.equal(missingManifest.status, 2);
  assert.equal(missingManifest.report.verdict, 'fail');
  assert.match(missingManifest.report.error, /no corpus\.json/);
});

/** A repository with a decision registry and a frozen ADR directory, indexed and committed. */
function registryRepo(t) {
  const repo = path.join(scratch(t), 'registry');
  mkdirSync(path.join(repo, 'docs', 'decisions'), { recursive: true });
  mkdirSync(path.join(repo, 'docs', 'adr'), { recursive: true });
  writeFileSync(path.join(repo, 'README.md'), '# Registry\n');
  writeFileSync(
    path.join(repo, 'corpus.json'),
    `${JSON.stringify({ schemaVersion: 2, product: 'registry', title: 'Registry', repo: 'kontourai/registry', purpose: 'Record decisions.', builtOn: [], documents: [], exclude: ['docs/**'], decisions: { adr: { dir: 'docs/adr' } } }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(repo, 'docs', 'decisions', 'example-subject.md'),
    '---\nstatus: current\nsubject: Example subject\ndecided: 2026-07-03\nevidence:\n  - kind: issue\n    ref: https://github.com/kontourai/corpus/issues/1\n---\n\n# Example subject\n\nThe current answer.\n',
  );
  writeFileSync(path.join(repo, 'docs', 'adr', '0001-first.md'), '# 1. First\n');
  git(repo, ['init', '-q']);
  commitAll(repo, 'registry');
  return repo;
}

test('check --only keeps decisions and adr-freeze apart, and every gate check reports is selectable', async (t) => {
  const repo = registryRepo(t);
  const index = await runCli(['decisions', 'index', '--root', repo]);
  assert.equal(index.status, 0, index.output);
  const base = commitAll(repo, 'index');
  writeFileSync(path.join(repo, 'docs', 'adr', '0002-second.md'), '# 2. Second\n');
  commitAll(repo, 'add an ADR');

  // The freeze fails, but only decisions was asked for: its failure must not leak into the exit code.
  const decisionsOnly = await checkJson(['--root', repo, '--base', base, '--only', 'decisions']);
  assert.equal(decisionsOnly.status, 0, decisionsOnly.output);
  assert.deepEqual(decisionsOnly.report.gates.map((gate) => gate.name), ['manifest', 'decisions']);

  const freezeOnly = await checkJson(['--root', repo, '--base', base, '--only', 'adr-freeze']);
  assert.equal(freezeOnly.status, 1, freezeOnly.output);
  assert.deepEqual(
    freezeOnly.report.gates.map(({ name, status }) => [name, status]),
    [
      ['manifest', 'pass'],
      ['adr-freeze', 'fail'],
    ],
  );

  // A full run with a registry, a freeze, and --base reports every gate check has; each must be a valid --only name.
  const full = runChecks({ root: repo, base });
  assert.deepEqual(full.gates.map((gate) => gate.name).sort(), [...GATE_NAMES].sort());
  assert.deepEqual(GATE_NAMES, ['manifest', 'purpose', 'builtOn', 'links', 'reachability', 'topics', 'redirects', 'paths', 'covers', 'decisions', 'adr-freeze', 'freshness']);
});
