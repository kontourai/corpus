import { createHash } from 'node:crypto';
import { UsageError } from './errors.mjs';
import { headShaOrNull, isDirty } from './git.mjs';
import { loadManifest, outputPathFor, splitTopicSource } from './manifest.mjs';
import { checkTopics, createDocumentReader } from './check.mjs';
import { documentTitle, extractSection } from './markdown.mjs';
import { encodePath } from './paths.mjs';

export const DEFAULT_SITE_ORIGIN = 'https://kontourai.github.io/';

export function defaultSiteUrl(product) {
  return `${DEFAULT_SITE_ORIGIN}${product}/`;
}

/** Absolute http(s) URL with exactly one trailing slash, or UsageError. */
export function normalizeBaseUrl(value, flag = '--base-url') {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(`${flag} must be an absolute URL, got "${value}"`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new UsageError(`${flag} must be an http(s) URL, got "${value}"`);
  url.search = '';
  url.hash = '';
  return url.href.endsWith('/') ? url.href : `${url.href}/`;
}

/**
 * Digest of the canonical content: documents (landing first) and topics, in manifest order,
 * without URLs, sha, or build time. Two builds of the same docs at different
 * commits or base URLs share a digest.
 */
export function bundleDigest(documents, topics) {
  const canonical = JSON.stringify({
    documents: documents.map(({ source, section, title, landing, markdown }) => ({ source, section, title, landing, markdown })),
    topics: topics.map(({ id, title, source, markdown }) => ({ id, title, source, markdown })),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Assemble docs-bundle.json from a validated manifest. `read` is the shared
 * document reader. Topic anchors must already have passed the topics gate.
 */
export function assembleBundle({ manifest, read, sha, siteUrl, builtAt = new Date().toISOString() }) {
  const pageUrl = (source) => `${siteUrl}${encodePath(outputPathFor(manifest, source))}`;
  // The landing page is documents[0] with `landing: true` and no section.
  const documents = [
    { source: manifest.landing, section: null, title: null, landing: true },
    ...manifest.documents.map(({ source, section, title }) => ({ source, section, title, landing: false })),
  ].map(
    ({ source, section, title, landing }) => {
      const { markdown, analysis } = read(source);
      return { source, section, title: documentTitle(analysis, source, title), landing, url: pageUrl(source), markdown };
    },
  );
  const topics = manifest.topics.map(({ id, title, source }) => {
    const { path, anchor } = splitTopicSource(source);
    const { markdown, analysis } = read(path);
    const section = anchor === null ? markdown : extractSection(analysis, anchor);
    if (section === null) throw new UsageError(`topic "${id}": #${anchor} does not resolve in ${path}`);
    return { id, title, source, url: anchor === null ? pageUrl(path) : `${pageUrl(path)}#${encodeURIComponent(anchor)}`, markdown: section };
  });
  return {
    schemaVersion: 1,
    product: manifest.product,
    title: manifest.title,
    tagline: manifest.tagline,
    repo: manifest.repo,
    sha,
    builtAt,
    siteUrl,
    digest: bundleDigest(documents, topics),
    documents,
    topics,
  };
}

/**
 * Build a bundle in memory from a checkout (used by `mcp --repo` and
 * `--workspace`). Requires a valid manifest and resolvable topics; link and
 * reachability gates are not required to serve docs. `sha` is null outside git;
 * `dirty: true` is added when the working tree has uncommitted changes.
 */
export function bundleFromCheckout(root, { siteUrl } = {}) {
  const manifest = loadManifest(root);
  const read = createDocumentReader(root);
  const topicFailures = checkTopics(manifest, read);
  if (topicFailures.length > 0) throw new UsageError(`topics do not resolve:\n${topicFailures.map((f) => `  - ${f}`).join('\n')}`);
  const bundle = assembleBundle({ manifest, read, sha: headShaOrNull(root), siteUrl: siteUrl ?? defaultSiteUrl(manifest.product) });
  // A checkout with uncommitted changes serves content that `sha` alone does not identify.
  if (bundle.sha !== null && isDirty(root)) bundle.dirty = true;
  return bundle;
}
