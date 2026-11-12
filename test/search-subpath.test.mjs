// `@kontourai/corpus/search` is bundled by hosts into offline, credential-free
// servers. scripts/check-offline-search.mjs is the guard: it bundles the entry
// with its whole closure, refuses any import left in the bundle, and searches
// in a vm context that has only the JavaScript built-ins. These tests run that
// guard as a child process, on the real subpath and on negative controls that
// each must fail it, including every bypass found against the earlier guard.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FIXTURES, REPO_ROOT } from './helpers.mjs';
import { searchBundles } from '../src/search.mjs';

const GUARD = path.join(REPO_ROOT, 'scripts', 'check-offline-search.mjs');
const BUNDLE = path.join(FIXTURES, 'search-bundles', 'station.docs-bundle.json');
const QUERY = 'how do I run something on a cron job';

function guard(args) {
  const child = spawnSync(process.execPath, [GUARD, ...args], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 });
  if (child.error) throw child.error;
  return child;
}

test('the ./search export is the search entry and exports only searchBundles', async () => {
  const exportsMap = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).exports;
  assert.equal(exportsMap['./search'], './src/search-entry.mjs');
  const entry = await import('@kontourai/corpus/search');
  assert.deepEqual(Object.keys(entry), ['searchBundles']);
  assert.equal(entry.searchBundles, searchBundles);
});

test('@kontourai/corpus/search bundles with no imports and searches in a sandbox with only the language built-ins', () => {
  const child = guard([BUNDLE, QUERY]);
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  const { inputs, results } = JSON.parse(child.stdout);
  // The bundle reached the module that does the work and its third-party closure.
  for (const input of ['src/search-entry.mjs', 'src/search.mjs', 'src/markdown.mjs', 'node_modules/marked/lib/marked.esm.js', 'node_modules/htmlparser2/dist/index.js']) {
    assert.ok(inputs.includes(input), `${input} is not in the bundle:\n${inputs.join('\n')}`);
  }
  // The same ranking as an unrestricted search in this process.
  assert.deepEqual(results, searchBundles([JSON.parse(readFileSync(BUNDLE, 'utf8'))], QUERY, 10));
  // "cron job" reaches Station's scheduled-jobs topic only through a suite synonym.
  assert.ok(results.slice(0, 3).some((result) => result.kind === 'topic' && result.id === 'scheduled-jobs'), JSON.stringify(results, null, 2));
});

test('the guard refuses bad usage with exit 2', () => {
  const child = guard([BUNDLE]);
  assert.equal(child.status, 2, child.stderr);
  assert.match(child.stderr, /expected a bundle file and a query/);
});

