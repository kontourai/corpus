import { readFileSync } from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { UsageError } from './errors.mjs';
import { trackedFiles } from './git.mjs';
import { isRepoFile, listFiles, repoGlobError, repoPathError, statInRepo } from './paths.mjs';

export const MANIFEST_FILE = 'docs-kit.json';
export const DEFAULT_LANDING = 'README.md';

const PRODUCT_SLUG = /^[a-z0-9][a-z0-9._-]*$/;
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;
const TOPIC_ID = /^[a-z0-9][a-z0-9._-]*$/;

const MANIFEST_KEYS = ['schemaVersion', 'product', 'title', 'tagline', 'repo', 'landing', 'documents', 'topics', 'exclude'];
const MANIFEST_REQUIRED = ['schemaVersion', 'product', 'title', 'repo', 'documents'];
const DOCUMENT_KEYS = ['source', 'section', 'covers'];
const DOCUMENT_REQUIRED = ['source', 'section'];
const TOPIC_KEYS = ['id', 'title', 'source'];
const TOPIC_REQUIRED = ['id', 'title', 'source'];

const PRODUCTS_KEYS = ['schemaVersion', 'products'];
const PRODUCT_ENTRY_KEYS = ['product', 'repo'];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Refuse unknown keys and report missing required keys. */
function checkKeys(value, where, allowed, required, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${where} must be an object`);
    return false;
  }
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) errors.push(`${where}: unknown key "${key}" (allowed: ${allowed.join(', ')})`);
  for (const key of required)
    if (!Object.hasOwn(value, key)) errors.push(`${where}: missing required key "${key}"`);
  return true;
}

function checkString(value, where, errors, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
    errors.push(`${where} must be a ${allowEmpty ? '' : 'non-empty '}string`);
    return false;
  }
  if (value !== value.trim()) {
    errors.push(`${where} must not have leading or trailing whitespace`);
    return false;
  }
  return true;
}

function checkGlobs(value, where, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${where} must be an array of glob strings`);
    return;
  }
  value.forEach((glob, index) => {
    const problem = repoGlobError(glob);
    if (problem) errors.push(`${where}[${index}] ${problem}`);
  });
}

const GLOB_CHARS = /[*?[\]{}()!+@]/;

/** Tracked files (git ls-files), or every file outside git; computed once on demand. */
function lazyRepoFiles(root) {
  let files;
  return () => (files ??= trackedFiles(root) ?? listFiles(root));
}

/**
 * Expand a bare directory name in `covers` to `dir/**`, then require every
 * glob to match at least one tracked file: a glob that matches nothing can
 * never mark its document stale, so it is a configuration error.
 */
function expandCovers(covers, root, where, errors, repoFiles) {
  return covers.map((glob, index) => {
    const bare = glob.replace(/\/+$/, '');
    const expanded = !GLOB_CHARS.test(bare) && statInRepo(root, bare)?.kind === 'dir' ? `${bare}/**` : glob;
    const matches = picomatch(expanded, { dot: true });
    if (!repoFiles().some((file) => matches(file)))
      errors.push(`${where}[${index}] "${glob}" matches no tracked file${expanded !== glob ? ` (expanded to "${expanded}")` : ''}`);
    return expanded;
  });
}

/** Output page path for a published source. The landing page becomes the site index. */
export function outputPathFor(manifest, source) {
  return source === manifest.landing ? 'index.html' : source.replace(/\.md$/, '.html');
}

/** Split a topic source `path#anchor`. */
export function splitTopicSource(source) {
  const index = source.indexOf('#');
  return index === -1
    ? { path: source, anchor: null }
    : { path: source.slice(0, index), anchor: source.slice(index + 1) };
}

export function globMatcher(globs = []) {
  if (globs.length === 0) return () => false;
  return picomatch(globs, { dot: true });
}

/**
 * Strict docs-kit.json validation. Returns { manifest, errors }; `manifest` is
 * normalized (landing defaulted, optional arrays defaulted) and only
 * meaningful when `errors` is empty.
 */
