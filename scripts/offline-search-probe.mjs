// The runtime half of the offline-safety guard for `@kontourai/corpus/search`.
//
// `offlineSearchProbe` returns the source of an ES module meant for
// `node --input-type=module --eval`, run with the working directory where
// `@kontourai/corpus` should resolve from: this checkout (a package can import
// itself by name) or a project with the packed tarball installed. The module
// reads the bundle file, then replaces every function of the file system,
// child process, and network modules, and the global `fetch`, with one that
// records the call and throws. Only then does it import the subpath and
// search. It restores them, prints { results, denied } as JSON, and exits 1
// if anything was called, so a call that the code under test caught still
// fails the probe.
//
// Usage from a parent: spawnSync(process.execPath, ['--input-type=module',
// '--eval', offlineSearchProbe(bundleFile, query)], { cwd }).

/** Built-in modules the subpath must not touch, at load time or query time. */
export const DENIED_MODULES = ['node:fs', 'node:fs/promises', 'node:child_process', 'node:net', 'node:http', 'node:https', 'node:http2', 'node:tls', 'node:dgram', 'node:dns', 'node:worker_threads'];

export function offlineSearchProbe(bundleFile, query) {
  return `
import { readFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';

const bundle = JSON.parse(readFileSync(${JSON.stringify(bundleFile)}, 'utf8'));
const require = createRequire(import.meta.url);
const denied = [];
const restore = [];
// Node's own module loader resolves and reads imports through the public fs
// (realpathSync, and readFileSync -> openSync on Node 22); that is loading,
// not the code under test. A call is the loader's when, walking out from the
// call past Node's built-in frames, the first frame outside node:fs and its
// kin (and this probe's own stubs) is the module loader; any other first
// caller is the code under test.
function fromLoader() {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = Infinity;
  const frames = new Error().stack.split('\\n').slice(3);
  Error.stackTraceLimit = limit;
  for (const frame of frames) {
    // A stub that passed a loader call through to the real function.
    if (/\\bdenied_\\b/.test(frame)) continue;
    const location = /\\((.*)\\)$/.exec(frame)?.[1] ?? frame.replace(/^\\s*at\\s+(async\\s+)?/, '');
    if (location.startsWith('node:internal/modules/')) return true;
    if (!location.startsWith('node:')) return false;
  }
  return false;
}
function deny(target, key, label) {
  const original = target[key];
  target[key] = function denied_(...args) {
    if (fromLoader()) return original.apply(this, args);
    denied.push(label);
    throw new Error('offline-safety probe: ' + label + ' was called');
  };
  restore.push(() => { target[key] = original; });
}
for (const name of ${JSON.stringify(DENIED_MODULES)}) {
  const builtin = require(name);
  for (const [key, value] of Object.entries(builtin)) {
    // Classes (fs.Stats, net.Socket) stay; every function that does I/O is lowercase.
    if (typeof value === 'function' && !/^[A-Z]/.test(key)) deny(builtin, key, name + '.' + key);
  }
}
// ESM named imports of built-ins (import { readFileSync } from 'node:fs') read
// these bindings, not the CommonJS object, until they are synced.
syncBuiltinESMExports();
deny(globalThis, 'fetch', 'fetch');

const { searchBundles } = await import('@kontourai/corpus/search');
const results = searchBundles([bundle], ${JSON.stringify(query)}, 5);

for (const undo of restore.reverse()) undo();
syncBuiltinESMExports();
console.log(JSON.stringify({ results, denied }));
if (denied.length > 0) process.exitCode = 1;
`;
}
