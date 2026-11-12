// The `@kontourai/corpus/search` entry: ranked search over docs bundles that a
// host already holds in memory, for embedding where the root entry cannot go.
//
// Everything this module imports, directly or through other Corpus files, must
// stay free of file, network, and process access, both when it is loaded and
// when it searches: hosts bundle it into offline, credential-free servers.
// test/search-subpath.test.mjs walks this import graph and imports the subpath
// with the file system, child processes, and fetch disabled.
//
// Only `searchBundles` is public here; the rest of src/search.mjs is internal
// to the MCP server and the manifest gate.
export { searchBundles } from './search.mjs';