export function validateManifest(raw, root) {
  const errors = [];
  const where = MANIFEST_FILE;
  if (!checkKeys(raw, where, MANIFEST_KEYS, MANIFEST_REQUIRED, errors)) return { manifest: null, errors };

  if (Object.hasOwn(raw, 'schemaVersion') && raw.schemaVersion !== 1)
    errors.push(`${where}: schemaVersion must be exactly 1 (got ${JSON.stringify(raw.schemaVersion)})`);

  if (Object.hasOwn(raw, 'product') && checkString(raw.product, `${where}: product`, errors) && !PRODUCT_SLUG.test(raw.product))
    errors.push(`${where}: product must be a lowercase slug matching ${PRODUCT_SLUG}`);
  if (Object.hasOwn(raw, 'title')) checkString(raw.title, `${where}: title`, errors);
  if (Object.hasOwn(raw, 'tagline')) checkString(raw.tagline, `${where}: tagline`, errors, { allowEmpty: true });
  if (Object.hasOwn(raw, 'repo') && checkString(raw.repo, `${where}: repo`, errors)) {
    if (!REPO.test(raw.repo)) errors.push(`${where}: repo must be "owner/name", got "${raw.repo}"`);
    else if (typeof raw.product === 'string' && raw.repo.split('/')[1] !== raw.product)
      errors.push(
        `${where}: product "${raw.product}" must equal the repository name in repo "${raw.repo}" ` +
          '(the site is served at https://<owner>.github.io/<product>/ and the hub fetches /<product>/docs-bundle.json)',
      );
  }

  const landing = Object.hasOwn(raw, 'landing') ? raw.landing : DEFAULT_LANDING;
  const landingProblem = repoPathError(landing);
  if (landingProblem) errors.push(`${where}: landing ${landingProblem}`);
  else if (!landing.endsWith('.md')) errors.push(`${where}: landing must be a .md file`);
  else if (!isRepoFile(root, landing)) errors.push(`${where}: landing "${landing}" does not exist (or is outside the repository)`);

  const exclude = Object.hasOwn(raw, 'exclude') ? raw.exclude : [];
  if (Object.hasOwn(raw, 'exclude')) checkGlobs(raw.exclude, `${where}: exclude`, errors);
  const isExcluded = Array.isArray(exclude) && exclude.every((glob) => !repoGlobError(glob)) ? globMatcher(exclude) : () => false;

  const repoFiles = lazyRepoFiles(root);
  const sources = new Set();
  const outputs = new Map([['index.html', landing]]);
  const documents = [];
  if (Object.hasOwn(raw, 'documents')) {
    if (!Array.isArray(raw.documents)) errors.push(`${where}: documents must be an array`);
    else
      raw.documents.forEach((document, index) => {
        const at = `${where}: documents[${index}]`;
        if (!checkKeys(document, at, DOCUMENT_KEYS, DOCUMENT_REQUIRED, errors)) return;
        if (Object.hasOwn(document, 'section')) checkString(document.section, `${at}.section`, errors);
        let covers = [];
        if (Object.hasOwn(document, 'covers')) {
          const before = errors.length;
          checkGlobs(document.covers, `${at}.covers`, errors);
          if (errors.length === before) covers = expandCovers(document.covers, root, `${at}.covers`, errors, repoFiles);
        }
        if (!Object.hasOwn(document, 'source')) return;
        const source = document.source;
        const problem = repoPathError(source);
        if (problem) return errors.push(`${at}.source ${problem}`);
        if (!source.endsWith('.md')) return errors.push(`${at}.source must be a .md file, got "${source}"`);
        if (sources.has(source)) return errors.push(`${at}.source "${source}" is listed more than once`);
        sources.add(source);
        if (source === landing)
          return errors.push(`${at}.source "${source}" is the landing page; it is already published as index.html`);
        if (isExcluded(source)) errors.push(`${at}.source "${source}" is listed but also matched by exclude`);
        if (!isRepoFile(root, source)) errors.push(`${at}.source "${source}" does not exist (or is outside the repository)`);
        const output = source.replace(/\.md$/, '.html');
        if (outputs.has(output)) errors.push(`${at}.source "${source}" would overwrite the page generated for "${outputs.get(output)}"`);
        outputs.set(output, source);
        documents.push({ source, section: document.section, covers });
      });
  }

  const topics = [];
  if (Object.hasOwn(raw, 'topics')) {
    if (!Array.isArray(raw.topics)) errors.push(`${where}: topics must be an array`);
    else {
      const ids = new Set();
      raw.topics.forEach((topic, index) => {
        const at = `${where}: topics[${index}]`;
        if (!checkKeys(topic, at, TOPIC_KEYS, TOPIC_REQUIRED, errors)) return;
        if (Object.hasOwn(topic, 'id') && checkString(topic.id, `${at}.id`, errors)) {
          if (!TOPIC_ID.test(topic.id)) errors.push(`${at}.id must be a lowercase slug matching ${TOPIC_ID}`);
          else if (ids.has(topic.id)) errors.push(`${at}.id "${topic.id}" is used more than once`);
          ids.add(topic.id);
        }
        if (Object.hasOwn(topic, 'title')) checkString(topic.title, `${at}.title`, errors);
        if (!Object.hasOwn(topic, 'source') || !checkString(topic.source, `${at}.source`, errors)) return;
        const { path: topicPath, anchor } = splitTopicSource(topic.source);
        const problem = repoPathError(topicPath);
        if (problem) return errors.push(`${at}.source path ${problem}`);
        if (anchor !== null && anchor === '') return errors.push(`${at}.source has an empty #anchor`);
        if (!isRepoFile(root, topicPath)) return errors.push(`${at}.source "${topicPath}" does not exist (or is outside the repository)`);
        if (topicPath !== landing && !sources.has(topicPath))
          errors.push(`${at}.source "${topicPath}" is not published; a topic must point at the landing page or a listed document`);
        topics.push({ id: topic.id, title: topic.title, source: topic.source });
      });
    }
  }

  return {
    manifest: {
      schemaVersion: 1,
      product: raw.product,
      title: raw.title,
      tagline: raw.tagline ?? '',
      repo: raw.repo,
      landing,
      documents,
      topics,
      exclude: Array.isArray(exclude) ? exclude : [],
    },
    errors,
  };
}

