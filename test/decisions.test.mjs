import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { DECISION_STATUSES, EVIDENCE_KEYS, EVIDENCE_KINDS, RECORD_KEYS, SECRET_PATTERNS, parseDecisionRecord, validateDecisionRecord } from '../src/decisions.mjs';
import { FIXTURES, REPO_ROOT, commitAll, git, runCli, scratch } from './helpers.mjs';

const RECORD_SETS = path.join(FIXTURES, 'decision-records');
const SOURCES = JSON.parse(readFileSync(path.join(RECORD_SETS, 'sources.json'), 'utf8')).sources;

const VALID = `---
status: current
subject: Example subject
decided: 2026-07-03
evidence:
  - kind: issue
    ref: https://github.com/kontourai/corpus/issues/1
---

# Example subject

The current answer.
`;

/**
 * A v2 repository whose docs are excluded, so only the decisions gates can
 * fail. `records` maps a slug to file text under `dir` (default docs/decisions).
 */
function registryRepo(t, { records = { 'example-subject': VALID }, decisions = {}, files = {}, git: inGit = true } = {}) {
  const repo = path.join(scratch(t), 'repo');
  const dir = decisions.dir ?? 'docs/decisions';
  mkdirSync(repo, { recursive: true });
  if (Object.keys(records).length > 0) mkdirSync(path.join(repo, ...dir.split('/')), { recursive: true });
  writeFileSync(path.join(repo, 'README.md'), '# Registry\n');
  writeFileSync(
    path.join(repo, 'corpus.json'),
    `${JSON.stringify({ schemaVersion: 2, product: 'registry', title: 'Registry', repo: 'kontourai/registry', purpose: 'Record decisions.', builtOn: [], documents: [], exclude: ['docs/**'], decisions }, null, 2)}\n`,
  );
  for (const [slug, text] of Object.entries(records)) writeFileSync(path.join(repo, ...dir.split('/'), `${slug}.md`), text);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), text);
  }
  if (inGit) {
    git(repo, ['init', '-q']);
    commitAll(repo, 'registry');
  }
  return repo;
}

async function indexed(repo) {
  const result = await runCli(['decisions', 'index', '--root', repo]);
  assert.equal(result.status, 0, result.output);
  return result;
}

async function checkFails(repo, pattern, args = []) {
  const result = await runCli(['decisions', 'check', '--root', repo, ...args]);
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /FAIL decisions/);
  assert.match(result.stderr, pattern);
  return result;
}

const withStatus = (status) => VALID.replace('status: current', `status: ${status}`);

// --- Cases ported from the registry's original evals/static/test_decisions.sh ---

test('a valid record with a fresh index passes', async (t) => {
  const repo = registryRepo(t);
  await indexed(repo);
  const result = await runCli(['decisions', 'check', '--root', repo]);
  assert.equal(result.status, 0, result.output);
  assert.match(result.stdout, /PASS decisions \(1 record in docs\/decisions\)/);
  assert.match(result.stdout, /corpus decisions check passed/);
});

test('an unknown status (accepted) fails', async (t) => {
  const repo = registryRepo(t, { records: { 'example-subject': withStatus('accepted') } });
  await indexed(repo);
  await checkFails(repo, /docs\/decisions\/example-subject\.md: unknown status 'accepted' \(allowed: current, superseded, merged, needs-decision\)/);
});

test('a missing subject fails', async (t) => {
  const repo = registryRepo(t, { records: { 'example-subject': VALID.replace(/^subject:.*\n/m, '') } });
  await indexed(repo);
  await checkFails(repo, /example-subject\.md: missing required field: subject \(non-empty\)/);
});

test('secret-shaped evidence refs fail', async (t) => {
  // Assembled at runtime so no credential-shaped literal is committed.
  const awsKey = `AKIA${'IOSFODNN7EXAMPLE'}`;
  const githubToken = `ghp_${'x'.repeat(36)}`;
  const repo = registryRepo(t, {
    records: {
      aws: VALID.replace('ref: https://github.com/kontourai/corpus/issues/1', `ref: "https://example.com/?key=${awsKey}"`),
      token: VALID.replace('ref: https://github.com/kontourai/corpus/issues/1', `ref: ${githubToken}`),
    },
  });
  await indexed(repo);
  const result = await checkFails(repo, /aws\.md: evidence\[0\]\.ref contains a secret-shaped literal \(aws access key id\)/);
  assert.match(result.stderr, /token\.md: evidence\[0\]\.ref contains a secret-shaped literal \(github token\)/);
});

