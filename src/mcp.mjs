import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { bundleFromCheckout, normalizeBaseUrl } from './bundle.mjs';
import { UsageError } from './errors.mjs';
import { gitStatusPorcelain, headShaOrNull } from './git.mjs';
import { locateInBundle } from './locate.mjs';
import { MANIFEST_FILE, RETIRED_MANIFEST_FILE, manifestFile, loadManifest, validateProducts } from './manifest.mjs';
import { toFsPath } from './paths.mjs';

export const DEFAULT_HUB = 'https://kontourai.github.io/';
export const HUB_CACHE_MS = 10 * 60 * 1000;
export const HUB_RETRY_MS = 30 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

export const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const isString = (value) => typeof value === 'string';

/**
 * Shape check for a docs-bundle.json, down to each document and topic, so a
 * malformed product is reported as unavailable instead of throwing inside a
 * tool. `landing` is optional for bundles built before it existed.
 */
export function bundleShapeError(bundle, product) {
  if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) return 'bundle is not a JSON object';
  if (![1, 2].includes(bundle.schemaVersion)) return `unsupported bundle schemaVersion ${JSON.stringify(bundle.schemaVersion)}`;
  if (bundle.schemaVersion === 2) {
    if (!isString(bundle.purpose) || !bundle.purpose.trim()) return 'bundle purpose must be a non-empty string';
    if (!Array.isArray(bundle.builtOn)) return 'bundle builtOn must be an array';
    for (const entry of bundle.builtOn) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some((key) => !['product', 'via', 'for', 'evidence', 'bin'].includes(key)) || (Object.hasOwn(entry, 'bin') && (typeof entry.bin !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(entry.bin))) || (Object.hasOwn(entry, 'evidence') && entry.evidence !== 'cli') || ['product', 'for'].some((key) => !isString(entry[key]) || !entry[key].trim()) || !(Array.isArray(entry.via) ? entry.via.length > 0 && entry.via.every((via) => isString(via) && via.trim()) : isString(entry.via) && entry.via.trim())) return 'bundle builtOn entries must contain product and for strings, and via as a string or non-empty string array';
    }
  }
  if (product && bundle.product !== product) return `bundle is for product "${bundle.product}", expected "${product}"`;
  for (const key of ['product', 'title', 'tagline', 'repo', 'builtAt', 'siteUrl', 'digest'])
    if (!isString(bundle[key])) return `bundle field "${key}" must be a string`;
  if (!(isString(bundle.sha) || bundle.sha === null)) return 'bundle field "sha" must be a string or null';
  if (!Array.isArray(bundle.documents) || !Array.isArray(bundle.topics)) return 'bundle documents and topics must be arrays';
  for (const [index, document] of bundle.documents.entries()) {
    if (document === null || typeof document !== 'object') return `documents[${index}] is not an object`;
    for (const key of ['source', 'title', 'url', 'markdown']) if (!isString(document[key])) return `documents[${index}].${key} must be a string`;
    if (!(isString(document.section) || document.section === null)) return `documents[${index}].section must be a string or null`;
    if (document.landing !== undefined && typeof document.landing !== 'boolean') return `documents[${index}].landing must be a boolean`;
    // Added in 0.6.0; optional so older bundles stay readable.
    if (document.repoPath !== undefined && !isString(document.repoPath)) return `documents[${index}].repoPath must be a string`;
    if (document.lineOffset !== undefined && !(Number.isInteger(document.lineOffset) && document.lineOffset >= 0))
      return `documents[${index}].lineOffset must be a non-negative integer`;
  }
  for (const [index, topic] of bundle.topics.entries()) {
    if (topic === null || typeof topic !== 'object') return `topics[${index}] is not an object`;
    for (const key of ['id', 'title', 'source', 'url', 'markdown']) if (!isString(topic[key])) return `topics[${index}].${key} must be a string`;
  }
  return null;
}

/** A loaded snapshot: available bundles by product plus the products that failed. */
function snapshot(bundles, unavailable) {
  return { bundles: new Map(bundles.map((bundle) => [bundle.product, bundle])), unavailable };
}

/** Non-landing documents: the count the hub's "thin" rule and list_products use. */
export function pageCount(bundle) {
  return bundle.documents.filter((document) => !document.landing).length;
}

/**
 * Rebuild a checkout's bundle only when its content key changes: HEAD,
 * a hash of `git status --porcelain`, the manifest's mtime, and the mtime and
 * size of each published source (porcelain alone does not change when an
 * already-modified file is edited again).
 */
