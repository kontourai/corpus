import { createHash } from 'node:crypto';
import { UsageError } from './errors.mjs';
import { headShaOrNull, isDirty, repoPrefix } from './git.mjs';
import { loadManifest, outputPathFor, splitTopicSource } from './manifest.mjs';
import { checkTopics, createDocumentReader, publishedSources } from './check.mjs';
import { analyzeMarkdown, documentTitle, extractSection, resolveLink, rewriteMarkdownLinks } from './markdown.mjs';
import { encodePath, statInRepo } from './paths.mjs';

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
 *
 * A bundle-only document (`publish: false`) has no page: its `url` is the
 * GitHub blob at `sha` (`HEAD` outside git), and its `markdown`, and topics
 * taken from it, have relative links made absolute (published targets to
 * their page, anything else to GitHub) so the text stands alone for MCP
 * readers; images and other embedded files (`src`, `srcset`, `poster`) go to
 * raw.githubusercontent.com so they resolve to the file itself. The digest is computed over the Markdown as written, so it still
 * identifies the content and not the commit or base URL.
 */
export function assembleBundle({ manifest, read, sha, siteUrl, root, prefix = '', builtAt = new Date().toISOString() }) {
  const published = new Set(publishedSources(manifest));
  const githubUrl = (kind, repoPath) => `https://github.com/${manifest.repo}/${kind}/${sha ?? 'HEAD'}/${encodePath(`${prefix}${repoPath}`)}`;
  const pageUrl = (source) => (published.has(source) ? `${siteUrl}${encodePath(outputPathFor(manifest, source))}` : githubUrl('blob', source));
  // An embedded image needs the file's bytes, not GitHub's HTML page for it.
  const rawUrl = (repoPath) => `https://raw.githubusercontent.com/${manifest.repo}/${sha ?? 'HEAD'}/${encodePath(`${prefix}${repoPath}`)}`;
  const absolute = (href, fromSource, { image = false } = {}) => {
    const target = resolveLink(href, fromSource);
    if (target.kind === 'fragment') return target.rawFragment ? `${pageUrl(fromSource)}#${target.rawFragment}` : href;
    if (target.kind !== 'local') return href;
    const hash = target.rawFragment ? `#${target.rawFragment}` : '';
    if (published.has(target.path)) return `${pageUrl(target.path)}${hash}`;
    // A missing target fails the links gate; leave it as written.
    const stat = statInRepo(root, target.path);
    if (!stat) return href;
    if (stat.kind === 'dir') return `${githubUrl('tree', target.path).replace(/\/$/, '')}${hash}`;
    return `${image ? rawUrl(target.path) : githubUrl('blob', target.path)}${hash}`;
  };
  const bundleOnly = new Map(); // source -> { markdown, analysis } with links made absolute
  const readForBundle = (source) => {
    if (published.has(source)) return read(source);
    if (!bundleOnly.has(source)) {
      const markdown = rewriteMarkdownLinks(read(source).markdown, (href, options) => absolute(href, source, options));
      bundleOnly.set(source, { markdown, analysis: analyzeMarkdown(markdown) });
    }
    return bundleOnly.get(source);
  };
  // The landing page is documents[0] with `landing: true` and no section.
  const documents = [
    { source: manifest.landing, section: null, title: null, landing: true },
    ...manifest.documents.map(({ source, section, title }) => ({ source, section, title, landing: false })),
  ].map(
    ({ source, section, title, landing }) => {
      // The title comes from the source as written, so it never depends on rewriting.
      const { analysis } = read(source);
      return { source, section, title: documentTitle(analysis, source, title), landing, url: pageUrl(source), markdown: readForBundle(source).markdown };
    },
  );
  const topicSection = (id, path, anchor, reader) => {
    const { markdown, analysis } = reader(path);
    const section = anchor === null ? markdown : extractSection(analysis, anchor);
    if (section === null) throw new UsageError(`topic "${id}": #${anchor} does not resolve in ${path}`);
    return section;
  };
  const topics = manifest.topics.map(({ id, title, source }) => {
    const { path, anchor } = splitTopicSource(source);
    const markdown = topicSection(id, path, anchor, readForBundle);
    return { id, title, source, url: anchor === null ? pageUrl(path) : `${pageUrl(path)}#${encodeURIComponent(anchor)}`, markdown };
  });
  const asWritten = {
    documents: documents.map((document) => ({ ...document, markdown: read(document.source).markdown })),
    topics: manifest.topics.map(({ id, title, source }) => {
      const { path, anchor } = splitTopicSource(source);
      return { id, title, source, markdown: topicSection(id, path, anchor, read) };
    }),
  };
  return {
    schemaVersion: 1,
    product: manifest.product,
    title: manifest.title,
    tagline: manifest.tagline,
    repo: manifest.repo,
    sha,
    builtAt,
    siteUrl,
    digest: bundleDigest(asWritten.documents, asWritten.topics),
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
  const bundle = assembleBundle({
    manifest,
    read,
    sha: headShaOrNull(root),
    siteUrl: siteUrl ?? defaultSiteUrl(manifest.product),
    root,
    prefix: repoPrefix(root),
  });
  // A checkout with uncommitted changes serves content that `sha` alone does not identify.
  if (bundle.sha !== null && isDirty(root)) bundle.dirty = true;
  return bundle;
}