test('a tombstone pointing at a missing slug fails', async (t) => {
  const repo = registryRepo(t, { records: { 'old-topic': withStatus('superseded').replace('decided:', 'superseded_by: does-not-exist\ndecided:') } });
  await indexed(repo);
  await checkFails(repo, /old-topic\.md: superseded_by points at missing topic slug 'does-not-exist' \(no docs\/decisions\/does-not-exist\.md\)/);
});

test('index generation is idempotent and writes nothing but the index', async (t) => {
  const repo = registryRepo(t);
  await indexed(repo);
  const first = readFileSync(path.join(repo, 'docs/decisions/index.md'), 'utf8');
  await indexed(repo);
  assert.equal(readFileSync(path.join(repo, 'docs/decisions/index.md'), 'utf8'), first);
  assert.equal(git(repo, ['status', '--porcelain', '--untracked-files=all']), '?? docs/decisions/index.md');
});

test('a stale index fails', async (t) => {
  const repo = registryRepo(t);
  await indexed(repo);
  writeFileSync(path.join(repo, 'docs/decisions/index.md'), `${readFileSync(path.join(repo, 'docs/decisions/index.md'), 'utf8')}\nstale line\n`);
  await checkFails(repo, /docs\/decisions\/index\.md is stale; run `corpus decisions index`/);
});

// --- Further rejections ---

test('missing evidence fails', async (t) => {
  const repo = registryRepo(t, { records: { 'example-subject': VALID.replace(/^evidence:\n.*\n.*\n/m, '') } });
  await indexed(repo);
  await checkFails(repo, /example-subject\.md: missing required field: evidence\[\]/);
});

test('superseded without superseded_by fails', async (t) => {
  const repo = registryRepo(t, { records: { 'old-topic': withStatus('superseded') } });
  await indexed(repo);
  await checkFails(repo, /old-topic\.md: status 'superseded' requires superseded_by/);
});

test('an unknown frontmatter key fails, at the top level and in evidence', async (t) => {
  const repo = registryRepo(t, {
    records: {
      'example-subject': VALID.replace('decided:', 'owner: someone\ndecided:').replace('    ref: https', '    note: context\n    ref: https'),
    },
  });
  await indexed(repo);
  const result = await checkFails(repo, /example-subject\.md: unknown frontmatter key 'owner' \(allowed: status, subject, decided, evidence, supersedes, superseded_by, merged_into\)/);
  assert.match(result.stderr, /example-subject\.md: evidence\[0\]: unknown key 'note' \(allowed: kind, ref\)/);
});

test('a missing index fails', async (t) => {
  const repo = registryRepo(t);
  await checkFails(repo, /docs\/decisions\/index\.md is missing; run `corpus decisions index`/);
});

test('a record that supersedes itself fails', async (t) => {
  const repo = registryRepo(t, { records: { 'old-topic': withStatus('superseded').replace('decided:', 'superseded_by: old-topic\ndecided:') } });
  await indexed(repo);
  await checkFails(repo, /old-topic\.md: superseded_by must not point at its own slug/);
});

test('duplicate keys and frontmatter after byte 0 fail', async (t) => {
  const repo = registryRepo(t, { records: { twice: VALID.replace('status: current', 'status: current\nstatus: merged'), late: `\n${VALID}` } });
  await indexed(repo);
  const result = await checkFails(repo, /twice\.md: frontmatter is not valid YAML: Map keys must be unique/);
  assert.match(result.stderr, /late\.md: file must begin with a YAML frontmatter block delimited by '---' \(at byte 0\)/);
});

test('every invalid record is reported, not only the first', async (t) => {
  const repo = registryRepo(t, { records: { a: withStatus('accepted'), b: withStatus('proposed'), 'example-subject': VALID } });
  await indexed(repo);
  const result = await checkFails(repo, /a\.md: unknown status 'accepted'/);
  assert.match(result.stderr, /b\.md: unknown status 'proposed'/);
  assert.match(result.stderr, /corpus decisions check failed: 2 failures/);
});

// --- The real record sets ---

