import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { UsageError } from './errors.mjs';
import { isRepoFile, repoGlobError, repoPathError, statInRepo, toFsPath } from './paths.mjs';

export const MANIFEST_FILE = 'corpus.json';
/** The v1 manifest name. Corpus no longer reads it; its presence alone is a usage error. */
export const RETIRED_MANIFEST_FILE = 'docs-kit.json';

/** What a v1 manifest needs to become a v2 corpus.json; shared by every refusal. */
const V2_REMEDY = 'set "schemaVersion": 2, and add "purpose" (one sentence on what the product is for) and "builtOn" (the Kontour products it builds on, or [])';

/** The `purpose` that `corpus init` writes. `check` refuses a manifest whose purpose is exactly this text. */
export const INIT_PURPOSE_PLACEHOLDER = 'TODO: replace with one sentence on the promise this product makes to its users.';

/**
 * The manifest file name for `root`: always corpus.json. A docs-kit.json is
 * refused even next to a corpus.json, so a leftover v1 file can never be read
 * by mistake or disagree silently with the manifest that is.
 */
export function manifestFile(root) {
  const retired = path.join(root, RETIRED_MANIFEST_FILE);
  if (existsSync(retired)) {
    if (existsSync(path.join(root, MANIFEST_FILE)))
      throw new UsageError(
        `${retired} is a retired v1 manifest and Corpus no longer reads it, but it sits next to ${MANIFEST_FILE}; ` +
          `delete ${RETIRED_MANIFEST_FILE} (move anything still needed into ${MANIFEST_FILE} first)`,
      );
    throw new UsageError(
      `${retired} is a retired v1 manifest and Corpus no longer reads it; rename it to ${MANIFEST_FILE}, ${V2_REMEDY}. ` +
        `Or move it aside and run "corpus init" to scaffold a v2 ${MANIFEST_FILE}`,
    );
  }
  return MANIFEST_FILE;
}

export const DEFAULT_LANDING = 'README.md';

const PRODUCT_SLUG = /^[a-z0-9][a-z0-9._-]*$/;
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;
const TOPIC_ID = /^[a-z0-9][a-z0-9._-]*$/;

const MANIFEST_KEYS = ['schemaVersion', 'product', 'title', 'tagline', 'repo', 'landing', 'branch', 'selectionActions', 'documents', 'topics', 'exclude', 'redirects', 'allowLocalPaths', 'purpose', 'builtOn', 'decisions'];
const MANIFEST_REQUIRED = ['schemaVersion', 'product', 'title', 'repo', 'documents', 'purpose', 'builtOn'];
const DOCUMENT_KEYS = ['source', 'section', 'title', 'covers', 'publish'];
const DOCUMENT_REQUIRED = ['source', 'section'];
const TOPIC_KEYS = ['id', 'title', 'source'];
const TOPIC_REQUIRED = ['id', 'title', 'source'];

export const DEFAULT_BRANCH = 'main';
export const SELECTION_PRIMARY_ACTIONS = ['ask', 'challenge-issue'];
const SELECTION_ACTIONS_KEYS = ['primary'];

/**
 * A branch name the Edit link can put in https://github.com/<repo>/edit/<branch>/:
 * the rules of `git check-ref-format --branch`, minus the forms that need a
 * shell (`@{-1}`). Returns an error string or null.
 */
function branchError(name) {
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return 'must not contain whitespace, control characters, or any of ~ ^ : ? * [ \\';
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return 'must not start with "-" or "/" or end with "/" or "."';
  if (name.includes('..') || name.includes('//') || name.includes('@{') || name === '@') return 'must not contain "..", "//", or "@{", and must not be "@"';
  if (name.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))) return 'must not have a component that starts with "." or ends with ".lock"';
  return null;
}

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

/**
 * Expand a bare directory name in `covers` to `dir/**`. Whether each glob
 * matches a tracked file is the `covers` gate in check.mjs, not a manifest
 * error, so a stale glob never blocks build or MCP.
 */
