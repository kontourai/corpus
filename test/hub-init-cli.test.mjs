import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { FIXTURES, REPO_ROOT, git, runCli, scratch } from './helpers.mjs';

test('hub writes index.html and a byte-identical copy of products.json', async (t) => {
  const out = path.join(scratch(t), 'hub');
  const products = path.join(FIXTURES, 'hub', 'products.json');
  const result = await runCli(['hub', '--products', products, '--out', out]);
  assert.equal(result.status, 0, result.output);
  assert.match(result.stdout, /3 products/);
  assert.equal(readFileSync(path.join(out, 'products.json'), 'utf8'), readFileSync(products, 'utf8'));

  const html = readFileSync(path.join(out, 'index.html'), 'utf8');
  for (const product of ['sample', 'second', 'ghost']) {
    assert.ok(html.includes(`id="product-${product}"`), `${product} card`);
    assert.ok(html.includes(`<a href="/${product}/">`), `${product} links to its site`);
  }
  assert.match(html, /fetch\(url, init\)/);
  assert.match(html, /'\/' \+ p\.product \+ '\/docs-bundle\.json'/, 'bundle fetched from the same origin');
  assert.match(html, /https:\/\/api\.github\.com\/repos\/' \+ repo \+ '\/commits\/HEAD/);
  assert.match(html, /localStorage/);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.ok(html.includes('npx -y github:kontourai/corpus#&lt;sha&gt; corpus mcp'));
  assert.ok(html.includes('claude mcp add kontour-docs -- npx -y github:kontourai/corpus#&lt;sha&gt; corpus mcp'));
  assert.doesNotMatch(html, /<link rel="stylesheet"|<script src=/, 'self-contained');
});

/** Execute the generated page's inline script against stub DOM, fetch and sessionStorage. */
async function runHubScript(html, { bundles, mains }) {
  const data = JSON.parse(html.match(/<script type="application\/json" id="products-data">([\s\S]*?)<\/script>/)[1]);
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
  const cards = {};
  const element = () => ({ textContent: '', className: '' });
  for (const { product } of data) {
    const parts = { '.state': element(), '.tagline': element(), '.meta': element() };
    cards[`product-${product}`] = { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, querySelector: (selector) => parts[selector], parts };
  }
  const fetched = [];
  const respond = (body) => Promise.resolve(body === undefined ? { ok: false, status: 404, json: async () => ({}) } : { ok: true, status: 200, json: async () => body });
  const store = new Map();
  const context = {
    document: { getElementById: (id) => (id === 'products-data' ? { textContent: JSON.stringify(data) } : cards[id]) },
    fetch: (url) => {
      fetched.push(url);
      const bundle = url.match(/^\/([^/]+)\/docs-bundle\.json$/);
      if (bundle) return respond(bundles[bundle[1]]);
      const main = url.match(/^https:\/\/api\.github\.com\/repos\/(.+)\/commits\/HEAD$/);
      return respond(main ? mains[main[1]] : undefined);
    },
    localStorage: { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) },
    Date, JSON, Math, Promise, String, isFinite,
  };
  vm.runInNewContext(script, context);
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  return { cards, fetched, store };
}

test('hub page derives current, behind, thin, unpublished (and unknown) from bundle vs main', async (t) => {
  const dir = scratch(t);
  const products = path.join(dir, 'products.json');
  const names = ['current', 'behind', 'thin', 'gone', 'noapi'];
  writeFileSync(products, JSON.stringify({ schemaVersion: 1, products: names.map((name) => ({ product: name, repo: `kontourai/${name}` })) }));
  const out = path.join(dir, 'hub');
  const result = await runCli(['hub', '--products', products, '--out', out]);
  assert.equal(result.status, 0, result.output);
  const html = readFileSync(path.join(out, 'index.html'), 'utf8');

  const doc = { source: 'x.md', section: 'S', title: 'X', landing: false, url: 'u', markdown: '# X' };
  const landing = { ...doc, source: 'README.md', section: null, landing: true };
  // The landing page never counts toward the thin threshold of 3 documents.
  const bundle = (sha, docs) => ({ schemaVersion: 1, product: 'p', sha, builtAt: new Date(Date.now() - 3 * 86400000).toISOString(), documents: [landing, ...Array(docs).fill(doc)], topics: [] });
  const { cards, fetched, store } = await runHubScript(html, {
    bundles: { current: bundle('aaa1111', 3), behind: bundle('old2222', 5), thin: bundle('ccc3333', 2), noapi: bundle('ddd4444', 4) },
    mains: {
      'kontourai/current': { sha: 'aaa1111', commit: { committer: { date: new Date().toISOString() } } },
      'kontourai/behind': { sha: 'new9999', commit: { committer: { date: new Date().toISOString() } } },
      'kontourai/thin': { sha: 'ccc3333', commit: { committer: { date: new Date().toISOString() } } },
      'kontourai/gone': { sha: 'eee5555', commit: { committer: { date: new Date().toISOString() } } },
    },
  });
  const state = (name) => cards[`product-${name}`].attributes['data-state'];
  assert.equal(state('current'), 'current');
  assert.equal(state('behind'), 'behind');
  assert.match(cards['product-behind'].parts['.meta'].textContent, /5 docs, 0 topics; built 3 days ago from old2222; HEAD is new9999/);
  assert.equal(state('thin'), 'thin');
  assert.equal(state('gone'), 'unpublished');
  assert.equal(state('noapi'), 'unknown', 'no main commit to compare: say so instead of claiming current');
  assert.equal(cards['product-current'].parts['.state'].textContent, 'current');
  assert.ok(fetched.includes('/current/docs-bundle.json'));
  assert.ok(store.has('docs-kit-hub:head:kontourai/current'), 'HEAD commit cached in localStorage');
});

