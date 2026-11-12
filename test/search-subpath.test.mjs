// Guards for `@kontourai/corpus/search`: hosts bundle that subpath into
// offline, credential-free servers, so nothing it loads may touch the file
// system, the network, or the process, either when it is imported or when it
// searches. Two independent checks: a static walk of the import graph from the
// subpath's entry, and a child process that imports the subpath with those
// APIs made to throw and runs a search.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { offlineSearchProbe } from '../scripts/offline-search-probe.mjs';
import { FIXTURES, REPO_ROOT } from './helpers.mjs';
import { searchBundles } from '../src/search.mjs';

const SRC = path.join(REPO_ROOT, 'src');
const ENTRY = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).exports['./search'];

/**
 * Bare specifiers the subpath's closure may import. Third-party packages are
 * allowed by name and are not walked: each is a pure parser or string helper
 * that does no I/O, and the child-process check below loads them for real with
 * I/O disabled. Any other bare specifier, including every other `node:`
 * built-in, fails the walk.
 */
const ALLOWED_PACKAGES = new Set([
  'node:path', // path string manipulation only; never touches the file system
  'marked', // Markdown lexer
  'github-slugger', // heading slugs
  'htmlparser2', // HTML tokenizer for raw HTML in Markdown
]);

/**
 * Text no file in the closure may contain, anywhere: at the top level it runs
 * at import time, and inside a function it runs at query time, and both must be
 * offline. A comment that trips one of these should be reworded.
 */
const FORBIDDEN = [
  [/\breadFile(Sync)?\b/, 'reads a file'],
  [/\bimport\.meta\b/, 'resolves something relative to the module file'],
  [/\bfetch\s*\(/, 'uses the network'],
  [/\bprocess\s*[.[]/, 'reads or changes process state'],
  [/\brequire\s*\(|\bcreateRequire\b/, 'loads modules outside the static import graph'],
  [/\bimport\s*\(/, 'imports a module dynamically'],
];

const STATIC_IMPORT = /^[ \t]*(?:import|export)\s+(?:[\w$*{},\s]+?\s+from\s*)?(['"])([^'"]+)\1/gm;
const IMPORT_LINE = /^[ \t]*import\b(?!\s*[.(])/gm;

/** Walk the import graph from `entry` through Corpus's own files. Returns the visited files and every problem found. */
function walk(entry) {
  const visited = new Set();
  const problems = [];
  const queue = [path.resolve(REPO_ROOT, entry)];
  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    const name = path.relative(REPO_ROOT, file);
    const text = readFileSync(file, 'utf8');
    for (const [pattern, why] of FORBIDDEN) {
      const match = text.match(pattern);
      if (match) problems.push(`${name}: \`${match[0]}\` ${why}`);
    }
    const specifiers = [...text.matchAll(STATIC_IMPORT)].map((match) => match[2]);
    // Every import statement must have been read, so a form the pattern misses cannot hide an import.
    const imports = text.match(IMPORT_LINE)?.length ?? 0;
    const read = [...text.matchAll(STATIC_IMPORT)].filter((match) => /^\s*import\b/.test(match[0])).length;
    if (imports !== read) problems.push(`${name}: ${imports} import statements but ${read} were parsed; the walk cannot vouch for this file`);
    for (const specifier of specifiers) {
      if (specifier.startsWith('.')) {
        const target = path.resolve(path.dirname(file), specifier);
        if (!target.startsWith(`${SRC}${path.sep}`)) problems.push(`${name}: imports ${specifier}, outside src/`);
        else if (!existsSync(target)) problems.push(`${name}: imports ${specifier}, which does not exist`);
        else queue.push(target);
      } else if (!ALLOWED_PACKAGES.has(specifier)) {
        problems.push(`${name}: imports ${specifier}, which is not allowed in the offline search closure`);
      }
    }
  }
  return { visited: [...visited].map((file) => path.relative(REPO_ROOT, file)).sort(), problems };
}

test('the ./search export is the search entry and exports only searchBundles', async () => {
  assert.equal(ENTRY, './src/search-entry.mjs');
  const entry = await import('@kontourai/corpus/search');
  assert.deepEqual(Object.keys(entry), ['searchBundles']);
  assert.equal(entry.searchBundles, searchBundles);
});

test('the ./search import closure has no file, network, or process access', () => {
  const { visited, problems } = walk(ENTRY);
  // The walk reached past the entry into the module that does the work.
  assert.ok(visited.includes('src/search.mjs'), visited.join('\n'));
  assert.deepEqual(problems, [], `visited:\n${visited.join('\n')}`);
});

test('the walk rejects a forbidden import and a file read', () => {
  // The guard's own rejection path, against a closure that does both.
  const { problems } = walk('test/fixtures/offline-unsafe/entry.mjs');
  assert.ok(problems.some((problem) => problem.includes('imports node:fs, which is not allowed')), problems.join('\n'));
  assert.ok(problems.some((problem) => problem.includes('`readFileSync` reads a file')), problems.join('\n'));
  assert.ok(problems.some((problem) => problem.includes('`import.meta` resolves')), problems.join('\n'));
});

test('@kontourai/corpus/search imports and searches with the file system, child processes, the network, and fetch disabled', () => {
  const bundleFile = path.join(FIXTURES, 'search-bundles', 'station.docs-bundle.json');
  const query = 'how do I run something on a cron job';
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', offlineSearchProbe(bundleFile, query)], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000 });
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  const { results, denied } = JSON.parse(child.stdout);
  assert.deepEqual(denied, []);
  // The same ranking as in this process, where nothing is disabled.
  const expected = searchBundles([JSON.parse(readFileSync(bundleFile, 'utf8'))], query, 5);
  assert.deepEqual(results, expected);
  // "cron job" reaches Station's scheduled-jobs topic only through a suite synonym.
  assert.ok(results.slice(0, 3).some((result) => result.kind === 'topic' && result.id === 'scheduled-jobs'), JSON.stringify(results, null, 2));
});

test('the probe fails when the code under test touches a disabled API', () => {
  // The runtime guard's own rejection path: a module that reads a file at import time.
  const bundleFile = path.join(FIXTURES, 'search-bundles', 'station.docs-bundle.json');
  const source = offlineSearchProbe(bundleFile, 'cron').replace(
    "await import('@kontourai/corpus/search')",
    `await import(${JSON.stringify(path.join(FIXTURES, 'offline-unsafe', 'entry.mjs'))})`,
  );
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', source], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000 });
  assert.notEqual(child.status, 0, child.stdout);
  assert.match(child.stderr, /offline-safety probe: node:fs\.readFileSync was called/);
});