function expandCovers(covers, root) {
  return covers.map((glob) => {
    const bare = glob.replace(/\/+$/, '');
    return !GLOB_CHARS.test(bare) && statInRepo(root, bare)?.kind === 'dir' ? `${bare}/**` : glob;
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

/**
 * A redirects key is the site-relative path of an old page URL. Returns an
 * error string, or null when the key is acceptable.
 */
function redirectKeyError(key) {
  if (key === '') return 'must be a non-empty path';
  if (key.startsWith('/')) return 'must be site-relative, without a leading "/"';
  if (key.includes('..')) return 'must not contain ".."';
  if (/[#?]/.test(key)) return 'must not contain "#" or "?"';
  if (!key.endsWith('.html')) return 'must end in ".html"';
  const problem = repoPathError(key);
  if (problem) return problem;
  if (path.posix.basename(key) === '.html') return 'must name a file before ".html"';
  return null;
}

/**
 * A redirects value is a published source (`path` or `path#anchor`) or an
 * absolute https:// URL. Only the shape is checked here; whether the source is
 * published and the anchor resolves is the `redirects` gate in check.mjs.
 */
function parseRedirectTarget(value) {
  if (typeof value !== 'string' || value.trim() === '') return { error: 'must be a non-empty string' };
  if (value !== value.trim() || /\s/.test(value)) return { error: 'must not contain whitespace' };
  if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//')) {
    let url;
    try {
      url = new URL(value);
    } catch {
      return { error: `"${value}" is not a valid URL` };
    }
    if (url.protocol !== 'https:' || !value.toLowerCase().startsWith('https://') || url.hostname === '')
      return { error: `must be a published source path or an absolute https:// URL, got "${value}"` };
    // Emit the parsed form: `HTTPS:///evil.com/x` validates but must not reach the stub raw.
    return { url: url.href };
  }
  const { path: source, anchor } = splitTopicSource(value);
  const problem = repoPathError(source);
  if (problem) return { error: `path ${problem}` };
  if (!source.endsWith('.md')) return { error: `must be a published .md source or an https:// URL, got "${value}"` };
  if (anchor !== null && anchor === '') return { error: 'has an empty #anchor' };
  return { source, anchor };
}

export function globMatcher(globs = []) {
  if (globs.length === 0) return () => false;
  return picomatch(globs, { dot: true });
}

/**
 * Strict corpus.json (schema v2) validation. Returns { manifest, errors }; `manifest` is
 * normalized (landing defaulted, optional arrays defaulted) and only
 * meaningful when `errors` is empty.
 *
 * `allowMissingDecisionIndex` is for `corpus decisions index` only: a
 * `documents` entry naming the declared `decisions.index` may be absent,
 * because writing that file is the command's job. Every other gate keeps
 * refusing a missing index.
 */
export function validateManifest(raw, root, where = MANIFEST_FILE, { allowMissingDecisionIndex = false } = {}) {
  const errors = [];
  // First, so a v1 manifest leads with the reason instead of its missing v2 keys.
  if (raw?.schemaVersion === 1) errors.push(`${where}: schemaVersion 1 is no longer supported; ${V2_REMEDY}`);
  else if (isPlainObject(raw) && Object.hasOwn(raw, 'schemaVersion') && raw.schemaVersion !== 2)
    errors.push(`${where}: schemaVersion must be 2 (got ${JSON.stringify(raw.schemaVersion)})`);
  if (!checkKeys(raw, where, MANIFEST_KEYS, MANIFEST_REQUIRED, errors)) return { manifest: null, errors };

  if (Object.hasOwn(raw, 'purpose')) checkString(raw.purpose, `${where}: purpose`, errors);
  if (Object.hasOwn(raw, 'builtOn')) {
    if (!Array.isArray(raw.builtOn)) errors.push(`${where}: builtOn must be an array`);
    else raw.builtOn.forEach((entry, index) => {
      const at = `${where}: builtOn[${index}]`;
      if (!checkKeys(entry, at, ['product', 'via', 'for', 'evidence', 'bin'], ['product', 'via', 'for'], errors)) return;
      for (const key of ['product', 'for']) checkString(entry[key], `${at}.${key}`, errors);
      if (Array.isArray(entry.via)) {
        if (entry.via.length === 0) errors.push(`${at}.via must be a non-empty array`);
        entry.via.forEach((via, index) => checkString(via, `${at}.via[${index}]`, errors));
      } else checkString(entry.via, `${at}.via`, errors);
      if (Object.hasOwn(entry, 'bin') && (typeof entry.bin !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(entry.bin))) errors.push(`${at}.bin must be a bare CLI executable name`);
      if (Object.hasOwn(entry, 'evidence') && entry.evidence !== 'cli') errors.push(`${at}.evidence must be "cli"`);
      if (typeof entry.product === 'string' && !PRODUCT_SLUG.test(entry.product)) errors.push(`${at}.product must be a lowercase slug`);
    });
  }

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

  if (Object.hasOwn(raw, 'branch') && checkString(raw.branch, `${where}: branch`, errors)) {
    const problem = branchError(raw.branch);
    if (problem) errors.push(`${where}: branch "${raw.branch}" ${problem}`);
  }
  let selectionPrimary = 'ask';
  if (Object.hasOwn(raw, 'selectionActions')) {
    const at = `${where}: selectionActions`;
    if (checkKeys(raw.selectionActions, at, SELECTION_ACTIONS_KEYS, SELECTION_ACTIONS_KEYS, errors) && Object.hasOwn(raw.selectionActions, 'primary')) {
      if (SELECTION_PRIMARY_ACTIONS.includes(raw.selectionActions.primary)) selectionPrimary = raw.selectionActions.primary;
      else errors.push(`${at}.primary must be one of ${SELECTION_PRIMARY_ACTIONS.map((name) => `"${name}"`).join(', ')} (got ${JSON.stringify(raw.selectionActions.primary)})`);
    }
  }

  const exclude = Object.hasOwn(raw, 'exclude') ? raw.exclude : [];
  if (Object.hasOwn(raw, 'exclude')) checkGlobs(raw.exclude, `${where}: exclude`, errors);
  const isExcluded = Array.isArray(exclude) && exclude.every((glob) => !repoGlobError(glob)) ? globMatcher(exclude) : () => false;

  const pendingIndex = allowMissingDecisionIndex ? declaredDecisionIndex(raw.decisions) : null;
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
        if (Object.hasOwn(document, 'title')) checkString(document.title, `${at}.title`, errors);
        if (Object.hasOwn(document, 'publish') && typeof document.publish !== 'boolean')
          errors.push(`${at}.publish must be a boolean (got ${JSON.stringify(document.publish)})`);
        let covers = [];
        if (Object.hasOwn(document, 'covers')) {
          const before = errors.length;
          checkGlobs(document.covers, `${at}.covers`, errors);
          if (errors.length === before) covers = expandCovers(document.covers, root);
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
        if (!isRepoFile(root, source) && !(source === pendingIndex && isAbsent(root, source)))
          errors.push(`${at}.source "${source}" does not exist (or is outside the repository)`);
        // A bundle-only document (publish: false) has no page, so it cannot collide with one.
        if (document.publish !== false) {
          const output = source.replace(/\.md$/, '.html');
          if (outputs.has(output)) errors.push(`${at}.source "${source}" would overwrite the page generated for "${outputs.get(output)}"`);
          outputs.set(output, source);
        }
        documents.push({
          source,
          section: document.section,
          title: document.title ?? null,
          covers,
          coversAsWritten: document.covers ?? [],
          publish: document.publish !== false,
        });
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
          errors.push(`${at}.source "${topicPath}" is not listed; a topic must point at the landing page or a listed document`);
        topics.push({ id: topic.id, title: topic.title, source: topic.source });
      });
    }
  }

  const redirects = [];
  if (Object.hasOwn(raw, 'redirects')) {
    if (!isPlainObject(raw.redirects)) errors.push(`${where}: redirects must be an object mapping old paths to targets`);
    else
      for (const [from, to] of Object.entries(raw.redirects)) {
        const at = `${where}: redirects["${from}"]`;
        const keyProblem = redirectKeyError(from);
        if (keyProblem) errors.push(`${at}: key ${keyProblem}`);
        const target = parseRedirectTarget(to);
        if (target.error) errors.push(`${at}: target ${target.error}`);
        if (!keyProblem && !target.error) redirects.push({ from, ...target });
      }
  }

  const allowLocalPaths = [];
  if (Object.hasOwn(raw, 'allowLocalPaths')) {
    if (!Array.isArray(raw.allowLocalPaths)) errors.push(`${where}: allowLocalPaths must be an array of document paths`);
    else
      raw.allowLocalPaths.forEach((entry, index) => {
        const at = `${where}: allowLocalPaths[${index}]`;
        const problem = repoPathError(entry);
        if (problem) return errors.push(`${at} ${problem}`);
        // Exact paths only: a glob would silently exempt documents added later.
        if (GLOB_CHARS.test(entry)) return errors.push(`${at} "${entry}" must be an exact document path; globs are not allowed`);
        if (entry !== landing && !sources.has(entry))
          return errors.push(`${at} "${entry}" is not a document; list the landing page or a documents[] source`);
        if (allowLocalPaths.includes(entry)) return errors.push(`${at} "${entry}" is listed more than once`);
        allowLocalPaths.push(entry);
      });
  }

  const decisions = Object.hasOwn(raw, 'decisions') ? validateDecisionsBlock(raw.decisions, root, `${where}: decisions`, errors) : null;

  return {
    manifest: {
      schemaVersion: raw.schemaVersion,
      purpose: raw.purpose,
      builtOn: raw.builtOn,
      product: raw.product,
      title: raw.title,
      tagline: raw.tagline ?? '',
      repo: raw.repo,
      landing,
      branch: typeof raw.branch === 'string' ? raw.branch : DEFAULT_BRANCH,
      selectionActions: { primary: selectionPrimary },
      documents,
      topics,
      exclude: Array.isArray(exclude) ? exclude : [],
      redirects,
      allowLocalPaths,
      decisions,
    },
    errors,
  };
}

export const DEFAULT_DECISIONS_DIR = 'docs/decisions';
export const DEFAULT_ADR_DIR = 'docs/adr';

/**
 * The index path a raw `decisions` block names, before validation (null when
 * it names none). The block is still validated in full, so a malformed one
 * fails the manifest either way.
 */
function declaredDecisionIndex(value) {
  if (!isPlainObject(value)) return null;
  const dir = Object.hasOwn(value, 'dir') ? value.dir : DEFAULT_DECISIONS_DIR;
  const index = Object.hasOwn(value, 'index') ? value.index : `${dir}/index.md`;
  return typeof index === 'string' ? index : null;
}

/** True only when nothing at all is at the repo-relative path: not a symlink, directory, or other file. */
function isAbsent(root, repoPath) {
  try {
    lstatSync(toFsPath(root, repoPath));
    return false;
  } catch (error) {
    return error.code === 'ENOENT' || error.code === 'ENOTDIR';
  }
}

/** null when nothing is at the repo-relative path; otherwise whether it is a real directory inside the repository. */
function directoryState(root, repoPath) {
  let stat;
  try {
    stat = lstatSync(toFsPath(root, repoPath));
  } catch {
    return null;
  }
  return stat.isDirectory() && statInRepo(root, repoPath)?.kind === 'dir' ? 'dir' : 'other';
}

/**
 * The optional v2 `decisions` block: `{ dir?, index?, adr?: { dir? } }`.
 * `dir` defaults to docs/decisions and need not exist yet (`corpus decisions
 * index` creates it); `index` defaults to `<dir>/index.md` and must sit
 * directly in `dir`. Declaring `adr` freezes `adr.dir`, which must exist.
 */
function validateDecisionsBlock(value, root, at, errors) {
  const before = errors.length;
  if (!checkKeys(value, at, ['dir', 'index', 'adr'], [], errors)) return null;
  const pathOk = (repoPath, where) => {
    const problem = repoPathError(repoPath);
    if (problem) errors.push(`${where} ${problem}`);
    return !problem;
  };
  const dir = Object.hasOwn(value, 'dir') ? value.dir : DEFAULT_DECISIONS_DIR;
  const dirOk = pathOk(dir, `${at}.dir`);
  if (dirOk && directoryState(root, dir) === 'other')
    errors.push(`${at}.dir "${dir}" is not a directory inside the repository`);
  const index = Object.hasOwn(value, 'index') ? value.index : `${dir}/index.md`;
  if (pathOk(index, `${at}.index`) && dirOk) {
    if (!index.endsWith('.md')) errors.push(`${at}.index must be a .md file, got "${index}"`);
    else if (path.posix.dirname(index) !== dir) errors.push(`${at}.index "${index}" must be directly inside decisions.dir "${dir}"`);
  }
  let adr = null;
  if (Object.hasOwn(value, 'adr') && checkKeys(value.adr, `${at}.adr`, ['dir'], [], errors)) {
    const adrDir = Object.hasOwn(value.adr, 'dir') ? value.adr.dir : DEFAULT_ADR_DIR;
    if (pathOk(adrDir, `${at}.adr.dir`)) {
      // A frozen directory that does not exist would never refuse anything, so a typo must not pass.
      if (directoryState(root, adrDir) !== 'dir') errors.push(`${at}.adr.dir "${adrDir}" is not an existing directory inside the repository`);
      if (dirOk && (adrDir === dir || adrDir.startsWith(`${dir}/`) || dir.startsWith(`${adrDir}/`)))
        errors.push(`${at}.adr.dir "${adrDir}" must not overlap decisions.dir "${dir}"`);
    }
    adr = { dir: adrDir };
  }
  return errors.length === before ? { dir, index, adr } : null;
}

/**
 * JSON.parse keeps only the last of two equal keys, so a repeated redirects
 * key would vanish silently. Scan the manifest text (already known to be valid
 * JSON) and return every key that appears more than once in the top-level
 * `redirects` object.
 */
export function duplicateRedirectKeys(text) {
  const STRING = /"(?:[^"\\]|\\.)*"/y;
  const WS = /\s*/y;
  let i = 0;
  const skip = () => {
    WS.lastIndex = i;
    WS.exec(text);
    i = WS.lastIndex;
  };
  const string = () => {
    STRING.lastIndex = i;
    const match = STRING.exec(text);
    i = STRING.lastIndex;
    return JSON.parse(match[0]);
  };
  const duplicates = [];
  const value = (keyPath) => {
    skip();
    if (text[i] === '{') {
      i += 1;
      const seen = new Set();
      skip();
      while (text[i] !== '}') {
        skip();
        const key = string();
        if (keyPath.length === 1 && keyPath[0] === 'redirects') {
          if (seen.has(key) && !duplicates.includes(key)) duplicates.push(key);
          seen.add(key);
        }
        skip();
        i += 1; // ':'
        value([...keyPath, key]);
        skip();
        if (text[i] === ',') i += 1;
        skip();
      }
      i += 1;
    } else if (text[i] === '[') {
      i += 1;
      skip();
      while (text[i] !== ']') {
        value([...keyPath, null]);
        skip();
        if (text[i] === ',') i += 1;
        skip();
      }
      i += 1;
    } else if (text[i] === '"') string();
    else {
      const scalar = /-?[0-9][0-9.eE+-]*|true|false|null/y;
      scalar.lastIndex = i;
      scalar.exec(text);
      i = scalar.lastIndex;
    }
  };
  value([]);
  return duplicates;
}

/** Read and parse corpus.json. A missing, unparseable, or retired (docs-kit.json) manifest is a usage error. */
export function readManifestJson(root) {
  const file = path.join(root, manifestFile(root));
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT')
      throw new UsageError(`no ${MANIFEST_FILE} in ${root} (run "corpus init" to scaffold one)`);
    throw new UsageError(`cannot read ${file}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new UsageError(`${file} is not valid JSON: ${error.message}`);
  }
}

/** Load and validate; throws UsageError listing every manifest problem. */
export function loadManifest(root, options = {}) {
  const { manifest, errors } = validateManifest(readManifestJson(root), root, manifestFile(root), options);
  if (errors.length > 0)
    throw new UsageError(`${manifestFile(root)} is invalid:\n${errors.map((error) => `  - ${error}`).join('\n')}`);
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