export function createCheckoutCache(build = bundleFromCheckout) {
  const cache = new Map(); // root -> { key, bundle, sources }
  const statKey = (file) => {
    try {
      const stat = statSync(file);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return 'missing';
    }
  };
  const keyFor = (root, sources) =>
    createHash('sha256')
      .update(
        [
          headShaOrNull(root) ?? 'no-git',
          gitStatusPorcelain(root),
          // The retired name too: one appearing mid-session must make the next build refuse.
          ...[MANIFEST_FILE, RETIRED_MANIFEST_FILE].map((name) => statKey(path.join(root, name))),
          ...sources.map((source) => `${source}=${statKey(toFsPath(root, source))}`),
        ].join('\n'),
      )
      .digest('hex');
  return (root) => {
    const hit = cache.get(root);
    if (hit && keyFor(root, hit.sources) === hit.key) return hit.bundle;
    // Key first, then build: an edit that lands while the bundle is being
    // built changes the key, so the next call rebuilds instead of serving
    // pre-edit content under a post-edit key.
    const manifest = loadManifest(root);
    const sources = [manifest.landing, ...manifest.documents.map((document) => document.source)];
    const key = keyFor(root, sources);
    const bundle = build(root);
    cache.set(root, { key, bundle, sources });
    return bundle;
  };
}

/**
 * One checkout, rebuilt when its content key changes so a long session sees
 * current docs. An invalid checkout at startup is a usage error; a later failure
 * (mid-edit) is reported as unavailable.
 */
export function repoSource(dir) {
  const root = path.resolve(dir);
  const build = createCheckoutCache();
  const first = build(root);
  return {
    describe: `repo ${root}`,
    load: async () => {
      try {
        return snapshot([build(root)], []);
      } catch (error) {
        return snapshot([], [{ product: first.product, error: error.message }]);
      }
    },
  };
}

function manifestProduct(dir, fallback) {
  try {
    const raw = JSON.parse(readFileSync(path.join(dir, manifestFile(dir)), 'utf8'));
    return typeof raw?.product === 'string' && raw.product.trim() ? raw.product : fallback;
  } catch {
    return fallback;
  }
}

/** The stderr note for a workspace subdirectory that has only a retired docs-kit.json. */
const noteToStderr = (root, name) =>
  process.stderr.write(
    `Corpus: skipping ${path.join(root, name)}: it has a retired v1 ${RETIRED_MANIFEST_FILE} and no ${MANIFEST_FILE}; ` +
      `rename it to ${MANIFEST_FILE} with schemaVersion 2, purpose and builtOn to serve it\n`,
  );

/**
 * Immediate subdirectories with corpus.json. One with only a retired
 * docs-kit.json is not a product: it is skipped and passed to `onRetired`, so
 * one stale checkout neither takes the workspace down nor vanishes silently.
 * One with both files is kept, and its build reports the conflict as unavailable.
 */
function scanWorkspace(root, onRetired) {
  const names = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (existsSync(path.join(root, entry.name, MANIFEST_FILE))) names.push(entry.name);
    else if (existsSync(path.join(root, entry.name, RETIRED_MANIFEST_FILE))) onRetired(root, entry.name);
  }
  return names.sort();
}

/** Build every product in a workspace. Unavailable entries are keyed by the manifest's product. */
export function loadWorkspace(root, build = bundleFromCheckout, onRetired = noteToStderr) {
  const byProduct = new Map();
  for (const name of scanWorkspace(root, onRetired)) {
    const dir = path.join(root, name);
    const product = manifestProduct(dir, name);
    if (!byProduct.has(product)) byProduct.set(product, []);
    byProduct.get(product).push({ name, dir });
  }
  const bundles = [];
  const unavailable = [];
  for (const [product, dirs] of byProduct) {
    if (dirs.length > 1) {
      const names = dirs.map((entry) => entry.name).join(', ');
      for (const entry of dirs)
        unavailable.push({ product, directory: entry.name, error: `product "${product}" is declared by more than one directory (${names}); rename or remove one` });
      continue;
    }
    try {
      bundles.push(build(dirs[0].dir));
    } catch (error) {
      unavailable.push({ product, directory: dirs[0].name, error: error.message });
    }
  }
  return snapshot(bundles, unavailable);
}

/**
 * Every immediate subdirectory with corpus.json, rescanned on every call; each
 * product rebuilt only when its key changes. A subdirectory with only a retired
 * docs-kit.json is noted on stderr once per server, not on every rescan.
 */
