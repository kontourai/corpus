import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { BIN, REPO_ROOT, fixtureRepo, git, runCli, scratch } from './helpers.mjs';

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

  assert.deepEqual(client.getServerVersion(), { name: 'docs-kit', version: VERSION });
  const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(tools, ['get_document', 'get_topic', 'list_products', 'list_topics', 'search']);

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
  assert.equal(byProduct.broken.status, 'unavailable');
  assert.match(byProduct.broken.error, /schemaVersion must be exactly 1/);

  const search = await call(client, 'search', { query: 'quokka' });
  assert.equal(search.data.results[0].product, 'second');
  assert.equal(search.data.results[0].id, 'telemetry');

  const all = await call(client, 'list_topics');
  assert.deepEqual([...new Set(all.data.topics.map((topic) => topic.product))].sort(), ['sample', 'second']);
  assert.equal(all.data.unavailable[0].product, 'broken');
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
      '/products.json': JSON.stringify({ schemaVersion: 1, products: [{ product: 'sample', repo: 'kontourai/sample' }, { product: 'ghost', repo: 'kontourai/ghost' }] }),
      '/sample/docs-bundle.json': bundleText,
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

  const search = await call(client, 'search', { query: 'evidence' });
  assert.ok(search.data.results.every((result) => result.product === 'sample' && result.sha === sha));
  assert.equal(search.data.unavailable[0].product, 'ghost');

  assert.equal(requests.filter((url) => url === '/products.json').length, 1, 'the snapshot is cached between calls');
});

test('mcp refuses more than one source and an invalid --repo (exit 2)', async (t) => {
  const both = await runCli(['mcp', '--repo', '.', '--hub', 'https://kontourai.github.io/']);
  assert.equal(both.status, 2, both.output);
  assert.match(both.stderr, /exactly one source/);
  const invalid = await runCli(['mcp', '--repo', fixtureRepo(t, 'schema-v2')]);
  assert.equal(invalid.status, 2, invalid.output);
  assert.match(invalid.stderr, /schemaVersion must be exactly 1/);
  const empty = await runCli(['mcp', '--workspace', scratch(t)]);
  assert.equal(empty.status, 2, empty.output);
  assert.match(empty.stderr, /no immediate subdirectory contains docs-kit\.json/);
});
