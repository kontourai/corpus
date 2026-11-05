// Reproducible faults for record confidence (kontourai/corpus#68). Run only from a clean committed tree.
// Each case weakens one rule in the source and requires the unit test that names it, and the conformance
// vectors that cover it, to fail for that reason. It then restores the file, rebuilds, and requires both to pass again.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const output = resolve(process.argv[2] ?? '/tmp/corpus-confidence-faults');
const testFile = 'test/confidence.test.ts';
const workspace = '--workspace=@kontourai/corpus-store';
mkdirSync(output, { recursive: true });
const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout.trim();
const npm = (label, args) => {
  const r = spawnSync('npm', args, { cwd: root, encoding: 'utf8', timeout: 600000 });
  const log = (r.stdout ?? '') + (r.stderr ?? '');
  writeFileSync(join(output, `${label}.log`), log);
  assert.equal(r.error, undefined);
  return { status: r.status, log };
};
const build = (label) => assert.equal(npm(label, ['run', 'build', workspace]).status, 0, `${label}: build failed`);
const unit = (label, pattern, failure) => {
  const { status, log } = npm(label, ['run', 'test', workspace, '--', testFile, ...(pattern ? ['-t', pattern] : [])]);
  if (!failure) assert.equal(status, 0, log);
  else {
    assert.notEqual(status, 0, `${label}: the fault was not caught\n${log}`);
    // A run that selected nothing, or that broke the build, is not a catch.
    assert.ok(log.includes(`FAIL  ${testFile}`), `${label}: the fault must fail the selected test\n${log}`);
    assert.match(log, failure, `${label}: failed for another reason\n${log}`);
  }
  console.log(`${label}: exit ${status}`);
};
const conformance = (label, vectors, failure) => {
  const { status, log } = npm(label, ['run', 'conformance', workspace, '--', ...vectors]);
  if (!failure) assert.equal(status, 0, log);
  else {
    assert.notEqual(status, 0, `${label}: the fault was not caught\n${log}`);
    for (const id of vectors) assert.ok(log.includes(`"id": "${id}"`) && log.includes('"passed": false'), `${label}: expected ${id} to fail\n${log}`);
    assert.match(log, failure, `${label}: failed for another reason\n${log}`);
  }
  console.log(`${label}: exit ${status}`);
};
const REFUSED_UNIT = /expected undefined to be 'MISSING_EVIDENCE'/;
const REFUSED_VECTOR = /Missing expected rejection|must reject/;
const ALL_VECTORS = [
  'confidence-create-roundtrip', 'confidence-exact-values', 'confidence-negative-zero', 'confidence-create-refused',
  'confidence-propose-refused', 'confidence-propose-apply-roundtrip', 'confidence-update', 'confidence-request-key',
  'confidence-purge-record', 'confidence-purge-cascade', 'confidence-purge-proposal',
];
// [name, file, before, after, unit test name pattern, unit failure, conformance vectors, conformance failure]
const cases = [
  ['upper-bound', 'src/shared/confidence.ts', 'value >= CONFIDENCE_MIN && value <= CONFIDENCE_MAX', 'value >= CONFIDENCE_MIN', 'refuses confidence just above 1', REFUSED_UNIT, ['confidence-create-refused', 'confidence-propose-refused'], REFUSED_VECTOR],
  ['lower-bound', 'src/shared/confidence.ts', 'value >= CONFIDENCE_MIN && value <= CONFIDENCE_MAX', 'value <= CONFIDENCE_MAX', 'refuses confidence just below 0', REFUSED_UNIT, ['confidence-create-refused', 'confidence-propose-refused'], REFUSED_VECTOR],
  ['clamp', 'src/shared/confidence.ts', '  if (!isConfidence(value)) {', "  if (typeof value === 'number' && value > 1) return 1;\n  if (!isConfidence(value)) {", 'create refuses confidence 1.01', REFUSED_UNIT, ['confidence-create-refused', 'confidence-propose-refused', 'confidence-update'], REFUSED_VECTOR],
  ['nan', 'src/shared/confidence.ts', 'value >= CONFIDENCE_MIN && value <= CONFIDENCE_MAX', '!(value < CONFIDENCE_MIN) && !(value > CONFIDENCE_MAX)', 'refuses confidence NaN', REFUSED_UNIT, ['confidence-create-refused', 'confidence-propose-refused', 'confidence-update'], REFUSED_VECTOR],
  ['type', 'src/shared/confidence.ts', "typeof value === 'number' && value >= CONFIDENCE_MIN && value <= CONFIDENCE_MAX", '(value as number) >= CONFIDENCE_MIN && (value as number) <= CONFIDENCE_MAX', 'refuses confidence text', REFUSED_UNIT, ['confidence-create-refused', 'confidence-propose-refused', 'confidence-update'], REFUSED_VECTOR],
  ['null-on-create', 'src/shared/confidence.ts', 'return raw === undefined ? {} : { confidence: validate(raw, op) };', 'return raw === undefined || raw === null ? {} : { confidence: validate(raw, op) };', 'refuses confidence null', REFUSED_UNIT, ['confidence-create-refused', 'confidence-propose-refused'], REFUSED_VECTOR],
  ['inherited-on-create', 'src/shared/confidence.ts', "  if (!Object.hasOwn(input, 'confidence')) return {};\n", '', 'a confidence inherited from a prototype', /expected true to be false/, [], /./],
  ['inherited-on-update', 'src/shared/confidence.ts', "  if (!Object.hasOwn(fields, 'confidence')) return undefined;\n", '', 'a confidence inherited from a prototype', /expected 0.9 to be 0.4/, [], /./],
  ['inherited-in-candidate', 'src/shared/create-proposals.ts', "new Set(['expires_at', 'ttl_seconds', 'confidence'])", "new Set(['expires_at', 'ttl_seconds'])", 'a confidence inherited from a prototype', /expected true to be false/, [], /./],
  ['negative-zero', 'src/shared/confidence.ts', 'return value === 0 ? 0 : value;', 'return value;', 'negative zero is stored as zero', /expected false to be true/, ['confidence-negative-zero'], /./],
  ['proposal-drops-confidence', 'src/shared/create-proposals.ts', "'ttl_seconds', 'confidence',\n]", "'ttl_seconds',\n]", 'propose, apply, read and update carry confidence', /expected undefined to be 0.75/, ['confidence-propose-apply-roundtrip', 'confidence-request-key'], /./],
  ['proposal-validates-as-read', 'src/shared/create-proposals.ts', "    confidenceOnCreate(projected, 'proposeCreate');\n", '', 'refusal names the field', /got: NaN|got: a null|promise resolved|rejected/, ['confidence-propose-refused'], REFUSED_VECTOR],
  ['digest-ignores-confidence', 'src/shared/create-proposals.ts', 'Object.keys(object).sort().map', "Object.keys(object).filter((key) => key !== 'confidence').sort().map", 'a retry with a different confidence is a conflict', /expected undefined to be 'REQUEST_KEY_CONFLICT'/, ['confidence-request-key'], /./],
  ['default-create', 'src/default-store.ts', '      ...fresh,\n      ...confidence,\n', '      ...fresh,\n', 'create stores confidence', /expected undefined to be 0.75/, ['confidence-create-roundtrip', 'confidence-propose-apply-roundtrip'], /./],
  ['vault-create', 'src/obsidian-store.ts', "{ ...freshnessPatch(input), ...confidenceOnCreate(input, 'create') }", 'freshnessPatch(input)', 'create stores confidence', /expected undefined to be 0.75/, ['confidence-create-roundtrip', 'confidence-propose-apply-roundtrip'], /./],
  ['default-update-key', 'src/default-store.ts', "      'ttl_seconds',\n      'confidence',\n    ] as const;", "      'ttl_seconds',\n    ] as const;", 'update changes, keeps and clears confidence', /at least one mutable field/, ['confidence-update'], /./],
  ['vault-update-key', 'src/obsidian-store.ts', "      'ttl_seconds',\n      'confidence',\n    ] as const;", "      'ttl_seconds',\n    ] as const;", 'update changes, keeps and clears confidence', /at least one mutable field/, ['confidence-update'], /./],
  ['default-update-apply', 'src/default-store.ts', "      ...(typeof confidence === 'number' ? { confidence } : {}),\n", '', 'update changes, keeps and clears confidence', /expected 0.4 to be \+?0/, ['confidence-update'], /./],
  ['vault-update-apply', 'src/obsidian-store.ts', "      ...(typeof confidence === 'number' ? { confidence } : {}),\n", '', 'update changes, keeps and clears confidence', /expected 0.4 to be \+?0/, ['confidence-update'], /./],
  ['default-update-clear', 'src/default-store.ts', '    if (confidence === null) delete updated.confidence;\n', '', 'update changes, keeps and clears confidence', /expected true to be false/, ['confidence-update'], /./],
  ['vault-update-clear', 'src/obsidian-store.ts', '    if (confidence === null) delete updated.confidence;\n', '', 'update changes, keeps and clears confidence', /expected true to be false/, ['confidence-update'], /./],
  ['update-undefined-clears', 'src/shared/confidence.ts', '  if (raw === undefined) return undefined;\n  return raw === null ? null', '  if (raw === undefined) return null;\n  return raw === null ? null', 'update changes, keeps and clears confidence', /expected undefined to be 0.4/, [], /./],
  ['frontmatter-number', 'src/shared/frontmatter.ts', "root === 'ttl_seconds' || root === 'confidence'", "root === 'ttl_seconds'", 'confidence is stored exactly', /confidence must be a number from 0 to 1/, ['confidence-exact-values'], /./],
  ['read-validation', 'src/shared/record-schema.ts', 'record.confidence !== undefined && !isConfidence(record.confidence)', 'false', 'hand-edited confidence', /promise resolved|resolved instead of rejecting|rejected/, [], /./],
  ['reserved-dimension', 'src/obsidian-store.ts', "'ttl_seconds', 'confidence', 'status'", "'ttl_seconds', 'status'", 'a dimension cannot be named confidence', /expected \[Function\] to throw|did not throw/, [], /./],
  ['tombstone-keeps', 'src/shared/purge.ts', "    status: 'purged',\n    created_at: record.created_at,", "    status: 'purged',\n    ...(record.confidence !== undefined ? { confidence: record.confidence } : {}),\n    created_at: record.created_at,", 'the tombstone of a purged record has no confidence', /expected true to be false|not.*toContain|expected/, ['confidence-purge-record', 'confidence-purge-cascade'], /./],
  ['proposal-stub-keeps', 'src/shared/create-proposals.ts', "    title: PURGED_TITLE,\n    body: '',\n    category: PURGED_CATEGORY,", "    title: PURGED_TITLE,\n    body: '',\n    category: PURGED_CATEGORY,\n    ...(candidate.confidence !== undefined ? { confidence: candidate.confidence } : {}),", 'purging a pending proposal by id erases', /expected true to be false|not.*toContain|expected/, ['confidence-purge-proposal'], /./],
  ['describe-revoked-proxy', 'src/shared/confidence.ts', "    try { return Array.isArray(value) ? 'an array' : 'an object'; } catch { return 'an object'; }", "    return Array.isArray(value) ? 'an array' : 'an object';", 'a revoked proxy is refused', /to be 'MISSING_EVIDENCE'/, [], /./],
];
if (process.argv.includes('--check-targets')) {
  for (const [name, file, before] of cases) assert.ok(readFileSync(join(root, 'packages/store', file), 'utf8').includes(before), `missing anchor: ${name}`);
  console.log(`${cases.length} injection targets found`);
  process.exit(0);
}
assert.equal(git('status', '--porcelain'), '', 'Commit and confirm a clean tree');
build('build-baseline');
unit('unit-baseline', undefined);
conformance('conformance-baseline', ALL_VECTORS);
// `--from=NAME` resumes at that case, for a rerun after a fault in the script itself.
const from = process.argv.find((arg) => arg.startsWith('--from='))?.slice('--from='.length);
if (from) assert.ok(cases.some(([name]) => name === from), `unknown case: ${from}`);
let started = !from;
for (const [name, file, before, after, pattern, unitFailure, vectors, vectorFailure] of cases) {
  started ||= name === from;
  if (!started) continue;
  const path = join(root, 'packages/store', file);
  const original = readFileSync(path, 'utf8');
  assert.ok(original.includes(before), `missing anchor: ${name}`);
  const changed = original.replace(before, () => after);
  assert.notEqual(changed, original, `the injection changed nothing: ${name}`);
  try {
    writeFileSync(path, changed);
    unit(`${name}-unit-injected`, pattern, unitFailure);
    if (vectors.length) {
      build(`${name}-build-injected`);
      conformance(`${name}-conformance-injected`, vectors, vectorFailure);
    }
  } finally {
    writeFileSync(path, original);
  }
  if (vectors.length) build(`${name}-build-restored`);
  unit(`${name}-unit-restored`, pattern);
  if (vectors.length) conformance(`${name}-conformance-restored`, vectors);
}
assert.equal(git('status', '--porcelain'), '', 'Restore every injection');
console.log(`${cases.length} faults caught and restored`);
