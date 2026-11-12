import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { BIN, FIXTURES, commitAll, fixtureRepo, runCli } from './helpers.mjs';
import { bundleFromCheckout } from '../src/bundle.mjs';
import { bundleShapeError, searchBundles, staticSource } from '../src/mcp.mjs';
import { stem } from '../src/search.mjs';

/** The lexicon fixture built by the real builder, as `build` and `mcp --repo` assemble it. */
function lexicon(t) {
  const dir = fixtureRepo(t, 'search-lexicon');
  return { dir, bundle: bundleFromCheckout(dir) };
}

const ROW_KEYS = ['product', 'kind', 'name', 'title', 'source', 'headings', 'url', 'sha', 'score', 'snippet'];

test('a table row that names a key is found by its bare name, as a part of its own', (t) => {
  const { bundle } = lexicon(t);
  const [top] = searchBundles([bundle], 'pollIntervalMs');
  assert.deepEqual(Object.keys(top), ROW_KEYS);
  assert.equal(top.kind, 'row');
  assert.equal(top.name, 'pollIntervalMs');
  assert.equal(top.source, 'docs/reference.md');
  assert.deepEqual(top.headings, ['Reference', 'Settings']);
  assert.equal(top.url, 'https://kontourai.github.io/lexicon/docs/reference.html#settings');
  assert.equal(top.sha, bundle.sha);
  assert.equal(top.snippet, '`pollIntervalMs` · Meaning: How often the watcher looks again, in milliseconds.');

  // The name typed as words reaches the same row.
  assert.equal(searchBundles([bundle], 'poll interval')[0].name, 'pollIntervalMs');
  // Its own row outranks the row that only mentions it.
  assert.equal(searchBundles([bundle], 'retainDays')[0].name, 'retainDays');
  // A command row is named by its whole code span; a row without one is no part.
  assert.equal(searchBundles([bundle], 'lexicon prune')[0].name, 'lexicon prune');
  assert.ok(!searchBundles([bundle], 'plain cell', 50).some((result) => result.kind === 'row'));
});

test('a document passage under a topic is returned as the topic, not again as the document', (t) => {
  const { bundle } = lexicon(t);
  const results = searchBundles([bundle], 'how often the watcher looks again', 50);
  assert.ok(results.some((result) => result.kind === 'topic' && result.id === 'settings'));
  assert.ok(!results.some((result) => result.kind === 'document' && result.source === 'docs/reference.md'), JSON.stringify(results, null, 2));
  // Its passages outside the topic still find the document.
  assert.equal(searchBundles([bundle], 'every command it has')[0].source, 'docs/reference.md');
});

test('stemming is symmetric: subscribe, subscribes, subscribed and subscribing find each other', (t) => {
  for (const word of ['subscribe', 'subscribes', 'subscribed', 'subscribing']) assert.equal(stem(word), 'subscrib', word);
  const { bundle } = lexicon(t);
  for (const query of ['subscribed', 'subscribes']) assert.equal(searchBundles([bundle], query)[0].source, 'docs/guide.md', query);
});

test('a product\'s own synonyms reach its bundle at half weight, and only its bundle', (t) => {
  const { bundle } = lexicon(t);
  assert.deepEqual(bundle.synonyms, [['quokka', 'marsupial']], 'build copies corpus.json synonyms into the bundle');
  const [hit] = searchBundles([bundle], 'quokka');
  assert.equal(hit.source, 'docs/guide.md');
  assert.match(hit.snippet, /marsupial/);
  const direct = searchBundles([bundle], 'marsupial')[0];
  assert.ok(hit.score < direct.score, `a synonym counts less than the word itself (${hit.score} vs ${direct.score})`);

  const { synonyms, ...without } = structuredClone(bundle);
  assert.deepEqual(searchBundles([without], 'quokka'), [], 'without the group nothing says quokka');
  const other = { ...structuredClone(without), product: 'other' };
  assert.ok(!searchBundles([bundle, other], 'quokka').some((result) => result.product === 'other'), 'one product\'s group does not reach another');
});

test('suite-wide synonyms join a newcomer\'s word to the docs\' word', (t) => {
  const { bundle } = lexicon(t);
  // "erase" is in the suite's delete group with "remove"; the docs only say "removed" and "Removes".
  assert.doesNotMatch(JSON.stringify(bundle), /erase/i);
  const [top] = searchBundles([bundle], 'erase');
  assert.ok(top, 'erase finds the rows that say remove');
  assert.equal(top.kind, 'row');
  assert.match(top.snippet, /[Rr]emove/);
});

