import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { BIN, REPO_ROOT, commitAll, fixtureRepo, git, runCli, scratch } from './helpers.mjs';
import { createCheckoutCache, hubSource } from '../src/mcp.mjs';
import { bundleFromCheckout } from '../src/bundle.mjs';

const VERSION = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;

/** Spawn `docs-kit mcp <args>` and connect the SDK client over stdio. */
async function connect(t, args) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp', ...args], stderr: 'pipe' });
  const client = new Client({ name: 'docs-kit-test', version: '0.0.0' });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return { isError: Boolean(result.isError), data: JSON.parse(result.content[0].text) };
}

test('mcp --repo serves list_topics, get_topic, get_document and search with the source sha', async (t) => {
  const repo = fixtureRepo(t, 'valid', { as: 'sample' });
  const sha = git(repo, ['rev-parse', 'HEAD']);
  const client = await connect(t, ['--repo', repo]);

  assert.deepEqual(client.getServerVersion(), { name: 'corpus', version: VERSION });
  const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(tools, ['get_document', 'get_topic', 'list_products', 'list_topics', 'locate', 'search']);

  const products = await call(client, 'list_products');
  assert.deepEqual(products.data.products, [
    {
      product: 'sample',
      title: 'Sample',
      tagline: 'A fixture product for docs-kit tests',
      sha,
      builtAt: products.data.products[0].builtAt,
      siteUrl: 'https://kontourai.github.io/sample/',
      topicCount: 4,
      docCount: 3,
      status: 'available',
    },
  ]);

  const topics = await call(client, 'list_topics', { product: 'sample' });
  assert.deepEqual(
    topics.data.topics.map(({ id, source, sha: topicSha }) => [id, source, topicSha]),
    [
      ['workflows', 'docs/concepts.md#workflows', sha],
      ['evidence-gates', 'docs/concepts.md#evidence-gates', sha],
      ['install', 'README.md#install', sha],
      ['getting-started', 'docs/getting-started.md', sha],
    ],
  );

  const topic = await call(client, 'get_topic', { product: 'sample', id: 'evidence-gates' });
  assert.equal(topic.isError, false);
  assert.equal(topic.data.sha, sha);
  assert.equal(topic.data.topic.url, 'https://kontourai.github.io/sample/docs/concepts.html#evidence-gates');
  assert.match(topic.data.topic.markdown, /^## Evidence gates\n\nA gate holds until the evidence arrives/);
  assert.doesNotMatch(topic.data.topic.markdown, /## Workflows|The `run`/);

  const document = await call(client, 'get_document', { product: 'sample', source: 'docs/reference/cli.md' });
  assert.equal(document.data.sha, sha);
  assert.equal(document.data.document.title, 'CLI reference');

  const search = await call(client, 'search', { query: 'zebra crossing' });
  assert.ok(search.data.results.length >= 1);
  const [top] = search.data.results;
  assert.equal(top.product, 'sample');
  assert.equal(top.kind, 'topic');
  assert.equal(top.id, 'evidence-gates');
  assert.equal(top.source, 'docs/concepts.md#evidence-gates');
  assert.equal(top.url, 'https://kontourai.github.io/sample/docs/concepts.html#evidence-gates');
  assert.equal(top.sha, sha);
  assert.match(top.snippet, /zebra-crossing/);

  const limited = await call(client, 'search', { query: 'workflow', limit: 1 });
  assert.equal(limited.data.results.length, 1);

  const missing = await call(client, 'get_topic', { product: 'sample', id: 'nope' });
  assert.equal(missing.isError, true);
  assert.match(missing.data.error, /unknown topic "nope"/);
  assert.ok(missing.data.availableTopics.includes('workflows'));

  const unknownProduct = await call(client, 'list_topics', { product: 'flow' });
  assert.equal(unknownProduct.isError, true);
  assert.match(unknownProduct.data.error, /unknown product "flow"/);
});

test('mcp --workspace serves every subdirectory with docs-kit.json and reports broken ones', async (t) => {
  const workspace = scratch(t);
  fixtureRepo(t, 'valid', { into: workspace, as: 'sample' });
  fixtureRepo(t, 'second', { into: workspace });
  fixtureRepo(t, 'schema-v2', { into: workspace, as: 'broken' });
  const client = await connect(t, ['--workspace', workspace]);

  const products = await call(client, 'list_products');
  const byProduct = Object.fromEntries(products.data.products.map((entry) => [entry.product, entry]));
  assert.equal(byProduct.sample.status, 'available');
  assert.equal(byProduct.second.status, 'available');
  assert.equal(byProduct['schema-v2'].status, 'unavailable', 'keyed by the manifest product, not the directory');
  assert.equal(byProduct['schema-v2'].directory, 'broken');
  assert.match(byProduct['schema-v2'].error, /missing required key "purpose"/);

  const search = await call(client, 'search', { query: 'quokka' });
  assert.equal(search.data.results[0].product, 'second');
  assert.equal(search.data.results[0].id, 'telemetry');

  const all = await call(client, 'list_topics');
  assert.deepEqual([...new Set(all.data.topics.map((topic) => topic.product))].sort(), ['sample', 'second']);
  assert.equal(all.data.unavailable[0].product, 'schema-v2');
});

test('mcp --hub fetches products.json and bundles, reporting a 404 product as unavailable', async (t) => {
  const workspace = scratch(t);
  const sample = fixtureRepo(t, 'valid', { into: workspace, as: 'sample' });
  const site = path.join(workspace, 'site');
  const build = await runCli(['build', '--root', sample, '--out', site]);
  assert.equal(build.status, 0, build.output);
  const bundleText = readFileSync(path.join(site, 'docs-bundle.json'), 'utf8');
  const sha = JSON.parse(bundleText).sha;

  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    const routes = {
      '/products.json': JSON.stringify({
        schemaVersion: 1,
        products: [
          { product: 'sample', repo: 'kontourai/sample' },
          { product: 'ghost', repo: 'kontourai/ghost' },
          { product: 'mangled', repo: 'kontourai/mangled' },
        ],
      }),
      '/sample/docs-bundle.json': bundleText,
      // Valid top level, malformed entries: must become unavailable, never throw inside a tool.
      '/mangled/docs-bundle.json': JSON.stringify({ ...JSON.parse(bundleText), product: 'mangled', documents: [{ source: 7 }], topics: [null] }),
    };
    if (routes[request.url]) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(routes[request.url]);
    } else {
      response.writeHead(404);
      response.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const hub = `http://127.0.0.1:${server.address().port}/`;
  const client = await connect(t, ['--hub', hub]);

  const products = await call(client, 'list_products');
  const byProduct = Object.fromEntries(products.data.products.map((entry) => [entry.product, entry]));
  assert.equal(byProduct.sample.status, 'available');
  assert.equal(byProduct.sample.sha, sha);
  assert.equal(byProduct.ghost.status, 'unavailable');
  assert.match(byProduct.ghost.error, /ghost\/docs-bundle\.json -> HTTP 404/);

  const topic = await call(client, 'get_topic', { product: 'sample', id: 'workflows' });
  assert.equal(topic.data.sha, sha);
  assert.match(topic.data.topic.markdown, /^## Workflows/);

  const ghost = await call(client, 'get_topic', { product: 'ghost', id: 'x' });
  assert.equal(ghost.isError, true);
  assert.match(ghost.data.error, /product "ghost" is unavailable/);

  assert.equal(byProduct.mangled.status, 'unavailable');
  assert.match(byProduct.mangled.error, /documents\[0\]\.source must be a string/);

  const search = await call(client, 'search', { query: 'evidence' });
  assert.equal(search.isError, false);
  assert.ok(search.data.results.every((result) => result.product === 'sample' && result.sha === sha));
  assert.deepEqual(search.data.unavailable.map((entry) => entry.product).sort(), ['ghost', 'mangled']);
  const mangledTopics = await call(client, 'list_topics', { product: 'mangled' });
  assert.equal(mangledTopics.isError, true);
  assert.match(mangledTopics.data.error, /product "mangled" is unavailable/);

  assert.equal(requests.filter((url) => url === '/products.json').length, 1, 'the snapshot is cached between calls');
});

test('mcp refuses more than one source and an invalid --repo (exit 2)', async (t) => {
  const both = await runCli(['mcp', '--repo', '.', '--hub', 'https://kontourai.github.io/']);
  assert.equal(both.status, 2, both.output);
  assert.match(both.stderr, /exactly one source/);
  const invalid = await runCli(['mcp', '--repo', fixtureRepo(t, 'schema-v2')]);
  assert.equal(invalid.status, 2, invalid.output);
  assert.match(invalid.stderr, /missing required key "purpose"/);
  const empty = await runCli(['mcp', '--workspace', scratch(t)]);
  assert.equal(empty.status, 2, empty.output);
  assert.match(empty.stderr, /no immediate subdirectory contains docs-kit\.json/);
});

test('mcp --repo includes the landing page, rebuilds on every call, and flags a dirty tree', async (t) => {
  const repo = fixtureRepo(t, 'valid', { as: 'sample' });
  const sha = git(repo, ['rev-parse', 'HEAD']);
  const client = await connect(t, ['--repo', repo]);

  const landing = await call(client, 'get_document', { product: 'sample', source: 'README.md' });
  assert.equal(landing.isError, false);
  assert.equal(landing.data.document.landing, true);
  assert.equal(landing.data.document.section, null);
  assert.equal(landing.data.dirty, undefined, 'a clean checkout carries no dirty flag');

  appendFileSync(path.join(repo, 'docs', 'concepts.md'), '\nThe pangolin protocol was added mid-session.\n');
  const search = await call(client, 'search', { query: 'pangolin' });
  assert.equal(search.data.results[0].source, 'docs/concepts.md', 'edits are visible without restarting');
  assert.equal(search.data.results[0].sha, sha);
  assert.equal(search.data.results[0].dirty, true);
  const products = await call(client, 'list_products');
  assert.equal(products.data.products[0].dirty, true);
  assert.equal(products.data.products[0].docCount, 3, 'docCount excludes the landing page');

  commitAll(repo, 'commit the edit');
  const after = await call(client, 'get_topic', { product: 'sample', id: 'workflows' });
  assert.equal(after.data.sha, git(repo, ['rev-parse', 'HEAD']));
  assert.equal(after.data.dirty, undefined);
});

test('mcp --workspace marks every directory that declares the same product unavailable', async (t) => {
  const workspace = scratch(t);
  fixtureRepo(t, 'valid', { into: workspace, as: 'sample' });
  fixtureRepo(t, 'valid', { into: workspace, as: 'sample-copy' });
  fixtureRepo(t, 'second', { into: workspace });
  const client = await connect(t, ['--workspace', workspace]);
  const products = (await call(client, 'list_products')).data.products;
  const sample = products.filter((entry) => entry.product === 'sample');
  assert.equal(sample.length, 2);
  for (const entry of sample) {
    assert.equal(entry.status, 'unavailable');
    assert.match(entry.error, /product "sample" is declared by more than one directory \(sample, sample-copy\)/);
  }
  assert.deepEqual(sample.map((entry) => entry.directory).sort(), ['sample', 'sample-copy']);
  assert.equal(products.find((entry) => entry.product === 'second').status, 'available');
});

// Library seam with an injected clock: the 30-second retry window cannot be
// exercised through the CLI without a 30-second test.
test('hub cache retries failed and malformed fetches after the short negative TTL but keeps successes for 10 minutes', async () => {
  let clock = 0;
  let ghostUp = false;
  const calls = [];
  const bundle = (product) => ({ schemaVersion: 1, product, title: product, tagline: '', repo: `kontourai/${product}`, sha: 'abc', builtAt: 'x', siteUrl: 'u', digest: 'd', documents: [], topics: [] });
  const fetchImpl = async (url) => {
    calls.push(new URL(url).pathname);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    if (url.endsWith('/products.json'))
      return ok({ schemaVersion: 1, products: [{ product: 'sample', repo: 'kontourai/sample' }, { product: 'ghost', repo: 'kontourai/ghost' }, { product: 'mangled', repo: 'kontourai/mangled' }] });
    if (url.endsWith('/sample/docs-bundle.json')) return ok(bundle('sample'));
    if (url.endsWith('/ghost/docs-bundle.json') && ghostUp) return ok(bundle('ghost'));
    if (url.endsWith('/mangled/docs-bundle.json')) return ok(ghostUp ? bundle('mangled') : { ...bundle('mangled'), documents: [{ source: 1 }] });
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const source = hubSource('http://hub.test/', { fetchImpl, now: () => clock });

  let loaded = await source.load();
  assert.deepEqual([...loaded.bundles.keys()], ['sample']);
  assert.deepEqual(loaded.unavailable.map((entry) => entry.product), ['ghost', 'mangled']);
  assert.match(loaded.unavailable[1].error, /documents\[0\]\.source must be a string/);

  ghostUp = true;
  clock = 10_000;
  loaded = await source.load();
  assert.equal(loaded.unavailable.length, 2, 'inside the 30 s window both failures are still cached');

  clock = 31_000;
  loaded = await source.load();
  assert.deepEqual([...loaded.bundles.keys()].sort(), ['ghost', 'mangled', 'sample'], 'a 404 and a malformed bundle are both retried after 30 s');
  assert.equal(calls.filter((call) => call === '/sample/docs-bundle.json').length, 1, 'successes stay cached');
  assert.equal(calls.filter((call) => call === '/products.json').length, 1);
});

test('mcp --workspace rebuilds a product only when its checkout changes', async (t) => {
  const workspace = scratch(t);
  const sample = fixtureRepo(t, 'valid', { into: workspace, as: 'sample' });
  fixtureRepo(t, 'second', { into: workspace });
  const client = await connect(t, ['--workspace', workspace]);
  const builtAt = async () => Object.fromEntries((await call(client, 'list_products')).data.products.map((entry) => [entry.product, entry.builtAt]));

  const first = await builtAt();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await builtAt(), first, 'unchanged checkouts are served from the cache');

  appendFileSync(path.join(sample, 'docs', 'concepts.md'), '\nFirst edit: the axolotl.\n');
  const afterEdit = await builtAt();
  assert.notEqual(afterEdit.sample, first.sample, 'an edit rebuilds the changed product');
  assert.equal(afterEdit.second, first.second, 'other products stay cached');

  // A second edit to an already-modified file leaves `git status --porcelain` unchanged.
  await new Promise((resolve) => setTimeout(resolve, 20));
  appendFileSync(path.join(sample, 'docs', 'concepts.md'), '\nSecond edit: the narwhal.\n');
  const search = await call(client, 'search', { query: 'narwhal' });
  assert.equal(search.data.results[0]?.source, 'docs/concepts.md');
});

// Library seam: the race (an edit landing while a bundle builds) cannot be
// timed deterministically through the CLI, so the builder simulates it.
test('checkout cache keys before building, so an edit during a build is picked up next call', async (t) => {
  const repo = fixtureRepo(t, 'valid');
  const concepts = path.join(repo, 'docs', 'concepts.md');
  let editDuringBuild = true;
  const cache = createCheckoutCache((root) => {
    const bundle = bundleFromCheckout(root);
    if (editDuringBuild) {
      editDuringBuild = false;
      appendFileSync(concepts, '\nEdited mid-build: the okapi.\n');
    }
    return bundle;
  });
  const first = cache(repo);
  assert.ok(!first.documents.some((document) => document.markdown.includes('okapi')));
  const second = cache(repo);
  assert.ok(second.documents.some((document) => document.markdown.includes('okapi')), 'the mid-build edit is not hidden by a post-edit cache key');
  assert.equal(cache(repo), second, 'and the rebuilt bundle is then cached');
});

 test('mcp serves v2 purpose and building blocks through list_products', async (t) => {
  const repo = fixtureRepo(t, 'corpus-v2');
  const client = await connect(t, ['--repo', repo]);
  const first = await call(client, 'list_products');
  assert.equal(first.isError, false);
  assert.equal(first.data.products[0].purpose, 'Serve source-bound documentation.');
  assert.deepEqual(first.data.products[0].builtOn, []);
  const file = path.join(repo, 'corpus.json');
  const raw = JSON.parse(readFileSync(file));
  raw.builtOn = [{ product: 'knowledge', via: ['knowledge', 'knowledge-query'], for: 'Read source records', evidence: 'cli' }];
  writeFileSync(file, JSON.stringify(raw));
  const changed = await call(client, 'list_products');
  assert.deepEqual(changed.data.products[0].builtOn, raw.builtOn);
});
