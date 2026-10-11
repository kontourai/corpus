import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { bundleFromCheckout, normalizeBaseUrl } from './bundle.mjs';
import { UsageError } from './errors.mjs';
import { MANIFEST_FILE, validateProducts } from './manifest.mjs';

export const DEFAULT_HUB = 'https://kontourai.github.io/';
export const HUB_CACHE_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

export const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/** Minimal shape check for a fetched docs-bundle.json; anything else is "unavailable". */
export function bundleShapeError(bundle, product) {
  if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) return 'bundle is not a JSON object';
  if (bundle.schemaVersion !== 1) return `unsupported bundle schemaVersion ${JSON.stringify(bundle.schemaVersion)}`;
  if (product && bundle.product !== product) return `bundle is for product "${bundle.product}", expected "${product}"`;
  for (const key of ['product', 'title', 'repo', 'builtAt', 'siteUrl', 'digest'])
    if (typeof bundle[key] !== 'string') return `bundle field "${key}" is missing`;
  if (!(typeof bundle.sha === 'string' || bundle.sha === null)) return 'bundle field "sha" is missing';
  if (!Array.isArray(bundle.documents) || !Array.isArray(bundle.topics)) return 'bundle documents/topics are missing';
  return null;
}

/** A loaded snapshot: available bundles by product plus the products that failed. */
function snapshot(bundles, unavailable) {
  return { bundles: new Map(bundles.map((bundle) => [bundle.product, bundle])), unavailable };
}

export function repoSource(dir) {
  const root = path.resolve(dir);
  const bundle = bundleFromCheckout(root);
  const loaded = snapshot([bundle], []);
  return { describe: `repo ${root}`, load: async () => loaded };
}

export function workspaceSource(dir) {
  const root = path.resolve(dir);
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    throw new UsageError(`--workspace ${dir}: ${error.message}`);
  }
  const candidates = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && existsSync(path.join(root, entry.name, MANIFEST_FILE)))
    .map((entry) => entry.name)
    .sort();
  if (candidates.length === 0) throw new UsageError(`--workspace ${dir}: no immediate subdirectory contains ${MANIFEST_FILE}`);
  const bundles = [];
  const unavailable = [];
  for (const name of candidates) {
    try {
      bundles.push(bundleFromCheckout(path.join(root, name)));
    } catch (error) {
      unavailable.push({ product: name, error: error.message });
    }
  }
  const loaded = snapshot(bundles, unavailable);
  return { describe: `workspace ${root}`, load: async () => loaded };
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
 * Fetch <hub>/products.json and each <hub>/<product>/docs-bundle.json, caching
 * the whole snapshot for HUB_CACHE_MS. A failed product is reported as
 * unavailable; a failed products.json makes every result report the hub error.
 */
export function hubSource(hub, { fetchImpl = fetch, now = Date.now, ttlMs = HUB_CACHE_MS } = {}) {
  const base = normalizeBaseUrl(hub, '--hub');
  let cached = null;
  let inflight = null;
  const refresh = async () => {
    let products;
    try {
      const { products: list, errors } = validateProducts(await fetchJson(new URL('products.json', base).href, fetchImpl));
      if (errors.length > 0) throw new Error(`products.json is invalid: ${errors.join('; ')}`);
      products = list;
    } catch (error) {
      return snapshot([], [{ product: '*', error: `hub ${base} unavailable: ${error.message}` }]);
    }
    const results = await Promise.all(
      products.map(async ({ product, repo }) => {
        try {
          const bundle = await fetchJson(new URL(`${product}/docs-bundle.json`, base).href, fetchImpl);
          const problem = bundleShapeError(bundle, product);
          if (problem) throw new Error(problem);
          return { bundle };
        } catch (error) {
          return { unavailable: { product, repo, error: error.message } };
        }
      }),
    );
    return snapshot(
      results.filter((result) => result.bundle).map((result) => result.bundle),
      results.filter((result) => result.unavailable).map((result) => result.unavailable),
    );
  };
  return {
    describe: `hub ${base}`,
    load: async () => {
      if (cached && now() - cached.at < ttlMs) return cached.value;
      inflight ??= refresh().then((value) => {
        cached = { at: now(), value };
        inflight = null;
        return value;
      });
      return inflight;
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
        sha: bundle.sha,
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
  const server = new McpServer({ name: 'docs-kit', version: PACKAGE_VERSION });
  const readOnly = { readOnlyHint: true };

  server.registerTool(
    'list_products',
    {
      description: 'List the Kontour products whose published documentation this server can answer from, with each bundle\'s source commit (sha), build time, site URL, and topic/document counts. Products whose docs could not be loaded are listed as unavailable.',
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
            sha: bundle.sha,
            builtAt: bundle.builtAt,
            siteUrl: bundle.siteUrl,
            topicCount: bundle.topics.length,
            docCount: bundle.documents.length,
            status: 'available',
          })),
          ...loaded.unavailable.map((entry) => ({ ...entry, status: 'unavailable' })),
        ],
      });
    },
  );

  server.registerTool(
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
          bundle.topics.map(({ id, title, source: topicSource, url }) => ({ product: bundle.product, id, title, source: topicSource, url, sha: bundle.sha })),
        ),
        ...(product === undefined && loaded.unavailable.length > 0 ? { unavailable: loaded.unavailable } : {}),
      });
    },
  );

  server.registerTool(
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
      if (!topic) return toolError(`unknown topic "${id}" in ${product}`, { availableTopics: picked.bundle.topics.map((entry) => entry.id), sha: picked.bundle.sha });
      return json({ product, sha: picked.bundle.sha, topic });
    },
  );

  server.registerTool(
    'get_document',
    {
      description: 'Read one whole published document as Markdown by its repository source path (e.g. "docs/getting-started.md").',
      inputSchema: z.object({ product: z.string().describe('Product slug.'), source: z.string().describe('Document source path from list_products/search.') }),
      annotations: readOnly,
    },
    async ({ product, source: wanted }) => {
      const picked = pickBundle(await source.load(), product);
      if (picked.error) return picked.error;
      const document = picked.bundle.documents.find((entry) => entry.source === wanted);
      if (!document)
        return toolError(`unknown document "${wanted}" in ${product}`, { availableDocuments: picked.bundle.documents.map((entry) => entry.source), sha: picked.bundle.sha });
      return json({ product, sha: picked.bundle.sha, document });
    },
  );

  server.registerTool(
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