export function workspaceSource(dir) {
  const root = path.resolve(dir);
  const noted = new Set();
  const onRetired = (base, name) => {
    if (noted.has(name)) return;
    noted.add(name);
    noteToStderr(base, name);
  };
  let candidates;
  try {
    candidates = scanWorkspace(root, onRetired);
  } catch (error) {
    throw new UsageError(`--workspace ${dir}: ${error.message}`);
  }
  if (candidates.length === 0) throw new UsageError(`--workspace ${dir}: no immediate subdirectory contains ${MANIFEST_FILE}`);
  const build = createCheckoutCache();
  return {
    describe: `workspace ${root}`,
    load: async () => {
      try {
        return loadWorkspace(root, build, onRetired);
      } catch (error) {
        return snapshot([], [{ product: '*', error: `workspace ${root} unavailable: ${error.message}` }]);
      }
    },
  };
}

async function fetchJson(url, fetchImpl) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`);
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`GET ${url} -> invalid JSON: ${error.message}`);
  }
}

/**
 * Fetch <hub>/products.json and each <hub>/<product>/docs-bundle.json.
 * Successes are cached for HUB_CACHE_MS; failures only for HUB_RETRY_MS, so a
 * product that comes back is picked up on a later call. A failed product is
 * reported as unavailable; a failed products.json makes every result report
 * the hub error.
 */
export function hubSource(hub, { fetchImpl = fetch, now = Date.now, ttlMs = HUB_CACHE_MS, retryMs = HUB_RETRY_MS } = {}) {
  const base = normalizeBaseUrl(hub, '--hub');
  const cache = new Map(); // url -> { at, ok, value | error }
  const inflight = new Map();
  // `validate` returns an error string for a fetched-but-malformed body; that
  // is a failure too and gets the short retry TTL, not the 10-minute one.
  const cachedFetch = (url, validate) => {
    const hit = cache.get(url);
    if (hit && now() - hit.at < (hit.ok ? ttlMs : retryMs)) return Promise.resolve(hit);
    if (!inflight.has(url))
      inflight.set(
        url,
        fetchJson(url, fetchImpl)
          .then(
            (value) => {
              const problem = validate(value);
              return problem ? { ok: false, error: problem } : { ok: true, value };
            },
            (error) => ({ ok: false, error: error.message }),
          )
          .then((entry) => {
            cache.set(url, { at: now(), ...entry });
            inflight.delete(url);
            return entry;
          }),
      );
    return inflight.get(url);
  };
  return {
    describe: `hub ${base}`,
    load: async () => {
      const list = await cachedFetch(new URL('products.json', base).href, (value) => {
        const { errors } = validateProducts(value);
        return errors.length > 0 ? `products.json is invalid: ${errors.join('; ')}` : null;
      });
      if (!list.ok) return snapshot([], [{ product: '*', error: `hub ${base} unavailable: ${list.error}` }]);
      const { products } = validateProducts(list.value);
      const results = await Promise.all(
        products.map(async ({ product, repo }) => {
          const entry = await cachedFetch(new URL(`${product}/docs-bundle.json`, base).href, (value) => bundleShapeError(value, product));
          return entry.ok ? { bundle: entry.value } : { unavailable: { product, repo, error: entry.error } };
        }),
      );
      return snapshot(
        results.filter((result) => result.bundle).map((result) => result.bundle),
        results.filter((result) => result.unavailable).map((result) => result.unavailable),
      );
    },
  };
}

function words(text) {
  return [...new Set(text.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean))];
}

function countOccurrences(haystack, needle) {
  let count = 0;
  for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + needle.length)) count++;
  return count;
}

function snippetFor(markdown, terms, width = 220) {
  const lower = markdown.toLowerCase();
  const hits = terms.map((term) => lower.indexOf(term)).filter((index) => index !== -1);
  const at = hits.length > 0 ? Math.min(...hits) : 0;
  const start = Math.max(0, at - 80);
  const text = markdown.slice(start, start + width).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${text}${start + width < markdown.length ? '…' : ''}`;
}

/**
 * Ranked term matching: title hits weigh 5, id/source hits 3, body hits 1
 * (capped at 10 per term), scaled by the share of query terms matched.
 * Ties rank topics before documents.
 */
