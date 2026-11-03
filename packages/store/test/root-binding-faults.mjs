// Fault injection for root binding; run from a clean committed tree.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const output = resolve(process.argv[2] ?? '/tmp/corpus-root-binding-faults'); mkdirSync(output, { recursive: true });
const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout.trim();
assert.equal(git('status', '--porcelain'), '', 'Commit and confirm a clean tree');
function run(label, pattern, pass) {
  const r = spawnSync('npm', ['run', 'test', '--workspace=@kontourai/corpus-store', '--', 'test/root-binding.test.ts', '-t', pattern], { cwd: root, encoding: 'utf8', timeout: 300000 });
  const log = (r.stdout ?? '') + (r.stderr ?? ''); writeFileSync(join(output, `${label}.log`), log); assert.equal(r.error, undefined);
  if (pass) assert.equal(r.status, 0, log); else { assert.notEqual(r.status, 0, log); assert.match(log, /expected function to throw|to be|promise resolved/); }
  console.log(`${label}: exit ${r.status}`);
}
const cases = [
  ['mismatch', "adapter.rootBinding() !== expected", 'false', 'matches canonical aliases'],
  ['overwrite', "if (files.readText(path, 64) === null) files.writeText(path, randomBytes(32).toString('hex'));\n      else { try { binding(options.storeRoot); } catch { throw new RootBindingMismatchError(); } }", "files.writeText(path, randomBytes(32).toString('hex'));", 'initialization never'],
  ['marker-validation', "if (!stat.isFile() || stat.nlink !== 1 || stat.size !== 64)", "if (false)", 'malformed markers'],
];
const path = join(root, 'packages/store/src/root-binding.ts');
for (const [name, before, after, pattern] of cases) {
  const original = readFileSync(path, 'utf8'); assert.ok(original.includes(before), `missing ${name} anchor`);
  run(`${name}-baseline`, pattern, true);
  try { writeFileSync(path, original.replace(before, after)); run(`${name}-injected`, pattern, false); }
  finally { writeFileSync(path, original); }
  run(`${name}-restored`, pattern, true);
}
assert.equal(git('status', '--porcelain'), '', 'Restore every injection');