test('all 97 records from the seven registries pass, and the index differs only in its header', async (t) => {
  let total = 0;
  for (const [name, source] of Object.entries(SOURCES)) {
    const records = Object.fromEntries(
      readdirSync(path.join(RECORD_SETS, name))
        .filter((file) => file.endsWith('.md') && file !== 'index.md')
        .map((file) => [file.slice(0, -3), readFileSync(path.join(RECORD_SETS, name, file), 'utf8')]),
    );
    assert.equal(Object.keys(records).length, source.records, name);
    total += source.records;
    const repo = registryRepo(t, { records, decisions: { adr: {} }, files: { 'docs/adr/0001-frozen.md': '# Frozen\n' } });
    await indexed(repo);
    const result = await runCli(['decisions', 'check', '--root', repo]);
    assert.equal(result.status, 0, `${name}\n${result.output}`);
    assert.match(result.stdout, new RegExp(`PASS decisions \\(${source.records} records in docs/decisions\\)`));

    const theirs = readFileSync(path.join(RECORD_SETS, name, 'index.md'), 'utf8').split('\n');
    const ours = readFileSync(path.join(repo, 'docs/decisions/index.md'), 'utf8').split('\n');
    assert.equal(ours.length, theirs.length, name);
    const differing = ours.flatMap((line, index) => (line === theirs[index] ? [] : [index + 1]));
    // Lines 7 and 8 name the generator and the format document; every row and the ADR line match.
    assert.deepEqual(differing, [7, 8], name);
  }
  assert.equal(total, 97);
});

// --- The ADR freeze ---

function adrRepo(t) {
  const repo = registryRepo(t, { decisions: { adr: { dir: 'docs/adr' } }, files: { 'docs/adr/0001-first.md': '# 1. First\n\nStatus: accepted\n' } });
  return repo;
}

async function indexedAndCommitted(repo) {
  await indexed(repo);
  return commitAll(repo, 'index');
}

test('an ADR added since --base fails and points to the registry', async (t) => {
  const repo = adrRepo(t);
  const base = await indexedAndCommitted(repo);
  writeFileSync(path.join(repo, 'docs/adr/0002-second.md'), '# 2. Second\n');
  commitAll(repo, 'add an ADR');
  const result = await runCli(['decisions', 'check', '--root', repo, '--base', base]);
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /PASS decisions/);
  assert.match(result.stderr, /FAIL adr-freeze/);
  assert.match(
    result.stderr,
    /docs\/adr\/0002-second\.md was added since [0-9a-f]{40}, but numbered ADRs under docs\/adr\/ are frozen history; record the decision as docs\/decisions\/<topic-slug>\.md instead \(see https:\/\/github\.com\/kontourai\/corpus\/blob\/main\/docs\/decisions\.md#numbered-adrs\)/,
  );
  // The full check runs the same gate.
  const full = await runCli(['check', '--root', repo, '--base', base]);
  assert.equal(full.status, 1, full.output);
  assert.match(full.stderr, /FAIL adr-freeze/);
});

test('editing or deleting an existing ADR passes the freeze', async (t) => {
  const repo = adrRepo(t);
  writeFileSync(path.join(repo, 'docs/adr/0003-third.md'), '# 3. Third\n');
  const base = await indexedAndCommitted(repo);
  writeFileSync(path.join(repo, 'docs/adr/0001-first.md'), '# 1. First\n\nStatus: accepted (typo fixed)\n');
  git(repo, ['rm', '-q', 'docs/adr/0003-third.md']);
  commitAll(repo, 'edit and delete');
  const result = await runCli(['decisions', 'check', '--root', repo, '--base', base]);
  assert.equal(result.status, 0, result.output);
  assert.match(result.stdout, /PASS adr-freeze \(docs\/adr against [0-9a-f]{40}\)/);
});

test('renaming an ADR inside the frozen directory counts as adding one', async (t) => {
  const repo = adrRepo(t);
  const base = await indexedAndCommitted(repo);
  renameSync(path.join(repo, 'docs/adr/0001-first.md'), path.join(repo, 'docs/adr/0001-renamed.md'));
  commitAll(repo, 'rename');
  const result = await runCli(['decisions', 'check', '--root', repo, '--base', base]);
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /docs\/adr\/0001-renamed\.md was added since/);
});