// Each control is a small module tree whose entry exports searchBundles, and
// must fail the guard with exit 1 for the stated reason. `SENTINEL` is a file
// the control tries to read.
const READER = `import { readFileSync } from 'node:fs';\nexport const x = readFileSync(SENTINEL, 'utf8');\n`;
const SEARCH = `export function searchBundles() { return [{ kind: 'topic', id: 'x' }]; }\n`;
const CONTROLS = [
  {
    name: 'createRequire JSON read at import',
    files: { 'entry.mjs': `import { createRequire } from 'node:module';\nconst load = createRequire(import.meta.url);\nconst data = load(SENTINEL);\nexport function searchBundles() { return [data]; }\n` },
    reason: /still imports node:module/,
  },
  {
    name: 'createRequire JSON read at the first search',
    files: { 'entry.mjs': `import { createRequire } from 'node:module';\nconst load = createRequire(import.meta.url);\nexport function searchBundles() { return [load(SENTINEL)]; }\n` },
    reason: /still imports node:module/,
  },
  {
    name: 'a file read from a module named denied_',
    files: { 'entry.mjs': `export { searchBundles } from './denied_.mjs';\n`, 'denied_.mjs': `import { readFileSync } from 'node:fs';\nconst data = readFileSync(SENTINEL, 'utf8');\nexport function searchBundles() { return [data]; }\n` },
    reason: /denied_\.mjs imports node:fs/,
  },
  {
    name: 'an empty re-export with a comment before the specifier',
    files: { 'entry.mjs': `export {} from /* initialize search helper */ './reader.mjs';\n${SEARCH}`, 'reader.mjs': READER },
    reason: /reader\.mjs imports node:fs/,
  },
  {
    name: 'a named re-export with a comment before the specifier',
    files: { 'entry.mjs': `export { x } from /* explanation */ './reader.mjs';\n${SEARCH}`, 'reader.mjs': READER },
    reason: /reader\.mjs imports node:fs/,
  },
  {
    name: 'an import on the same line as an export',
    files: { 'entry.mjs': `export const a = 1; import './reader.mjs';\n${SEARCH}`, 'reader.mjs': READER },
    reason: /reader\.mjs imports node:fs/,
  },
  {
    name: 'a file read deferred by a timer from the search',
    files: { 'entry.mjs': `import { readFileSync } from 'node:fs';\nexport function searchBundles() { setTimeout(() => { globalThis.leak = readFileSync(SENTINEL, 'utf8'); }, 0); return [{ kind: 'topic', id: 'x' }]; }\n` },
    reason: /still imports node:fs/,
  },
  {
    name: 'a timer with no import',
    files: { 'entry.mjs': `export function searchBundles() { setTimeout(() => {}, 0); return [{ kind: 'topic', id: 'x' }]; }\n` },
    reason: /searching in the sandbox threw: ReferenceError: setTimeout is not defined/,
  },
  {
    name: 'a queued microtask',
    files: { 'entry.mjs': `export function searchBundles() { queueMicrotask(() => {}); return [{ kind: 'topic', id: 'x' }]; }\n` },
    reason: /ReferenceError: queueMicrotask is not defined/,
  },
  {
    name: 'reading process.env',
    files: { 'entry.mjs': `export function searchBundles() { return [{ kind: 'topic', id: String(process.env.HOME) }]; }\n` },
    reason: /searching in the sandbox threw: ReferenceError: process is not defined/,
  },
  {
    name: 'writing process.env',
    files: { 'entry.mjs': `export function searchBundles() { process.env.CORPUS_PROBE = 'changed'; return [{ kind: 'topic', id: 'x' }]; }\n` },
    reason: /ReferenceError: process is not defined/,
  },
  {
    name: 'process.cwd() at import, through globalThis',
    files: { 'entry.mjs': `const cwd = globalThis.process.cwd();\nexport function searchBundles() { return [{ kind: 'topic', id: cwd }]; }\n` },
    reason: /loading the bundle in the sandbox threw: TypeError/,
  },
  {
    name: 'fetch from the search',
    files: { 'entry.mjs': `export function searchBundles() { fetch('https://example.invalid/'); return [{ kind: 'topic', id: 'x' }]; }\n` },
    reason: /ReferenceError: fetch is not defined/,
  },
  {
    name: 'reaching process through a constructor',
    files: { 'entry.mjs': `export function searchBundles(bundles) { return [{ kind: 'topic', id: String(bundles.constructor.constructor('return process')()) }]; }\n` },
    reason: /searching in the sandbox threw: EvalError/,
  },
  {
    name: 'a dynamic import of node:fs from the search',
    files: { 'entry.mjs': `export function searchBundles() { import('node:fs'); return [{ kind: 'topic', id: 'x' }]; }\n` },
    reason: /still imports node:fs \(dynamic-import\)/,
  },
  {
    name: 'node:fs/promises',
    files: { 'entry.mjs': `import { readFile } from 'node:fs/promises';\nexport function searchBundles() { readFile(SENTINEL); return [{ kind: 'topic', id: 'x' }]; }\n` },
    reason: /still imports node:fs\/promises/,
  },
  {
    name: 'a transitive dependency that reads a file with require',
    files: {
      'entry.mjs': `import wrapped from 'wrapper';\nexport function searchBundles() { return [{ kind: 'topic', id: String(wrapped) }]; }\n`,
      'node_modules/wrapper/package.json': `{ "name": "wrapper", "version": "1.0.0", "main": "index.js" }\n`,
      'node_modules/wrapper/index.js': `module.exports = require('unsafe-dep');\n`,
      'node_modules/unsafe-dep/package.json': `{ "name": "unsafe-dep", "version": "1.0.0", "main": "index.js" }\n`,
      'node_modules/unsafe-dep/index.js': `module.exports = require('fs').readFileSync(SENTINEL, 'utf8');\n`,
    },
    reason: /node_modules\/unsafe-dep\/index\.js imports fs \(require-call\)/,
  },
  {
    name: 'using node:path, which the bundle gets only as a stand-in',
    files: { 'entry.mjs': `import path from 'node:path';\nexport function searchBundles() { return [{ kind: 'topic', id: path.posix.basename('a/b') }]; }\n` },
    reason: /node:path\.posix was used/,
  },
  {
    name: "the review's combined bypass: a commented empty re-export of a createRequire read",
    files: {
      'entry.mjs': `${SEARCH}export {} from /* initialize search helper */ './query-helper.mjs';\n`,
      'query-helper.mjs': `import { createRequire } from 'node:module';\nconst load = createRequire(import.meta.url);\nglobalThis.reviewLeak = load(SENTINEL);\n`,
    },
    reason: /query-helper\.mjs imports node:module/,
  },
];

for (const control of CONTROLS) {
  test(`negative control fails the guard: ${control.name}`, (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'corpus-offline-control-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const sentinel = path.join(dir, 'sentinel.json');
    writeFileSync(sentinel, '{"secret":"CONTROL_SENTINEL"}\n');
    for (const [name, text] of Object.entries(control.files)) {
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      writeFileSync(path.join(dir, name), text.replaceAll('SENTINEL', JSON.stringify(sentinel)));
    }
    const child = guard(['--from', dir, '--entry', path.join(dir, 'entry.mjs'), BUNDLE, 'cron']);
    assert.equal(child.status, 1, `expected exit 1\nstdout: ${child.stdout}\nstderr: ${child.stderr}`);
    assert.match(child.stderr, /^FAIL offline search: /);
    assert.match(child.stderr, control.reason);
    assert.doesNotMatch(`${child.stdout}${child.stderr}`, /CONTROL_SENTINEL/);
  });
}

test('a clean control passes the guard, so the controls fail for their own reason', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'corpus-offline-control-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'entry.mjs'), SEARCH);
  const child = guard(['--from', dir, '--entry', path.join(dir, 'entry.mjs'), BUNDLE, 'cron']);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout).results, [{ kind: 'topic', id: 'x' }]);
});
