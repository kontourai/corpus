// Fault injection for create proposals. Each injection weakens one rule, rebuilds, and
// requires the targeted vitest case AND the targeted conformance vectors to fail for the
// intended reason; the restored tree must pass again. Needs a clean, committed tree.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(packageRoot, '../..');
const output = resolve(process.argv[2] ?? '/tmp/corpus-store-proposal-faults');
mkdirSync(output, { recursive: true });
const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' }).stdout.trim();
assert.equal(git('status', '--porcelain'), '', 'Commit and confirm a clean tree before fault injection');
const revision = git('rev-parse', 'HEAD');

function run(label, args, success) {
  const result = spawnSync('npm', args, { cwd: repo, encoding: 'utf8', timeout: 300_000 });
  const log = (result.stdout ?? '') + (result.stderr ?? '');
  writeFileSync(join(output, `${label}.log`), log);
  assert.equal(result.error, undefined, `Execution error for ${label}`);
  if (success) assert.equal(result.status, 0, log);
  else assert.notEqual(result.status, 0, `${label} must fail`);
  console.log(`${label}: exit ${result.status}`);
  return { exit: result.status, log };
}
const build = ['run', 'build', '--workspace=@kontourai/corpus-store'];
const unit = (pattern) => ['run', 'test', '--workspace=@kontourai/corpus-store', '--', 'test/create-proposals.test.ts', '-t', pattern];
const vaultUnit = (pattern) => ['run', 'test', '--workspace=@kontourai/corpus-store', '--', 'test/vault-note-bound.test.ts', '-t', pattern];
const vectors = (...ids) => ['run', 'conformance', '--workspace=@kontourai/corpus-store', '--', ...ids];

/** Replace `from` with `to` in `source`, failing loudly when the anchor has drifted. */
function swap(source, from, to) {
  assert.ok(source.includes(from), `injection anchor not found: ${from.slice(0, 60)}`);
  return source.replace(from, to);
}
/** A proposeCreate that also creates the record: a pending proposal leaks into the working set. */
const leak = (readRecord) => (source) => {
  const start = source.indexOf('  async proposeCreate(');
  const end = source.indexOf('  async applyCreate(');
  assert.ok(start > 0 && end > start, 'proposeCreate anchor not found');
  return `${source.slice(0, start)}  async proposeCreate(candidate: CreateInput, proposerId: string, evidence: ProposeEvidence): Promise<string> {
    return ${readRecord.mutate}('proposeCreate', () => {
      const id = this.proposals.stage(candidate, proposerId, evidence, (rid) => ${readRecord.exists});
      this.createLocked(candidate); // injected: the proposal is also an active record
      return id;
    });
  }

${source.slice(end)}`;
};