test('without --base the freeze is skipped with a note', async (t) => {
  const repo = adrRepo(t);
  await indexedAndCommitted(repo);
  writeFileSync(path.join(repo, 'docs/adr/0002-second.md'), '# 2. Second\n');
  commitAll(repo, 'add an ADR');
  for (const args of [['decisions', 'check'], ['check']]) {
    const result = await runCli([...args, '--root', repo]);
    assert.equal(result.status, 0, result.output);
    assert.match(result.stdout, /SKIP adr-freeze \(pass --base <git-ref> to refuse ADRs added under docs\/adr\)/);
  }
});

test('a --base that does not resolve is a configuration error (exit 2)', async (t) => {
  const repo = adrRepo(t);
  await indexedAndCommitted(repo);
  const result = await runCli(['decisions', 'check', '--root', repo, '--base', 'no-such-ref']);
  assert.equal(result.status, 2, result.output);
  assert.match(result.stderr, /ERROR adr-freeze/);
  assert.match(result.stderr, /--base no-such-ref does not resolve to a commit/);
});

test('ADR content is never validated as a decision record', async (t) => {
  const repo = adrRepo(t);
  await indexed(repo);
  const result = await runCli(['decisions', 'check', '--root', repo]);
  assert.equal(result.status, 0, result.output);
  assert.match(result.stdout, /PASS decisions \(1 record in docs\/decisions\)/);
});

// --- Inactive gate and integration with check and build ---

test('without a decisions block, check is unchanged even with invalid records', async (t) => {
  const repo = registryRepo(t, { records: { broken: withStatus('accepted') } });
  const manifest = JSON.parse(readFileSync(path.join(repo, 'corpus.json'), 'utf8'));
  delete manifest.decisions;
  writeFileSync(path.join(repo, 'corpus.json'), JSON.stringify(manifest));
  const result = await runCli(['check', '--root', repo]);
  assert.equal(result.status, 0, result.output);
  assert.doesNotMatch(result.output, /^  (PASS|FAIL|SKIP|ERROR) (decisions|adr-freeze)/m);
  const alone = await runCli(['decisions', 'check', '--root', repo]);
  assert.equal(alone.status, 2, alone.output);
  assert.match(alone.stderr, /corpus\.json has no "decisions" block; add "decisions": \{\} \(schemaVersion 2\) to enable the decisions gate/);
  const write = await runCli(['decisions', 'index', '--root', repo]);
  assert.equal(write.status, 2, write.output);
  assert.equal(existsSync(path.join(repo, 'docs/decisions/index.md')), false);
});

test('the existing valid fixture reports no decisions gate', async () => {
  const result = await runCli(['check', '--root', path.join(FIXTURES, 'valid')]);
  assert.equal(result.status, 0, result.output);
  assert.doesNotMatch(result.output, /^  (PASS|FAIL|SKIP|ERROR) (decisions|adr-freeze)/m);
});

test('check fails on an invalid record when the block is declared', async (t) => {
  const repo = registryRepo(t, { records: { broken: withStatus('accepted') } });
  await indexed(repo);
  const result = await runCli(['check', '--root', repo]);
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /FAIL decisions/);
  assert.match(result.stderr, /broken\.md: unknown status 'accepted'/);
  assert.match(result.stderr, /PASS links/);
});

test('the gate reads the directory even when documents and exclude never list it', async (t) => {
  // registryRepo excludes docs/**, so the records are invisible to every other gate.
  const repo = registryRepo(t, { records: { broken: VALID.replace(/^decided:.*\n/m, 'decided: soon\n') } });
  await indexed(repo);
  await checkFails(repo, /broken\.md: decided must be an ISO date \(YYYY-MM-DD\); got 'soon'/);
});

test('build refuses an invalid registry', async (t) => {
  const repo = registryRepo(t, { records: { broken: withStatus('accepted') } });
  await indexed(repo);
  commitAll(repo, 'index');
  const result = await runCli(['build', '--root', repo, '--out', path.join(scratch(t), 'site')]);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /FAIL decisions/);
  assert.doesNotMatch(result.output, /adr-freeze/);
});

// --- Manifest validation ---

