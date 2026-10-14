import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { BIN, fixtureRepo, git, scratch } from './helpers.mjs';
import { gitEnv } from '../src/git.mjs';
import { bundleDigest, bundleFromCheckout } from '../src/bundle.mjs';
import { bundleShapeError, staticSource } from '../src/mcp.mjs';

async function connect(t, args) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp', ...args], stderr: 'pipe' });
  const client = new Client({ name: 'corpus-static-test', version: '0.0.0' });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

/**
 * `corpus mcp <args>` with stdin closed at once. A refused source exits 2
 * before reading stdin; if a refusal regresses, the server starts, sees EOF,
 * and exits 0, so the assertion fails instead of the test hanging.
 */
function runMcpClosed(args) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [BIN, 'mcp', ...args], { env: gitEnv(), encoding: 'utf8', timeout: 30_000 }, (error, stdout, stderr) => {
      const status = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
      resolve({ status, stdout, stderr, output: `${stdout}\n${stderr}` });
    });
    child.stdin.end();
  });
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return { isError: Boolean(result.isError), data: JSON.parse(result.content[0].text) };
}

/**
 * The real bundle `build` writes for the `valid` fixture, with hierarchy
 * fields added the way a host generator would: evidence-gates under
 * workflows, a tag and a summary whose words appear nowhere else.
 */
function hierarchyBundle(t, { as = 'sample' } = {}) {
  const repo = fixtureRepo(t, 'valid', { as });
  const bundle = bundleFromCheckout(repo);
  const topic = (id) => bundle.topics.find((entry) => entry.id === id);
  topic('workflows').tags = ['process'];
  topic('workflows').summary = 'How runs move through a workflow.';
  topic('evidence-gates').parentId = 'workflows';
  topic('evidence-gates').tags = ['wombatgate'];
  topic('evidence-gates').summary = 'Holds a run until platypusrule evidence arrives.';
  topic('install').parentId = 'getting-started';
  return { repo, bundle, sha: git(repo, ['rev-parse', 'HEAD']) };
}