const injections = [
  {
    name: 'request-key-whitespace',
    files: [{ file: 'src/shared/create-proposals.ts', mutate: (s) => swap(s, '!key.trim()', 'false') }],
    checks: [
      { label: 'unit', args: unit('request key limits'), failure: /MISSING_EVIDENCE/ },
      { label: 'vector', args: vectors('create-request-key-limits'), failure: /proposeCreate must reject/ },
    ],
  },
  {
    name: 'request-key-utf8-bytes',
    files: [{ file: 'src/shared/create-proposals.ts', mutate: (s) => swap(s, 'Buffer.byteLength(key) > 1024', 'key.length > 1024') }],
    checks: [
      { label: 'unit', args: unit('request key limits'), failure: /MISSING_EVIDENCE/ },
      { label: 'vector', args: vectors('create-request-key-limits'), failure: /proposeCreate must reject/ },
    ],
  },
  {
    name: 'request-key-version',
    files: [{ file: 'src/shared/create-proposals.ts', mutate: (s) => swap(s, "  if (value.request_key_hash !== undefined && value.request_digest_version !== 1) throw corrupt('missing or unsupported request digest version');\n", '') }],
    checks: [{ label: 'unit', args: unit('keyed requests fail closed'), failure: /promise resolved/ }],
  },
  {
    name: 'request-key-vault-bound',
    files: [{ file: 'src/obsidian-store.ts', mutate: (s) => swap(s, '(validated, origin) => this.assertCandidateFits(validated, origin),', '(validated, origin) => { if (!options?.requestKey) this.assertCandidateFits(validated, origin); },') }],
    checks: [{ label: 'unit', args: vaultUnit('keyed proposals enforce'), failure: /expected undefined to match object/ }],
  },
  {
    name: 'request-key-proposal-bound',
    files: [{ file: 'src/shared/create-proposals.ts', mutate: (s) => swap(s, 'if (Buffer.byteLength(text) > maxBytes) {', "if (Buffer.byteLength(`${JSON.stringify({ ...proposal, request_key_hash: undefined, request_digest: undefined, request_digest_version: undefined }, null, 2)}\\n`) > maxBytes) {") }],
    checks: [{ label: 'unit', args: unit('request key metadata counts toward'), failure: /expected undefined to match object/ }],
  },
  {
    name: 'request-key-conflict-write',
    files: [{ file: 'src/shared/create-proposals.ts', mutate: (s) => swap(swap(s, "import { join } from 'node:path';", "import { appendFileSync } from 'node:fs';\nimport { join } from 'node:path';"), 'if (metadata.request_digest !== requestDigest) throw new RequestKeyConflictError();', "if (metadata.request_digest !== requestDigest) { appendFileSync(this.pathOf(existing.id), ' '); throw new RequestKeyConflictError(); }") }],
    checks: [{ label: 'unit', args: unit('request key retries'), failure: /to deeply equal/ }],
  },
  {
    name: 'request-key-retry-duplicates',
    files: [{ file: 'src/shared/create-proposals.ts', mutate: (s) => swap(s, '          return existing.id;', '          continue;') }],
    checks: [
      { label: 'unit', args: unit('request key retries'), failure: /to be 'generated-/ },
      { label: 'vector', args: vectors('create-request-key-retry'), failure: /create-request-key-retry/ },
    ],
  },
  {
    name: 'request-key-ignore-corruption',
    files: [{ file: 'src/shared/create-proposals.ts', mutate: (s) => swap(s, "      const proposal = this.get(name.slice(0, -'.json'.length));", "      let proposal: KitCreateProposal | null; try { proposal = this.get(name.slice(0, -'.json'.length)); } catch { continue; }") }],
    checks: [{ label: 'unit', args: unit('keyed requests fail closed'), failure: /promise resolved|expected.*reject/ }],
  },
  {
    name: 'request-key-skip-recovery',
    files: [{ file: 'src/shared/file-transactions.ts', mutate: (s) => swap(s, '    if (!journal) return;\n    if (journal.phase', '    if (!journal) return;\n    if (journal.operation === "proposeCreate") return; // injected: no recovery\n    if (journal.phase') }],
    checks: [{ label: 'unit', args: unit('keyed proposal recovers'), failure: /expected.*(false|crash-2)|to be false|deeply equal/ }],
  },
  {
    name: 'self-approval',
    files: [{
      file: 'src/shared/create-proposals.ts',
      mutate: (s) => swap(s, "if (op === 'applyCreate' && proposal.proposer_id === reviewerId) {", "if (op === 'applyCreate' && proposal.proposer_id === reviewerId && false) {"),
    }],
    checks: [
      { label: 'unit', args: unit('apply refuses the proposer'), failure: /SelfApprovalError|SELF_APPROVAL/ },
      { label: 'vector', args: vectors('create-proposal-self-approval'), failure: /applyCreate must reject/ },
    ],
  },
  {
    name: 'working-set',
    files: [
      {
        file: 'src/default-store.ts',
        mutate: leak({ mutate: 'this.files.mutate', exists: 'isSafePathSegment(rid) && this.readRecord(rid) !== null' }),
      },
      {
        file: 'src/obsidian-store.ts',
        mutate: leak({ mutate: 'this.mutate', exists: 'this.readRecord(rid, this.loadPathIndex()) !== null' }),
      },
    ],
    checks: [
      { label: 'unit', args: unit('outside the working set'), failure: /to not include 'pending-record'/ },
      { label: 'vector', args: vectors('create-proposal-working-set-exclusion'), failure: /"id": "create-proposal-working-set-exclusion",\s+"passed": false,\s+"error": "Expected values to be strictly deep-equal/ },
    ],
  },
  {
    // The vault's identity scans must not count retained proposal files (unbounded, not records).
    name: 'vault-scan',
    files: [{
      file: 'src/obsidian-store.ts',
      mutate: (s) => {
        const from = 'if (this.isProposalFile(directory, entry)) continue;';
        assert.equal(s.split(from).length, 3, 'both scans carry the skip');
        return s.split(from).join('');
      },
    }],
    checks: [
      { label: 'unit', args: unit('retained proposal files do not count'), failure: /exceeds its entry bound|vault holds records but has no path-index/ },
    ],
  },
];

const results = [];
for (const injection of injections) {
  const originals = injection.files.map(({ file }) => ({ path: join(packageRoot, file), text: readFileSync(join(packageRoot, file), 'utf8') }));
  run(`${injection.name}-build-baseline`, build, true);
  const baselines = injection.checks.map((check) => run(`${injection.name}-${check.label}-baseline`, check.args, true));
  const injected = [];
  try {
    injection.files.forEach(({ mutate }, index) => {
      const changed = mutate(originals[index].text);
      assert.notEqual(changed, originals[index].text);
      writeFileSync(originals[index].path, changed);
    });
    run(`${injection.name}-build-injected`, build, true);
    for (const check of injection.checks) {
      const result = run(`${injection.name}-${check.label}-injected`, check.args, false);
      assert.match(result.log, check.failure, `${injection.name}/${check.label} must fail for the intended reason`);
      injected.push(result.exit);
    }
  } finally {
    for (const original of originals) writeFileSync(original.path, original.text);
  }
  run(`${injection.name}-build-restored`, build, true);
  const restored = injection.checks.map((check) => run(`${injection.name}-${check.label}-restored`, check.args, true).exit);
  results.push({ name: injection.name, baseline: baselines.map((b) => b.exit), injected, restored });
}
writeFileSync(join(output, 'results.json'), `${JSON.stringify({ revision, node: process.version, results }, null, 2)}\n`);
assert.equal(git('status', '--porcelain'), '', 'The tree must be clean after restoring every injection');
console.log(JSON.stringify(results));