test('the decisions block is validated strictly (exit 2)', async (t) => {
  const cases = [
    [{ policy: 'frozen' }, /corpus\.json: decisions: unknown key "policy" \(allowed: dir, index, adr\)/],
    [{ dir: '../decisions' }, /decisions\.dir must not contain "\.\."/],
    [{ dir: '/abs' }, /decisions\.dir must be relative to the repository root, not absolute/],
    [{ index: 'docs/index.md' }, /decisions\.index "docs\/index\.md" must be directly inside decisions\.dir "docs\/decisions"/],
    [{ index: 'docs/decisions/index.txt' }, /decisions\.index must be a \.md file/],
    [{ adr: { dir: 'docs/adrs' } }, /decisions\.adr\.dir "docs\/adrs" is not an existing directory inside the repository/],
    [{ adr: { dir: 'docs/decisions' } }, /decisions\.adr\.dir "docs\/decisions" must not overlap decisions\.dir "docs\/decisions"/],
    [{ adr: { dir: 'docs/adr', policy: 'frozen' } }, /decisions\.adr: unknown key "policy" \(allowed: dir\)/],
    [{ dir: 'README.md' }, /decisions\.dir "README\.md" is not a directory inside the repository/],
    [[], /decisions must be an object/],
    [{ dir: 5, adr: {} }, /decisions\.dir must be a non-empty string/],
    [{ adr: { dir: 'docs' } }, /decisions\.adr\.dir "docs" must not overlap decisions\.dir "docs\/decisions"/],
  ];
  for (const [decisions, pattern] of cases) {
    const repo = registryRepo(t, { records: {}, decisions, git: false });
    const result = await runCli(['decisions', 'check', '--root', repo]);
    assert.equal(result.status, 2, `${JSON.stringify(decisions)}\n${result.output}`);
    assert.match(result.stderr, pattern);
    const full = await runCli(['check', '--root', repo]);
    assert.equal(full.status, 2, full.output);
    assert.match(full.stderr, pattern);
  }
});

test('a decisions dir that is a symlink out of the repository is refused (exit 2)', async (t) => {
  const outside = scratch(t);
  const repo = registryRepo(t, { records: {}, decisions: { dir: 'records' }, git: false });
  mkdirSync(path.join(outside, 'moved'));
  symlinkSync(path.join(outside, 'moved'), path.join(repo, 'records'));
  const result = await runCli(['decisions', 'check', '--root', repo]);
  assert.equal(result.status, 2, result.output);
  assert.match(result.stderr, /decisions\.dir "records" is not a directory inside the repository/);
});

test('index defaults to <dir>/index.md and is created with the directory', async (t) => {
  const repo = registryRepo(t, { records: {}, decisions: { dir: 'records' }, git: false });
  const result = await indexed(repo);
  assert.match(result.stdout, /wrote records\/index\.md \(0 topics\)/);
  const check = await runCli(['decisions', 'check', '--root', repo]);
  assert.equal(check.status, 0, check.output);
  assert.match(check.stdout, /PASS decisions \(0 records in records\)/);
});

test('decisions index refuses to write through a symlinked index (exit 2)', async (t) => {
  const outside = path.join(scratch(t), 'outside.md');
  writeFileSync(outside, 'keep me\n');
  const repo = registryRepo(t, { git: false });
  symlinkSync(outside, path.join(repo, 'docs/decisions/index.md'));
  const result = await runCli(['decisions', 'index', '--root', repo]);
  assert.equal(result.status, 2, result.output);
  assert.match(result.stderr, /refusing to write docs\/decisions\/index\.md: docs\/decisions\/index\.md is a symlink/);
  assert.equal(readFileSync(outside, 'utf8'), 'keep me\n');
});

test('decisions index reports invalid records but still writes the index', async (t) => {
  const repo = registryRepo(t, { records: { broken: withStatus('accepted') }, git: false });
  const result = await indexed(repo);
  assert.match(result.stdout, /note: 1 record has errors; run corpus decisions check/);
  assert.match(readFileSync(path.join(repo, 'docs/decisions/index.md'), 'utf8'), /\| \[broken\]\(\.\/broken\.md\) \| accepted \| Example subject \|/);
});

