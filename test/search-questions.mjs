// Questions a newcomer would ask, in their own words rather than the docs'
// terms, each with the part that answers it. A question passes when one of its
// `expect` parts ranks in the top 3 of a search over all four bundles in
// test/fixtures/search-bundles/. Each expected part was chosen by reading the
// docs, not by looking at what the ranking returned; a question lists more
// than one part only where each of them answers it on its own.
//
// A part is { product, kind, id } for a topic, { product, kind, source } for a
// document, and { product, kind, source, name } for a table row. Three
// questions name a further part that was added after a first run showed it,
// once reading it confirmed that it answers the question; each says why.

export const QUESTION_BUNDLES = ['corpus', 'station', 'flow', 'cli'];

export const QUESTIONS = [
  // Station
  { question: 'how do I run something on a cron job', expect: [{ product: 'station', kind: 'topic', id: 'scheduled-jobs' }] },
  { question: 'make the agent ask me before it runs a command', expect: [{ product: 'station', kind: 'document', source: 'docs/user/getting-started.md' }] },
  {
    question: 'where does station keep its data on my computer',
    expect: [
      { product: 'station', kind: 'topic', id: 'station-overview' },
      { product: 'station', kind: 'document', source: 'docs/user/concepts.md' },
    ],
  },
  {
    question: 'use a local model without an api key',
    expect: [
      { product: 'station', kind: 'topic', id: 'connections' },
      // "Choose A Model Connection Or Engine": "For a credential-free first path, use a supported local model service".
      { product: 'station', kind: 'document', source: 'docs/user/getting-started.md' },
    ],
  },
  { question: 'send someone a link to an answer', expect: [{ product: 'station', kind: 'document', source: 'docs/user/sharing-answers.md' }] },
  { question: 'the window never shows up when I open the desktop app', expect: [{ product: 'station', kind: 'document', source: 'docs/user/native-recovery.md' }] },
  {
    question: 'can the assistant install a plugin for me',
    expect: [
      { product: 'station', kind: 'topic', id: 'plugins' },
      { product: 'station', kind: 'topic', id: 'builtin-assistant' },
      { product: 'station', kind: 'topic', id: 'plugin-authoring' },
    ],
  },
  { question: 'turn on experimental features', expect: [{ product: 'station', kind: 'document', source: 'docs/user/settings.md' }] },
  { question: 'run models on the gpu of another machine', expect: [{ product: 'station', kind: 'topic', id: 'fleet' }] },
  { question: 'context-compaction', expect: [{ product: 'station', kind: 'row', source: 'docs/user/settings.md', name: 'context-compaction' }] },

  // Flow
  { question: 'stop claude code from finishing while gates are still open', expect: [{ product: 'flow', kind: 'topic', id: 'agent-hooks' }] },
  { question: 'where are runs stored on disk', expect: [{ product: 'flow', kind: 'topic', id: 'runtime-roots' }] },
  { question: 'untrusted_producer', expect: [{ product: 'flow', kind: 'row', source: 'docs/evidence.md', name: 'untrusted_producer' }] },
  {
    question: 'attach a screenshot as proof',
    expect: [
      { product: 'flow', kind: 'row', source: 'docs/evidence.md', name: 'file' },
      { product: 'flow', kind: 'topic', id: 'evidence-kinds' },
    ],
  },
  { question: 'upgrading to flow 5', expect: [{ product: 'flow', kind: 'topic', id: 'migrate-5' }] },

  // Corpus
  { question: 'set the base url of the generated site', expect: [{ product: 'corpus', kind: 'topic', id: 'build' }] },
  { question: 'warn me when a doc is out of date after the code changes', expect: [{ product: 'corpus', kind: 'topic', id: 'check' }] },
  { question: 'allowLocalPaths', expect: [{ product: 'corpus', kind: 'row', source: 'README.md', name: 'allowLocalPaths' }] },
  { question: 'get_topic', expect: [{ product: 'corpus', kind: 'row', source: 'README.md', name: 'get_topic' }] },
  { question: 'send old page urls to their new location', expect: [{ product: 'corpus', kind: 'row', source: 'README.md', name: 'redirects' }] },
  { question: 'write down an architecture decision', expect: [{ product: 'corpus', kind: 'topic', id: 'decisions' }] },

  // Kontour CLI
  {
    question: 'what does exit code 70 mean',
    expect: [
      { product: 'cli', kind: 'row', source: 'docs/reference.md', name: '70' },
      { product: 'cli', kind: 'topic', id: 'exit-codes' },
    ],
  },
  { question: 'ROUTER_PRODUCT_MISSING', expect: [{ product: 'cli', kind: 'row', source: 'docs/reference.md', name: 'ROUTER_PRODUCT_MISSING' }] },
  {
    question: 'see what kontour init would change without writing anything',
    expect: [
      { product: 'cli', kind: 'row', source: 'docs/reference.md', name: '--plan' },
      { product: 'cli', kind: 'topic', id: 'init-options' },
      // "Plan performs no product delegation and writes nothing".
      { product: 'cli', kind: 'topic', id: 'init-consent' },
    ],
  },
  {
    question: 'how does kontour find the products I installed',
    expect: [
      { product: 'cli', kind: 'topic', id: 'discovery' },
      // "The router looks for each product package in one place: the `node_modules` directory that holds the installed `@kontourai/cli`".
      { product: 'cli', kind: 'topic', id: 'install' },
      // "Installed discovery and explicit product roots": "the router uses Node package resolution anchored at the installed `@kontourai/cli` package".
      { product: 'cli', kind: 'document', source: 'docs/kontour-cli-router.md' },
    ],
  },
];