export function searchBundles(bundles, query, limit = 10) {
  const terms = words(query);
  if (terms.length === 0) return [];
  const results = [];
  for (const bundle of bundles) {
    const items = [
      ...bundle.topics.map((topic) => ({ kind: 'topic', id: topic.id, meta: `${topic.id} ${topic.source}`, ...topic })),
      ...bundle.documents.map((document) => ({ kind: 'document', meta: document.source, ...document })),
    ];
    for (const item of items) {
      const title = item.title.toLowerCase();
      const meta = item.meta.toLowerCase();
      const body = item.markdown.toLowerCase();
      let score = 0;
      let matched = 0;
      for (const term of terms) {
        const termScore = countOccurrences(title, term) * 5 + countOccurrences(meta, term) * 3 + Math.min(countOccurrences(body, term), 10);
        if (termScore > 0) matched++;
        score += termScore;
      }
      if (matched === 0) continue;
      results.push({
        product: bundle.product,
        kind: item.kind,
        ...(item.kind === 'topic' ? { id: item.id } : {}),
        title: item.title,
        source: item.source,
        url: item.url,
        ...stamp(bundle),
        score: Math.round(score * (matched / terms.length) * 100) / 100,
        snippet: snippetFor(item.markdown, terms),
      });
    }
  }
  // On equal scores a topic (a curated, narrower section) outranks the whole document.
  const kindRank = { topic: 0, document: 1 };
  results.sort((a, b) => b.score - a.score || kindRank[a.kind] - kindRank[b.kind] || a.product.localeCompare(b.product) || a.source.localeCompare(b.source));
  return results.slice(0, limit);
}

/** Source identity on every result: the bundle sha, plus `dirty: true` for an uncommitted checkout. */
function stamp(bundle) {
  return bundle.dirty ? { sha: bundle.sha, dirty: true } : { sha: bundle.sha };
}

