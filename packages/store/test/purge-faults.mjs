// Fault injection for purge. Each control weakens one rule in the source, rebuilds,
// and requires the named check to fail for the stated reason, then restores the
// file and requires the same check to pass again. Run on a clean, committed tree:
//   npm run proof:purge --workspace=@kontourai/corpus-store -- [output-directory] [control ids...]
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const output = resolve(process.argv[2] ?? join(tmpdir(), 'corpus-purge-faults'));
mkdirSync(output, { recursive: true });
const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
assert.equal(git('status', '--porcelain').stdout.trim(), '', 'Commit a clean baseline before mutation');
const revision = git('rev-parse', 'HEAD').stdout.trim();
const store = 'packages/store/';
const purge = store + 'src/shared/purge.ts';
const conformance = (...ids) => ['run', 'conformance', '--workspace=@kontourai/corpus-store', '--', ...ids];
const focused = (...files) => ['run', 'test', '--workspace=@kontourai/corpus-store', '--', ...files];
const remove = (source, text) => { assert.ok(source.includes(text), `fault target not found: ${text}`); return source.replace(text, ''); };
const swap = (source, from, to) => { assert.ok(source.includes(from), `fault target not found: ${from}`); return source.replace(from, to); };

const controls = [
  { id: 'skip-cascade', file: purge, mutate: (s) => swap(s, '.filter((record) => before.has(record.id) && !after.has(record.id) && !gone.has(record.id))', '.filter(() => false)'),
    args: conformance('purge-cascade-sole-dependency', 'purge-cascade-cycle', 'purge-source-ids-support'), reason: /result\.cascaded/ },
  // Tombstone a record as soon as any support is lost, instead of only when all of it is.
  { id: 'cascade-on-any-lost-support', file: purge, mutate: (s) => swap(s, 'support.some((id) => !inStore.has(id) || alive.has(id))', 'support.every((id) => !inStore.has(id) || alive.has(id))'),
    args: conformance('purge-survivor-keeps-support', 'purge-source-ids-support'), reason: /(survivor|cascaded|e_after|f_after)/ },
  { id: 'outside-support-not-real', file: purge, mutate: (s) => swap(s, '!inStore.has(id) || alive.has(id)', 'alive.has(id)'),
    args: conformance('purge-source-ids-support'), reason: /result\.cascaded/ },
  // The naive rule: a record survives while any support is not purged, so a cycle holds itself up.
  { id: 'no-cycle-rule', file: purge, mutate: (s) => swap(s, 'support.some((id) => !inStore.has(id) || alive.has(id))', 'support.some((id) => !gone.has(id))'),
    args: conformance('purge-cascade-cycle'), reason: /result\.cascaded/ },
  { id: 'survivor-log-skipped', file: purge, mutate: (s) => swap(s, "auditEntry(op, at, evidence, { purged_ids: purgedIds }),", ''),
    args: conformance('purge-survivor-keeps-support', 'purge-source-ids-support'), reason: /(mutation_log|survivor)/ },
  { id: 'tombstone-keeps-body', file: purge, mutate: (s) => swap(s, "    body: '',\n    category: PURGED_CATEGORY,", '    body: record.body,\n    category: PURGED_CATEGORY,'),
    args: conformance('purge-tombstone-shape', 'purge-store-bytes'), reason: /(record\.body|is still on disk)/ },
  { id: 'tombstone-keeps-title', file: purge, mutate: (s) => swap(s, 'title: PURGED_TITLE,', 'title: record.title,'),
    args: conformance('purge-tombstone-shape', 'purge-store-bytes'), reason: /(record\.title|is still on disk)/ },
  { id: 'tombstone-keeps-content-hash', file: purge, mutate: (s) => swap(swap(s, "import { isRecord } from '../is-record.js';", "import { createHash } from 'node:crypto';\nimport { isRecord } from '../is-record.js';"), "    status: 'purged',\n", "    status: 'purged',\n    ...({ content_sha256: createHash('sha256').update(record.body).digest('hex') } as object),\n"),
    args: conformance('purge-store-bytes'), reason: /sha256 of .* is on disk/ },
  { id: 'tombstone-keeps-link-labels', file: purge, mutate: (s) => swap(s, '.map(({ target_id, kind }) => ({ target_id, kind }))', '.map((link) => ({ ...link }))'),
    args: conformance('purge-tombstone-links', 'purge-store-bytes'), reason: /(label|is still on disk)/ },
  { id: 'tombstone-keeps-log-prose', file: purge, mutate: (s) => swap(s, '...(record.mutation_log ?? []).map(scrubEntry),', '...(record.mutation_log ?? []),'),
    args: focused('test/purge.test.ts'), reason: /(Secret|reduces earlier log entries|exactly the tombstone shape)/ },
  { id: 'survivor-keeps-erased-label', file: purge, mutate: (s) => swap(s, 'if (!erased.has(link.target_id) || link.label === undefined) return link;', 'return link;'),
    args: conformance('purge-store-bytes'), reason: /label ALPHA-7.* is still on disk/ },
  { id: 'survivor-log-keeps-erased-label', file: purge, mutate: (s) => swap(s, '.map((entry) => unlabelErased(entry, erased))', ''),
    args: focused('test/purge.test.ts'), reason: /Erased Title/ },
  { id: 'tombstone-mutable', file: store + 'src/default-store.ts', mutate: (s) => swap(s, "    assertNotPurged('update', record);\n", ''),
    args: conformance('purge-refuses-tombstone-mutation'), reason: /update must reject|PURGED/ },
  { id: 'tombstone-citable', file: purge, mutate: (s) => swap(s, 'if (target) assertNotPurged(op, target);', ''),
    args: conformance('purge-refuses-tombstone-mutation'), reason: /(update|create) must reject/ },
  { id: 'alias-survives-purge', file: store + 'src/default-store.ts', mutate: (s) => swap(s, '      unregisterAliases(aliasIndex, id);\n', ''),
    args: conformance('purge-read-paths'), reason: /by_alias/ },
  { id: 'vault-title-path-survives', file: store + 'src/obsidian-store.ts', mutate: (s) => swap(s, 'const target = this.tombstonePath(id, pathIndex);', 'const target = entry.path;'),
    args: conformance('purge-store-bytes'), reason: /ember-zebra-interview.* is still on disk/ },
  { id: 'vault-survivors-not-rerendered', file: store + 'src/obsidian-store.ts', mutate: (s) => swap(s, "this.writeRecord(survivorOf(op, records.get(id)!, now, evidence, plan.erased, plan.lost.get(id)!), pathIndex);", 'void 0;'),
    args: focused('test/purge.test.ts'), reason: /zebra-quartz-memo/ },
  { id: 'journal-keeps-before-images', file: store + 'src/shared/file-transactions.ts', mutate: (s) => swap(s, 'for (const entry of context.journal.entries) entry.before = null;', ''),
    args: conformance('purge-journal-erasure'), reason: /still holds erased content in the journal|journal must/ },
  { id: 'purge-always-allowed', file: store + 'src/default-store.ts', mutate: (s) => swap(s, 'if (!this.services.allowPurge) {', 'if (!this.services.allowPurge && false) {'),
    args: focused('test/purge.test.ts'), reason: /is refused without allowPurge/ },
  { id: 'partial-write-on-missing-id', file: store + 'src/default-store.ts', mutate: (s) => swap(s, '    for (const id of requested) {\n      if (!records.has(id)) throw new KnowledgeRecordNotFoundError(id);\n    }\n    const plan', '    requested = requested.filter((id) => records.has(id));\n    const plan'),
    args: conformance('purge-input-validation'), reason: /NOT_FOUND|must reject/ },
  { id: 'prefix-resolves-target', file: store + 'src/default-store.ts', mutate: (s) => swap(s, '    const plan = planPurge(requested, records);\n    const now = new Date(this.services.clock()).toISOString();\n    const graph = this.loadGraph();\n    const aliasIndex', '    requested = requested.map((id) => [...records.keys()].find((key) => key.startsWith(id)) ?? id);\n    const plan = planPurge(requested, records);\n    const now = new Date(this.services.clock()).toISOString();\n    const graph = this.loadGraph();\n    const aliasIndex'),
    args: conformance('purge-input-validation'), reason: /NOT_FOUND|must reject/ },
];