/**
 * Questions the ranking does not yet answer in the top 3, kept with the part
 * that answers them so a later change can be measured against them. The test
 * reports their ranks and does not assert them. Each misses for a reason
 * named beside it.
 */
export const OPEN_QUESTIONS = [
  // Seven words, none of them "route-back"; long passages that share more of the words outrank it.
  { question: 'what happens when a check fails and the work goes back to an earlier step', expect: [{ product: 'flow', kind: 'topic', id: 'route-back' }] },
  // The answer says "required check" and "exits non-zero", not fail, build or pass; Corpus's own "build" pages outrank it.
  { question: 'fail the ci build when a gate has not passed', expect: [{ product: 'flow', kind: 'topic', id: 'agent-hooks' }] },
  // The docs say "accepted exception"; nothing joins "move past ... anyway" to it.
  { question: 'move past a failing gate anyway and record why', expect: [{ product: 'flow', kind: 'document', source: 'docs/gates-and-route-back.md' }] },
  // The docs say "trusted producers"; the stemmer leaves "producer" and "produce" apart.
  { question: 'who is allowed to produce evidence for a claim', expect: [{ product: 'flow', kind: 'topic', id: 'project-config' }] },
  // Across all products, Station's pages about Claude Code outrank Corpus's MCP section.
  { question: 'connect my docs to claude code', expect: [{ product: 'corpus', kind: 'topic', id: 'mcp-server' }] },
  // The docs say `"publish": false` and "not published as a web page"; "keep" and "leave off" reach neither.
  { question: 'keep a doc for agents but leave it off the website', expect: [{ product: 'corpus', kind: 'topic', id: 'manifest' }] },
];

/**
 * Questions an independent reviewer of #86 wrote down, each with its answer
 * topic, after reading the topics and before running either ranking. They are
 * reported and never asserted: QUESTIONS above were curated while the ranking
 * was being built, so passing all of them is a regression fixture, not an
 * unbiased measure of relevance. These are the closer thing to a blind
 * holdout. At review, origin/main put 2 of 16 in the top 3, and #86 put 5.
 * Leave them as written; a question rewritten to pass measures nothing.
 */
export const FRESH_QUESTIONS = [
  ['corpus', 'check', 'can I catch dead links before I publish'],
  ['corpus', 'manifest', 'how can I hide an internal guide from the public site'],
  ['corpus', 'decisions', 'are old numbered ADRs allowed to change'],
  ['corpus', 'mcp-server', 'can I serve documentation directly from a local checkout'],
  ['station', 'tasks', 'how do I turn a chat into a tracked task'],
  ['station', 'skills', 'how can I teach the assistant a repeatable procedure'],
  ['station', 'fleet', 'can two installations share one inference server'],
  ['station', 'tool-servers', 'how do I give an agent access to tools from an external service'],
  ['flow', 'gate-evaluation', 'does one failed evidence item block the gate'],
  ['flow', 'evidence-kinds', 'how can I prove a command exited successfully'],
  ['flow', 'route-back', 'can a failed review send work back for revision'],
  ['flow', 'runtime-roots', 'how do I undo moving my runs to the new folders'],
  ['cli', 'delegation', 'does the router preserve stdin when launching a product'],
  ['cli', 'descriptors', 'can a broken product descriptor fall back to the built in catalog'],
  ['cli', 'init-consent', 'if setup fails halfway does it roll back the earlier commands'],
  ['cli', 'compat-catalog', 'where do command descriptions come from for packages with no descriptor'],
].map(([product, id, question]) => ({ question, expect: [{ product, kind: 'topic', id }] }));

/** True when a search result is the expected part. */
export function isExpected(result, part) {
  if (result.product !== part.product || result.kind !== part.kind) return false;
  if (part.kind === 'topic') return result.id === part.id;
  if (part.kind === 'document') return result.source === part.source;
  return result.source === part.source && result.name === part.name;
}

/** Rank of the first expected part in `results` (1-based), or null. */
export function expectedRank(results, expect) {
  const index = results.findIndex((result) => expect.some((part) => isExpected(result, part)));
  return index === -1 ? null : index + 1;
}