test('decisions usage errors exit 2', async () => {
  for (const [args, pattern] of [
    [['decisions'], /decisions needs a subcommand: check or index/],
    [['decisions', 'lint'], /decisions needs a subcommand: check or index \(got "lint"\)/],
    [['decisions', 'check', '--advisory'], /decisions check: Unknown option '--advisory'/],
    [['decisions', 'index', '--base', 'main'], /decisions index: Unknown option '--base'/],
  ]) {
    const result = await runCli(args);
    assert.equal(result.status, 2, result.output);
    assert.match(result.stderr, pattern);
  }
});

// --- Conformance vectors and the published schema ---

const vectorFile = JSON.parse(readFileSync(path.join(REPO_ROOT, 'packages/conformance/decision-records.json'), 'utf8'));

test('the implementation meets every decision-record conformance vector', () => {
  assert.ok(vectorFile.vectors.length >= 40);
  const ruleCodes = new Set(vectorFile.rules);
  const seen = new Set();
  for (const vector of vectorFile.vectors) {
    const known = new Set(vector.records.map((record) => record.slug));
    for (const record of vector.records) {
      const parsed = parseDecisionRecord(record.markdown);
      assert.deepEqual(parsed.frontmatter, record.frontmatter, `${vector.id}/${record.slug} frontmatter`);
      const errors = [...parsed.errors, ...(parsed.frontmatter ? validateDecisionRecord(record.slug, parsed.frontmatter, known) : [])];
      const rules = [...new Set(errors.map((error) => error.rule))].sort();
      assert.deepEqual(rules, record.expected, `${vector.id}/${record.slug}: ${errors.map((error) => error.message).join('; ')}`);
      for (const rule of rules) {
        assert.ok(ruleCodes.has(rule), `${rule} is listed in rules`);
        seen.add(rule);
      }
    }
  }
  // Every rule code has at least one rejecting vector.
  assert.deepEqual([...seen].sort(), [...ruleCodes].sort());
});

test('the published schema states the rules the checker enforces', () => {
  const schema = JSON.parse(readFileSync(path.join(REPO_ROOT, 'schemas/decision-record.schema.json'), 'utf8'));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties).sort(), [...RECORD_KEYS].sort());
  assert.deepEqual(schema.required, ['status', 'subject', 'decided', 'evidence']);
  assert.deepEqual(schema.properties.status.enum, DECISION_STATUSES);
  assert.deepEqual(DECISION_STATUSES, ['current', 'superseded', 'merged', 'needs-decision']);
  const item = schema.properties.evidence.items;
  assert.equal(item.additionalProperties, false);
  assert.deepEqual(Object.keys(item.properties).sort(), [...EVIDENCE_KEYS].sort());
  assert.deepEqual(item.properties.kind.enum, EVIDENCE_KINDS);
  // The schema's secret pattern refuses a sample of each detector and accepts ordinary refs.
  const schemaSecret = new RegExp(item.properties.ref.not.pattern, 'u');
  const samples = {
    'aws access key id': `AKIA${'A'.repeat(16)}`,
    'aws sts key id': `ASIA${'B'.repeat(16)}`,
    'github token': `ghs_${'c'.repeat(36)}`,
    'private key block': `-----BEGIN ${'RSA'} PRIVATE KEY-----`,
    jwt: `eyJ${'a'.repeat(10)}.eyJ${'b'.repeat(10)}.${'c'.repeat(10)}`,
    'generic secret literal': `API_KEY = "${'d'.repeat(8)}"`,
  };
  assert.deepEqual(Object.keys(samples).sort(), SECRET_PATTERNS.map(({ label }) => label).sort());
  for (const [label, sample] of Object.entries(samples)) {
    assert.ok(schemaSecret.test(sample), `schema refuses ${label}`);
    assert.equal(SECRET_PATTERNS.find(({ re }) => re.test(sample))?.label, label, `checker refuses ${label}`);
  }
  for (const ref of ['#310', 'https://github.com/kontourai/corpus/pull/12', 'docs/adr/0001-x.md', 'token rotation runbook'])
    assert.equal(schemaSecret.test(ref), false, ref);
});

test('the package ships the schema', () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('schemas/'));
  assert.equal(pkg.exports['./schemas/decision-record.schema.json'], './schemas/decision-record.schema.json');
  const conformance = JSON.parse(readFileSync(path.join(REPO_ROOT, 'packages/conformance/package.json'), 'utf8'));
  assert.ok(conformance.files.includes('decision-records.json'));
  assert.equal(conformance.exports['./decision-records'], './decision-records.json');
});
