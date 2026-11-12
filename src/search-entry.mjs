// The `@kontourai/corpus/search` entry: ranked search over docs bundles that a
// host already holds in memory, for embedding where the root entry cannot go.
//
// Everything this module imports, directly or through other Corpus files or
// packages, must stay free of file, network, process, and timer access, both
// when it is loaded and when it searches: hosts bundle it into offline,
// credential-free servers. scripts/check-offline-search.mjs (run by npm test
// and verify:pack) bundles this entry, refuses any import left in the bundle,
// and searches with it in a vm context that has only the language built-ins.
//
// Only `searchBundles` is public here; the rest of src/search.mjs is internal
// to the MCP server and the manifest gate.
export { searchBundles } from './search.mjs';