function writeBundle(t, bundle, name = 'docs-bundle.json') {
  const file = path.join(scratch(t), name);
  writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`);
  return file;
}

test('mcp --bundle serves a prebuilt bundle with its topic hierarchy, read once at startup', async (t) => {
  const { bundle, sha } = hierarchyBundle(t);
  const file = writeBundle(t, bundle);
  const client = await connect(t, ['--bundle', file]);

  const products = await call(client, 'list_products');
  assert.deepEqual(
    products.data.products.map(({ product, sha: productSha, status, topicCount }) => ({ product, sha: productSha, status, topicCount })),
    [{ product: 'sample', sha, status: 'available', topicCount: 4 }],
  );

  const all = await call(client, 'list_topics', { product: 'sample' });
  const byId = Object.fromEntries(all.data.topics.map((topic) => [topic.id, topic]));
  assert.deepEqual(
    { parentId: byId['evidence-gates'].parentId, tags: byId['evidence-gates'].tags, summary: byId['evidence-gates'].summary },
    { parentId: 'workflows', tags: ['wombatgate'], summary: 'Holds a run until platypusrule evidence arrives.' },
  );
  assert.equal(Object.hasOwn(byId.workflows, 'parentId'), false, 'a root topic has no parentId');
  assert.equal(Object.hasOwn(byId['getting-started'], 'tags'), false, 'absent fields stay absent');

  const children = await call(client, 'list_topics', { parentId: 'workflows' });
  assert.deepEqual(children.data.topics.map((topic) => topic.id), ['evidence-gates']);
  const leaf = await call(client, 'list_topics', { product: 'sample', parentId: 'evidence-gates' });
  assert.deepEqual(leaf.data.topics, []);
  const unknownParent = await call(client, 'list_topics', { parentId: 'nope' });
  assert.equal(unknownParent.isError, true);
  assert.match(unknownParent.data.error, /unknown parent topic "nope"/);

  // Each word appears only in a tag or a summary, so a hit proves search reads that field.
  for (const query of ['wombatgate', 'platypusrule']) {
    const search = await call(client, 'search', { query });
    assert.equal(search.data.results.length, 1, `${query}: ${JSON.stringify(search.data)}`);
    assert.equal(search.data.results[0].id, 'evidence-gates');
    assert.equal(search.data.results[0].parentId, 'workflows');
    assert.equal(search.data.results[0].sha, sha);
  }

  const topic = await call(client, 'get_topic', { product: 'sample', id: 'evidence-gates' });
  assert.equal(topic.data.topic.parentId, 'workflows');
  assert.match(topic.data.topic.markdown, /^## Evidence gates/);

  const located = await call(client, 'locate', { product: 'sample', quote: 'A gate holds until the evidence arrives' });
  assert.equal(located.isError, false, JSON.stringify(located.data));
  assert.equal(located.data.source, 'docs/concepts.md');
  assert.equal(located.data.sha, sha);

  // Static: the file is not read again, so deleting it changes nothing.
  rmSync(file);
  const after = await call(client, 'get_topic', { product: 'sample', id: 'evidence-gates' });
  assert.equal(after.isError, false);
  assert.equal(after.data.topic.summary, 'Holds a run until platypusrule evidence arrives.');
});

test('mcp --bundle repeats for more products and refuses two bundles for one product (exit 2)', async (t) => {
  const first = writeBundle(t, hierarchyBundle(t).bundle, 'sample.json');
  const second = writeBundle(t, bundleFromCheckout(fixtureRepo(t, 'second')), 'second.json');
  const client = await connect(t, ['--bundle', first, '--bundle', second]);
  const products = await call(client, 'list_products');
  assert.deepEqual(products.data.products.map((entry) => entry.product).sort(), ['sample', 'second']);

  const duplicate = await runMcpClosed(['--bundle', first, '--bundle', first]);
  assert.equal(duplicate.status, 2, duplicate.output);
  assert.match(duplicate.stderr, /product "sample" is already served by --bundle /);
});

test('mcp --bundle refuses a malformed, dangling, cyclic, unreadable, or combined source (exit 2)', async (t) => {
  const { bundle } = hierarchyBundle(t);
  const variant = (edit) => {
    const copy = structuredClone(bundle);
    edit(copy.topics);
    return writeBundle(t, copy);
  };
  const cases = [
    [variant((topics) => (topics[0].parentId = 'missing')), /topics\[0\]\.parentId "missing" is not a topic id in this bundle/],
    [variant((topics) => (topics[0].parentId = 'evidence-gates')), /makes a cycle through "workflows"/],
    [variant((topics) => (topics[0].parentId = 'workflows')), /topics\[0\]\.parentId "workflows" makes a cycle/],
    [variant((topics) => (topics[1].tags = ['ok', ''])), /topics\[1\]\.tags must be an array of non-empty strings/],
    [variant((topics) => (topics[1].summary = 7)), /topics\[1\]\.summary must be a string/],
    [variant((topics) => (topics[1].parentId = '')), /topics\[1\]\.parentId must be a non-empty string/],
  ];
  for (const [file, message] of cases) {
    const result = await runMcpClosed(['--bundle', file]);
    assert.equal(result.status, 2, result.output);
    assert.match(result.stderr, message);
    assert.match(result.stderr, /--bundle /, 'the error names the bundle');
  }

  const notJson = path.join(scratch(t), 'bad.json');
  writeFileSync(notJson, '{');
  const invalid = await runMcpClosed(['--bundle', notJson]);
  assert.equal(invalid.status, 2, invalid.output);
  assert.match(invalid.stderr, /invalid JSON/);

  const missing = await runMcpClosed(['--bundle', path.join(scratch(t), 'absent.json')]);
  assert.equal(missing.status, 2, missing.output);
  assert.match(missing.stderr, /ENOENT/);

  const blank = await runMcpClosed(['--bundle', notJson, '--bundle', ' ']);
  assert.equal(blank.status, 2, blank.output);
  assert.match(blank.stderr, /--bundle needs a value/);

  const combined = await runMcpClosed(['--bundle', notJson, '--hub', 'https://kontourai.github.io/']);
  assert.equal(combined.status, 2, combined.output);
  assert.match(combined.stderr, /exactly one source; got --hub and --bundle/);
});

test('staticSource serves a validated private copy, and a hub bundle with a dangling parent is unavailable', async (t) => {
  const { bundle } = hierarchyBundle(t);
  const source = staticSource([bundle]);
  bundle.topics[1].summary = 'changed after the source was created';
  bundle.topics.length = 0;
  const loaded = await source.load();
  assert.equal(loaded.bundles.get('sample').topics.length, 4);
  assert.equal(loaded.bundles.get('sample').topics[1].summary, 'Holds a run until platypusrule evidence arrives.');
  assert.strictEqual(await source.load(), loaded, 'the snapshot never changes');

  assert.throws(() => staticSource([]), /at least one bundle is required/);
  assert.throws(() => staticSource([{ ...loaded.bundles.get('sample'), hook: () => {} }]), /bundles\[0\]: bundle is not plain data/);

  // The same check guards every source: the hub reports such a bundle as unavailable.
  const dangling = structuredClone(loaded.bundles.get('sample'));
  dangling.topics[2].parentId = 'ghost';
  assert.equal(bundleShapeError(dangling, 'sample'), 'topics[2].parentId "ghost" is not a topic id in this bundle');
});

test('bundleDigest covers hierarchy fields only when present, so existing digests are unchanged', (t) => {
  const { bundle } = hierarchyBundle(t);
  const plain = bundle.topics.map(({ id, title, source, url, markdown }) => ({ id, title, source, url, markdown }));
  // The pre-hierarchy algorithm, written out: topics reduced to {id, title, source, markdown}.
  const legacy = createHash('sha256')
    .update(
      JSON.stringify({
        documents: bundle.documents.map(({ source, section, title, landing, markdown }) => ({ source, section, title, landing, markdown })),
        topics: plain.map(({ id, title, source, markdown }) => ({ id, title, source, markdown })),
      }),
    )
    .digest('hex');
  assert.equal(bundleDigest(bundle.documents, plain), legacy);
  assert.equal(bundleDigest(bundle.documents, plain), bundle.digest, 'build output is unchanged');

  const withHierarchy = bundleDigest(bundle.documents, bundle.topics);
  assert.notEqual(withHierarchy, legacy);
  for (const field of ['parentId', 'tags', 'summary']) {
    const without = bundle.topics.map((topic) => (topic.id === 'evidence-gates' ? { ...topic, [field]: undefined } : topic));
    assert.notEqual(bundleDigest(bundle.documents, without), withHierarchy, `${field} is part of the digest`);
  }
});