function run(label, args, success) {
  const result = spawnSync('npm', args, { cwd: repo, encoding: 'utf8', timeout: 300000 });
  const log = (result.stdout ?? '') + (result.stderr ?? '');
  writeFileSync(join(output, label + '.log'), log);
  assert.equal(result.error, undefined, `${label}: execution error`);
  assert.equal(result.signal, null, `${label}: interrupted command`);
  if (success) assert.equal(result.status, 0, log); else assert.notEqual(result.status, 0, `${label} must fail`);
  console.log(`${label}: exit ${result.status}`);
  return { exit: result.status, log };
}

const build = (label) => run(label, ['run', 'build', '--workspace=@kontourai/corpus-store'], true);
const selected = process.argv.slice(3);
for (const id of selected) assert.ok(controls.some((control) => control.id === id), `Unknown fault control: ${id}`);
build('build-baseline');
const results = [];
for (const control of controls.filter((control) => !selected.length || selected.includes(control.id))) {
  const file = join(repo, control.file);
  const original = readFileSync(file, 'utf8');
  const baseline = run(control.id + '-baseline', control.args, true);
  let injected;
  try {
    const mutated = control.mutate(original);
    assert.notEqual(mutated, original, `${control.id}: the injection changed nothing`);
    writeFileSync(file, mutated);
    build(control.id + '-build-injected');
    injected = run(control.id + '-injected', control.args, false);
    // Read the failure text: a broken build or "no tests found" is not a catch.
    assert.doesNotMatch(injected.log, /no tests found|error TS\d+/i, `${control.id}: failed for an unrelated reason`);
    assert.match(injected.log, control.reason, `${control.id}: wrong rejection reason`);
  } finally { writeFileSync(file, original); }
  build(control.id + '-build-restored');
  const restored = run(control.id + '-restored', control.args, true);
  results.push({ id: control.id, baseline: baseline.exit, injected: injected.exit, restored: restored.exit });
  writeFileSync(join(output, 'results.json'), JSON.stringify({ revision, node: process.version, results }, null, 2) + '\n');
  assert.equal(git('status', '--porcelain').stdout.trim(), '', `${control.id}: failed to restore baseline`);
}
writeFileSync(join(output, 'results.json'), JSON.stringify({ revision, node: process.version, results }, null, 2) + '\n');