function json(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function toolError(message, extra = {}) {
  return { ...json({ error: message, ...extra }), isError: true };
}

/** Resolve a product to its bundle, or a tool error naming what is available. */
function pickBundle(loaded, product) {
  const bundle = loaded.bundles.get(product);
  if (bundle) return { bundle };
  const down = loaded.unavailable.find((entry) => entry.product === product || entry.product === '*');
  if (down) return { error: toolError(`product "${product}" is unavailable: ${down.error}`) };
  return { error: toolError(`unknown product "${product}"`, { availableProducts: [...loaded.bundles.keys()] }) };
}

export function createDocsServer(source) {
  const server = new McpServer({ name: 'corpus', version: PACKAGE_VERSION });
  const readOnly = { readOnlyHint: true };
  // A tool never throws: anything unexpected (a malformed bundle that slipped
  // past validation, a filesystem race) becomes an isError result.
  const tool = (name, config, handler) =>
    server.registerTool(name, config, async (args) => {
      try {
        return await handler(args ?? {});
      } catch (error) {
        return toolError(`${name} failed: ${error?.message ?? error}`);
      }
    });

  tool(
    'list_products',
    {
      description: 'List the products whose published documentation this server can answer from, with each bundle\'s source commit (sha), build time, site URL, and topic/document counts. Products whose docs could not be loaded are listed as unavailable.',
      inputSchema: z.object({}),
      annotations: readOnly,
    },
    async () => {
      const loaded = await source.load();
      return json({
        products: [
          ...[...loaded.bundles.values()].map((bundle) => ({
            product: bundle.product,
            title: bundle.title,
            tagline: bundle.tagline,
            ...(bundle.schemaVersion === 2 ? { purpose: bundle.purpose, builtOn: bundle.builtOn } : {}),
            ...stamp(bundle),
            builtAt: bundle.builtAt,
            siteUrl: bundle.siteUrl,
            topicCount: bundle.topics.length,
            docCount: pageCount(bundle),
            status: 'available',
          })),
          ...loaded.unavailable.map((entry) => ({ ...entry, status: 'unavailable' })),
        ],
      });
    },
  );

  tool(
    'list_topics',
    {
      description: 'List curated documentation topics (id, title, source, url) for one product or all products. Use get_topic to read one.',
      inputSchema: z.object({ product: z.string().optional().describe('Product slug, e.g. "flow". Omit for all products.') }),
      annotations: readOnly,
    },
    async ({ product }) => {
      const loaded = await source.load();
      let bundles = [...loaded.bundles.values()];
      if (product !== undefined) {
        const picked = pickBundle(loaded, product);
        if (picked.error) return picked.error;
        bundles = [picked.bundle];
      }
      return json({
        topics: bundles.flatMap((bundle) =>
          bundle.topics.map(({ id, title, source: topicSource, url }) => ({ product: bundle.product, id, title, source: topicSource, url, ...stamp(bundle) })),
        ),
        ...(product === undefined && loaded.unavailable.length > 0 ? { unavailable: loaded.unavailable } : {}),
      });
    },
  );

  tool(
    'get_topic',
    {
      description: 'Read one documentation topic as Markdown (the heading section it points at). Use list_topics for ids.',
      inputSchema: z.object({ product: z.string().describe('Product slug.'), id: z.string().describe('Topic id from list_topics.') }),
      annotations: readOnly,
    },
    async ({ product, id }) => {
      const picked = pickBundle(await source.load(), product);
      if (picked.error) return picked.error;
      const topic = picked.bundle.topics.find((entry) => entry.id === id);
      if (!topic) return toolError(`unknown topic "${id}" in ${product}`, { availableTopics: picked.bundle.topics.map((entry) => entry.id), ...stamp(picked.bundle) });
      return json({ product, ...stamp(picked.bundle), topic });
    },
  );

  tool(
    'get_document',
    {
      description: 'Read one whole document as Markdown by its repository source path (e.g. "docs/getting-started.md"; the landing page, usually README.md, is included).',
      inputSchema: z.object({ product: z.string().describe('Product slug.'), source: z.string().describe('Document source path from list_products/search.') }),
      annotations: readOnly,
    },
    async ({ product, source: wanted }) => {
      const picked = pickBundle(await source.load(), product);
      if (picked.error) return picked.error;
      const document = picked.bundle.documents.find((entry) => entry.source === wanted);
      if (!document)
        return toolError(`unknown document "${wanted}" in ${product}`, { availableDocuments: picked.bundle.documents.map((entry) => entry.source), ...stamp(picked.bundle) });
      return json({ product, ...stamp(picked.bundle), document });
    },
  );

  tool(
    'search',
    {
      description: 'Ranked keyword search over topics and documents of one or all products. Returns snippets with product, source, url, and the source commit sha.',
      inputSchema: z.object({
        query: z.string().describe('Words to look for, e.g. "evidence gate".'),
        product: z.string().optional().describe('Limit to one product slug.'),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum results (default 10).'),
      }),
      annotations: readOnly,
    },
    async ({ query, product, limit }) => {
      if (words(query).length === 0) return toolError('query must contain at least one word');
      const loaded = await source.load();
      let bundles = [...loaded.bundles.values()];
      if (product !== undefined) {
        const picked = pickBundle(loaded, product);
        if (picked.error) return picked.error;
        bundles = [picked.bundle];
      }
      return json({
        query,
        results: searchBundles(bundles, query, limit ?? 10),
        ...(product === undefined && loaded.unavailable.length > 0 ? { unavailable: loaded.unavailable } : {}),
      });
    },
  );

  tool(
    'locate',
    {
      description:
        'Find where a quoted passage (for example text selected on a docs page) lives in a product\'s Markdown source. Tolerates whitespace, Markdown formatting, and punctuation differences. Returns the source path, 1-based file line range, sha, enclosing heading and anchor, the surrounding Markdown, a GitHub blob URL with #Lstart-Lend, a confidence, and alternatives when the quote matches more than one place.',
      inputSchema: z.object({
        product: z.string().describe('Product slug.'),
        quote: z.string().describe('The passage to find, as copied from the page or the Markdown.'),
        source: z.string().optional().describe('Limit the search to one document source path, e.g. "docs/concepts.md".'),
      }),
      annotations: readOnly,
    },
    async ({ product, quote, source: only }) => {
      const picked = pickBundle(await source.load(), product);
      if (picked.error) return picked.error;
      const { bundle } = picked;
      const found = locateInBundle(bundle, quote, { source: only });
      if (found.error) return toolError(found.error, { ...(found.availableDocuments ? { availableDocuments: found.availableDocuments } : {}), ...stamp(bundle) });
      if (found.best === null)
        return toolError(`no match for the quote in ${product}${only === undefined ? '' : ` (${only})`}`, { documentsSearched: found.documentsSearched, ...stamp(bundle) });
      return json({
        product,
        ...stamp(bundle),
        confidence: found.confidence,
        ...found.best,
        // Only the first MAX_ALTERNATIVES others are listed; matchCount is the total.
        ...(found.matchCount > 1 ? { ambiguous: true, matchCount: found.matchCount, alternatives: found.alternatives } : {}),
      });
    },
  );

  return server;
}

/** `docs-kit mcp`: choose exactly one source, then serve over stdio until stdin closes. */
export async function runMcp({ repo, workspace, hub }) {
  const chosen = [repo && 'repo', workspace && 'workspace', hub && 'hub'].filter(Boolean);
  if (chosen.length > 1) throw new UsageError(`mcp takes exactly one source; got --${chosen.join(' and --')}`);
  const source = repo ? repoSource(repo) : workspace ? workspaceSource(workspace) : hubSource(hub ?? DEFAULT_HUB);
  const server = createDocsServer(source);
  await server.connect(new StdioServerTransport());
  process.stderr.write(`docs-kit ${PACKAGE_VERSION} MCP server ready (${source.describe})\n`);
}