test('a bundle without synonyms or row-era fields, schema v1 included, still loads and gets row parts', (t) => {
  const { bundle } = lexicon(t);
  const v1 = structuredClone(bundle);
  for (const key of ['purpose', 'builtOn', 'synonyms']) delete v1[key];
  v1.schemaVersion = 1;
  for (const document of v1.documents) {
    delete document.repoPath;
    delete document.lineOffset;
  }
  assert.equal(bundleShapeError(v1), null);
  const source = staticSource([v1]);
  return source.load().then((loaded) => {
    const [top] = searchBundles([...loaded.bundles.values()], 'retainDays');
    assert.equal(top.kind, 'row');
    assert.equal(top.name, 'retainDays');
  });
});

test('a malformed bundle synonyms value is refused', (t) => {
  const { bundle } = lexicon(t);
  assert.equal(bundleShapeError(bundle), null);
  const cases = [
    ['quokka', /bundle synonyms must be an array of synonym groups/],
    [[['quokka']], /bundle synonyms\[0\] must be an array of at least two words/],
    [[['cron job', 'schedule']], /bundle synonyms\[0\] has "cron job"; each entry must be one word/],
    [[['Quokka', 'quokka']], /bundle synonyms\[0\] lists a word more than once/],
  ];
  for (const [synonyms, message] of cases) assert.match(bundleShapeError({ ...bundle, synonyms }) ?? '', message, JSON.stringify(synonyms));
});

test('check refuses a corpus.json synonyms entry that is not one word (exit 2)', async (t) => {
  const dir = fixtureRepo(t, 'search-lexicon');
  const manifest = JSON.parse(readFileSync(path.join(dir, 'corpus.json'), 'utf8'));
  writeFileSync(path.join(dir, 'corpus.json'), `${JSON.stringify({ ...manifest, synonyms: [['cron job', 'schedule']] }, null, 2)}\n`);
  commitAll(dir, 'phrase synonym');
  const refused = await runCli(['check', '--root', dir]);
  assert.equal(refused.status, 2, refused.output);
  assert.match(refused.output, /corpus\.json: synonyms\[0\] has "cron job"; each entry must be one word of letters and digits/);

  writeFileSync(path.join(dir, 'corpus.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  commitAll(dir, 'restore');
  const accepted = await runCli(['check', '--root', dir]);
  assert.equal(accepted.status, 0, accepted.output);
});

test('a bundle built without synonyms has no synonyms key, so its JSON is unchanged', (t) => {
  const bundle = bundleFromCheckout(fixtureRepo(t, 'valid'));
  assert.equal(Object.hasOwn(bundle, 'synonyms'), false);
});

test('mcp search returns row results over a published bundle, with the result shape unchanged for topics and documents', async (t) => {
  const file = path.join(FIXTURES, 'search-bundles', 'corpus.docs-bundle.json');
  const published = JSON.parse(readFileSync(file, 'utf8'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp', '--bundle', file], stderr: 'pipe' });
  const client = new Client({ name: 'corpus-search-test', version: '0.0.0' });
  await client.connect(transport);
  t.after(() => client.close());
  const search = async (query) => JSON.parse((await client.callTool({ name: 'search', arguments: { query, limit: 50 } })).content[0].text);

  const rows = await search('allowLocalPaths');
  const [top] = rows.results;
  assert.deepEqual(Object.keys(top), ROW_KEYS);
  assert.equal(top.name, 'allowLocalPaths');
  assert.equal(top.source, 'README.md');
  assert.equal(top.sha, published.sha);
  assert.equal(top.url, 'https://kontourai.github.io/corpus/index.html#manifest-reference');

  const mixed = await search('freshness gate');
  const topic = mixed.results.find((result) => result.kind === 'topic');
  const document = mixed.results.find((result) => result.kind === 'document');
  assert.deepEqual(Object.keys(topic), ['product', 'kind', 'id', 'title', 'source', 'url', 'sha', 'score', 'snippet']);
  assert.deepEqual(Object.keys(document), ['product', 'kind', 'title', 'source', 'url', 'sha', 'score', 'snippet']);
  for (const result of mixed.results) assert.equal(typeof result.score, 'number');
});

test('search needs no network: hub-shaped bundles are searched with fetch unavailable', (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('search must not fetch');
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const bundle = JSON.parse(readFileSync(path.join(FIXTURES, 'search-bundles', 'cli.docs-bundle.json'), 'utf8'));
  assert.equal(searchBundles([bundle], 'ROUTER_PRODUCT_MISSING')[0].name, 'ROUTER_PRODUCT_MISSING');
});
