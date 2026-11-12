// Offline-safety guard for `@kontourai/corpus/search`.
//
// Hosts bundle that subpath into offline, credential-free servers, so it must
// neither load nor search with file, network, process, or timer access. This
// guard checks that by construction rather than by watching for calls:
//
// 1. Bundle. esbuild bundles the entry with its whole transitive closure
//    (Corpus files and third-party packages alike), resolving every import
//    and re-export form the way Node does (platform "node"). The output must
//    import nothing at all: any built-in or package left external (node:fs,
//    node:module, child_process, a dependency's `require('fs')`, a dynamic
//    import) fails the guard. The one exception is `node:path`, which
//    src/markdown.mjs imports for link helpers that search does not call; the
//    guard gives the bundle a stand-in that throws on any use.
// 2. Evaluate. The bundle runs in a fresh `node:vm` context whose global
//    object has only the JavaScript built-ins: no process, require, module,
//    fetch, timers, queueMicrotask, Buffer, or console, and string-to-code
//    (eval, new Function) and WebAssembly compilation are disabled. Only
//    strings cross into the context, so no host object can lead back out.
//    Touching anything outside the language throws.
// 3. Compare. It searches the bundle file given on the command line inside the
//    context, and the results must be non-empty and identical to the same
//    search through a normal import of the same entry.
//
// Usage: node scripts/check-offline-search.mjs [--from <dir>] [--entry <file>] <bundle.json> <query>
//   --from   where `@kontourai/corpus/search` resolves from (default: this
//            repository, which imports itself by name; verify:pack passes the
//            project with the packed tarball installed)
//   --entry  check this module instead of the subpath (negative controls)
// Prints a JSON summary on stdout. Exit 0 pass, 1 guard failure, 2 usage.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';

export const SUBPATH = '@kontourai/corpus/search';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GLOBAL_NAME = '__corpusOfflineSearch';
const LIMIT = 10;

/** Globals the sandbox must not have; checked so a Node that adds one to vm contexts fails closed. */
export const ABSENT_GLOBALS = ['process', 'require', 'module', 'exports', 'fetch', 'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', 'Buffer', 'console', 'XMLHttpRequest', 'WebSocket', 'navigator'];

const PATH_STAND_IN = `
const refuse = (key) => { throw new Error('node:path.' + String(key) + ' was used; the offline search closure must not need node:path'); };
export default new Proxy({}, { get: (_, key) => refuse(key), has: (_, key) => refuse(key) });
`;

class GuardFailure extends Error {}

function usage(message) {
  console.error(`check-offline-search: ${message}\nusage: node scripts/check-offline-search.mjs [--from <dir>] [--entry <file>] <bundle.json> <query>`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { from: REPO, entry: null, positional: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--from' || arg === '--entry') {
      const value = argv[++index];
      if (value === undefined || value === '') usage(`${arg} needs a value`);
      options[arg.slice(2)] = path.resolve(value);
    } else if (arg.startsWith('--')) usage(`unknown option ${arg}`);
    else options.positional.push(arg);
  }
  if (options.positional.length !== 2) usage('expected a bundle file and a query');
  return options;
}