/** Read and parse docs-kit.json. A missing or unparseable file is a usage error. */
export function readManifestJson(root) {
  const file = path.join(root, MANIFEST_FILE);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT')
      throw new UsageError(`no ${MANIFEST_FILE} in ${root} (run "docs-kit init" to scaffold one)`);
    throw new UsageError(`cannot read ${file}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new UsageError(`${file} is not valid JSON: ${error.message}`);
  }
}

/** Load and validate; throws UsageError listing every manifest problem. */
export function loadManifest(root) {
  const { manifest, errors } = validateManifest(readManifestJson(root), root);
  if (errors.length > 0)
    throw new UsageError(`${MANIFEST_FILE} is invalid:\n${errors.map((error) => `  - ${error}`).join('\n')}`);
  return manifest;
}

/** Strict products.json validation for `hub` and `mcp --hub`. */
export function validateProducts(raw) {
  const errors = [];
  const where = 'products.json';
  if (!checkKeys(raw, where, PRODUCTS_KEYS, PRODUCTS_KEYS, errors)) return { products: [], errors };
  if (Object.hasOwn(raw, 'schemaVersion') && raw.schemaVersion !== 1)
    errors.push(`${where}: schemaVersion must be exactly 1 (got ${JSON.stringify(raw.schemaVersion)})`);
  const products = [];
  if (Object.hasOwn(raw, 'products')) {
    if (!Array.isArray(raw.products)) errors.push(`${where}: products must be an array`);
    else {
      const seen = new Set();
      raw.products.forEach((entry, index) => {
        const at = `${where}: products[${index}]`;
        if (!checkKeys(entry, at, PRODUCT_ENTRY_KEYS, PRODUCT_ENTRY_KEYS, errors)) return;
        const productOk = checkString(entry.product, `${at}.product`, errors) && PRODUCT_SLUG.test(entry.product);
        if (typeof entry.product === 'string' && !PRODUCT_SLUG.test(entry.product))
          errors.push(`${at}.product must be a lowercase slug matching ${PRODUCT_SLUG}`);
        const repoOk = checkString(entry.repo, `${at}.repo`, errors) && REPO.test(entry.repo);
        if (typeof entry.repo === 'string' && !REPO.test(entry.repo)) errors.push(`${at}.repo must be "owner/name"`);
        if (!productOk || !repoOk) return;
        if (entry.repo.split('/')[1] !== entry.product)
          errors.push(`${at}: product "${entry.product}" must equal the repository name in "${entry.repo}"`);
        if (seen.has(entry.product)) errors.push(`${at}.product "${entry.product}" is listed more than once`);
        seen.add(entry.product);
        products.push({ product: entry.product, repo: entry.repo });
      });
    }
  }
  return { products, errors };
}