test('hub refuses an invalid products.json (exit 2)', async (t) => {
  const dir = scratch(t);
  const products = path.join(dir, 'products.json');
  writeFileSync(products, JSON.stringify({ schemaVersion: 1, products: [{ product: 'flow', repo: 'kontourai/flow', url: 'x' }], extra: true }));
  const result = await runCli(['hub', '--products', products, '--out', path.join(dir, 'out')]);
  assert.equal(result.status, 2, result.output);
  assert.match(result.stderr, /products\.json: unknown key "extra"/);
  assert.match(result.stderr, /products\[0\]: unknown key "url"/);
  assert.ok(!existsSync(path.join(dir, 'out')));
});

test('init scaffolds a manifest that passes check, then refuses to overwrite it', async (t) => {
  const root = path.join(scratch(t), 'widget');
  mkdirSync(path.join(root, 'docs', 'guides'), { recursive: true });
  writeFileSync(path.join(root, 'README.md'), '# Widget\n\nRead [the guide](docs/guides/setup.md).\n');
  writeFileSync(path.join(root, 'docs', 'overview.md'), '# Overview\n');
  writeFileSync(path.join(root, 'docs', 'guides', 'setup.md'), '# Setup\n');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ description: 'Widgets for everyone' }));
  git(root, ['init', '-q']);
  git(root, ['remote', 'add', 'origin', 'git@github.com:kontourai/widget.git']);

  const result = await runCli(['init', '--root', root]);
  assert.equal(result.status, 0, result.output);
  const manifest = JSON.parse(readFileSync(path.join(root, 'docs-kit.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.product, 'widget');
  assert.equal(manifest.repo, 'kontourai/widget');
  assert.equal(manifest.title, 'Widget');
  assert.equal(manifest.tagline, 'Widgets for everyone');
  assert.deepEqual(manifest.documents, [
    { source: 'docs/guides/setup.md', section: 'Guides' },
    { source: 'docs/overview.md', section: 'Documentation' },
  ]);
  const check = await runCli(['check', '--root', root]);
  assert.equal(check.status, 0, check.output);

  const again = await runCli(['init', '--root', root]);
  assert.equal(again.status, 2, again.output);
  assert.match(again.stderr, /already exists; refusing to overwrite it/);
});

test('cli: help, version, unknown command and the npx leading program name', async () => {
  const help = await runCli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Corpus \d+\.\d+\.\d+: /);
  for (const command of ['check', 'build', 'mcp', 'hub', 'init']) assert.match(help.stdout, new RegExp(`\\n  ${command} `));

  const version = await runCli(['--version']);
  assert.equal(version.stdout.trim(), JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version);

  const none = await runCli([]);
  assert.equal(none.status, 2);

  const unknown = await runCli(['publish']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown command "publish"/);

  const badOption = await runCli(['check', '--rot', '.']);
  assert.equal(badOption.status, 2);
  assert.match(badOption.stderr, /Unknown option '--rot'/);

  // `npx -y github:kontourai/docs-kit#<sha> docs-kit check` passes "docs-kit" through as argv[0].
  const viaNpx = await runCli(['docs-kit', 'check', '--root', path.join(FIXTURES, 'valid')]);
  assert.equal(viaNpx.status, 0, viaNpx.output);
});

test('this repository dogfoods docs-kit and passes check', async () => {
  const result = await runCli(['check', '--root', REPO_ROOT]);
  assert.equal(result.status, 0, result.output);
});