/** Bundle the entry; returns the code and the metafile inputs, or throws GuardFailure. */
async function bundle(entry, from) {
  const specifier = entry ? pathToFileURL(entry).href : SUBPATH;
  let result;
  try {
    result = await build({
      stdin: { contents: `export { searchBundles } from ${JSON.stringify(entry ?? SUBPATH)};\n`, resolveDir: from, sourcefile: 'offline-search-entry.mjs', loader: 'js' },
      absWorkingDir: from,
      bundle: true,
      write: false,
      metafile: true,
      format: 'iife',
      globalName: GLOBAL_NAME,
      platform: 'node',
      target: 'node22',
      logLevel: 'silent',
      plugins: [
        {
          name: 'node-path-stand-in',
          setup(builder) {
            builder.onResolve({ filter: /^(node:)?path$/ }, () => ({ path: 'node:path', namespace: 'offline-search-stand-in' }));
            builder.onLoad({ filter: /.*/, namespace: 'offline-search-stand-in' }, () => ({ contents: PATH_STAND_IN, loader: 'js' }));
          },
        },
      ],
    });
  } catch (error) {
    const messages = (error.errors ?? []).map((message) => `${message.location?.file ?? '?'}: ${message.text}`);
    throw new GuardFailure(`esbuild could not bundle ${specifier}:\n${messages.join('\n') || error.message}`);
  }
  const [output] = Object.values(result.metafile.outputs);
  const left = output.imports.map((record) => `${record.path} (${record.kind})`);
  if (left.length > 0) {
    // Name the files that asked for each one, from the inputs' import records.
    const askers = Object.entries(result.metafile.inputs).flatMap(([file, input]) =>
      input.imports.filter((record) => record.external).map((record) => `${file} imports ${record.path} (${record.kind})`),
    );
    throw new GuardFailure(`the bundle of ${specifier} still imports ${left.join(', ')}; the offline search closure must inline everything:\n${askers.join('\n')}`);
  }
  return { code: result.outputFiles[0].text, inputs: Object.keys(result.metafile.inputs).filter((input) => !input.startsWith('offline-search-stand-in:') && input !== 'offline-search-entry.mjs') };
}

/** Evaluate the bundle and search in a context with only the language built-ins. */
function sandboxSearch(code, bundleText, query) {
  const context = vm.createContext(Object.create(null), { name: 'offline search', codeGeneration: { strings: false, wasm: false } });
  // V8 gives every context an inspector-only console; it does no I/O, but nothing here needs it.
  vm.runInContext('delete globalThis.console', context);
  const present = ABSENT_GLOBALS.filter((name) => vm.runInContext(`typeof globalThis[${JSON.stringify(name)}] !== 'undefined'`, context));
  if (present.length > 0) throw new GuardFailure(`the sandbox is not empty: it has ${present.join(', ')}`);
  try {
    vm.runInContext(code, context, { filename: 'offline-search.bundle.js' });
  } catch (error) {
    throw new GuardFailure(`loading the bundle in the sandbox threw: ${error?.name}: ${error?.message}`);
  }
  // Primitives only: a host object would carry the host's Function constructor in.
  context.__bundleText = bundleText;
  context.__query = query;
  try {
    return JSON.parse(vm.runInContext(`JSON.stringify(${GLOBAL_NAME}.searchBundles([JSON.parse(__bundleText)], __query, ${LIMIT}))`, context, { filename: 'offline-search.query.js' }));
  } catch (error) {
    throw new GuardFailure(`searching in the sandbox threw: ${error?.name}: ${error?.message}`);
  }
}

async function directSearch(entry, from, bundleText, query) {
  const file = entry ?? createRequire(path.join(from, 'package.json')).resolve(SUBPATH);
  const { searchBundles } = await import(pathToFileURL(file).href);
  return searchBundles([JSON.parse(bundleText)], query, LIMIT);
}

async function main() {
  const { from, entry, positional } = parseArgs(process.argv.slice(2));
  const [bundleFile, query] = positional;
  let bundleText;
  try {
    bundleText = readFileSync(bundleFile, 'utf8');
    JSON.parse(bundleText);
  } catch (error) {
    usage(`cannot read the bundle ${bundleFile}: ${error.message}`);
  }
  try {
    const { code, inputs } = await bundle(entry, from);
    const results = sandboxSearch(code, bundleText, query);
    if (results.length === 0) throw new GuardFailure(`the sandboxed search for ${JSON.stringify(query)} returned nothing`);
    const direct = await directSearch(entry, from, bundleText, query);
    if (JSON.stringify(results) !== JSON.stringify(direct)) {
      throw new GuardFailure(`the sandboxed results differ from a normal import's:\nsandbox: ${JSON.stringify(results)}\ndirect:  ${JSON.stringify(direct)}`);
    }
    console.log(JSON.stringify({ entry: entry ?? SUBPATH, from, bytes: code.length, inputs, results }));
  } catch (error) {
    if (!(error instanceof GuardFailure)) throw error;
    console.error(`FAIL offline search: ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
