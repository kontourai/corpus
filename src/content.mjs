import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { UsageError } from './errors.mjs';
import { changedFiles } from './git.mjs';
import { repoGlobError, repoPathError } from './paths.mjs';

const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const fail = (message) => { throw new UsageError(`content: NOT_VERIFIED: ${message}`); };
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function keys(value, allowed, required, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))) fail(`${label}: invalid or unknown fields`);
}

/** GitHub blob URLs identify a repository, ref and file independently of checkout layout. */
export function githubContentReference(value) {
  let url;
  try { url = new URL(value); } catch { fail(`invalid GitHub file URL: ${value}`); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash)
    fail(`expected a GitHub HTTPS blob URL without credentials, query or fragment: ${value}`);
  const parts = url.pathname.slice(1).split('/').map((part) => {
    try { return decodeURIComponent(part); } catch { fail(`invalid URL encoding: ${value}`); }
  });
  const [owner, repo, kind, ref, ...file] = parts;
  const repository = `${owner}/${repo}`;
  const source = file.join('/');
  if (!REPO.test(repository) || kind !== 'blob' || !ref || /[\\\s?#]/.test(ref) || repoPathError(source) || source.startsWith('.git/'))
    fail(`expected https://github.com/owner/repo/blob/ref/path: ${value}`);
  return { repository, ref, path: source };
}

function nonemptyArray(value, label) {
  if (!Array.isArray(value) || !value.length) fail(`${label} must be a nonempty array`);
}

function files(entries, label) {
  nonemptyArray(entries, label);
  const identities = new Set();
  for (const entry of entries) {
    keys(entry, ['path', 'url', 'sha256', 'revision'], ['sha256'], label);
    if (Boolean(entry.path) === Boolean(entry.url) || !SHA.test(entry.sha256)) fail(`${label}: expected one path or URL and a SHA-256`);
    if (entry.url) {
      githubContentReference(entry.url);
      if (!COMMIT.test(entry.revision)) fail(`${label}: remote files need the reviewed full commit revision`);
    } else if (repoPathError(entry.path) || entry.path.startsWith('.git/') || entry.revision !== undefined) fail(`${label}: invalid local file`);
    const identity = entry.path ?? entry.url;
    if (identities.has(identity)) fail(`${label}: duplicate file ${identity}`);
    identities.add(identity);
  }
}

export function readContentManifest(root, manifest = 'corpus-content.json') {
  let raw;
  try { raw = JSON.parse(readFileSync(path.resolve(root, manifest), 'utf8')); }
  catch (error) { fail(`cannot read ${manifest}: ${error.message}`); }
  keys(raw, ['schemaVersion', 'repository', 'relationships', 'reviews'], ['schemaVersion', 'repository'], 'manifest');
  if (raw.schemaVersion !== 1 || !REPO.test(raw.repository)) fail('expected schemaVersion 1 and an owner/repo repository');
  if (raw.relationships === undefined && raw.reviews === undefined) fail('manifest needs relationships or reviews');
  if ((raw.relationships !== undefined && !Array.isArray(raw.relationships)) ||
    (raw.reviews !== undefined && !Array.isArray(raw.reviews))) fail('relationships and reviews must be arrays');
  const ids = new Set();
  for (const relation of raw.relationships ?? []) {
    keys(relation, ['id', 'covers', 'targets'], ['id', 'covers', 'targets'], 'relationship');
    if (typeof relation.id !== 'string' || !relation.id || ids.has(relation.id)) fail('relationship IDs must be nonempty and unique');
    ids.add(relation.id);
    nonemptyArray(relation.covers, 'covers');
    if (relation.covers.some((glob) => repoGlobError(glob))) fail(`${relation.id}: invalid covers glob`);
    nonemptyArray(relation.targets, 'targets');
    for (const url of relation.targets) githubContentReference(url);
  }
  ids.clear();
  for (const review of raw.reviews ?? []) {
    keys(review, ['id', 'reviewedAt', 'note', 'limits', 'inputs', 'outputs'], ['id', 'reviewedAt', 'note', 'limits', 'inputs', 'outputs'], 'review');
    if (typeof review.id !== 'string' || !review.id || ids.has(review.id)) fail('review IDs must be nonempty and unique');
    ids.add(review.id);
    if (typeof review.reviewedAt !== 'string' || !Number.isFinite(Date.parse(review.reviewedAt)) ||
      typeof review.note !== 'string' || !review.note.trim() || typeof review.limits !== 'string' || !review.limits.trim()) fail(`${review.id}: date, review note and limits are required`);
    files(review.inputs, `${review.id} inputs`);
    files(review.outputs, `${review.id} outputs`);
  }
  return raw;
}

export function contentImpact(manifest, changed) {
  if (!Array.isArray(manifest.relationships) || !manifest.relationships.length) fail('impact needs declared relationships');
  if (!Array.isArray(changed) || changed.some((file) => repoPathError(file))) fail('changed files must be repository-relative paths');
  return manifest.relationships.flatMap(({ id, covers, targets }) => {
    const matches = picomatch(covers.map((glob) => glob.endsWith('/') ? `${glob}**` : glob), { dot: true });
    const changedBy = [...new Set(changed)].filter((file) => matches(file)).sort();
    return changedBy.length ? [{ id, targets, changedBy }] : [];
  });
}

function localBytes(root, file) {
  if (repoPathError(file)) fail(`invalid local path ${file}`);
  try {
    const base = realpathSync(root);
    const target = realpathSync(path.resolve(base, file));
    const within = path.relative(base, target);
    if (within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) fail(`file escapes checkout: ${file}`);
    return readFileSync(target);
  } catch (error) { fail(`cannot read ${file}: ${error.message}`); }
}

async function githubJson(endpoint) {
  const headers = { Accept: 'application/vnd.github+json' };
  // Credentials go only to GitHub's API, never to file URLs or redirects.
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(`https://api.github.com/${endpoint}`, { headers, redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!response.ok) fail(`GitHub lookup returned ${response.status}: ${endpoint}`);
  return response.json();
}

function checkoutMap(values) {
  const entries = new Map();
  for (const value of values) {
    const split = value.indexOf('=');
    const repository = value.slice(0, split);
    const directory = value.slice(split + 1);
    if (split < 1 || !REPO.test(repository) || !directory || entries.has(repository)) fail('checkout must be a unique owner/repo=/directory mapping');
    entries.set(repository, path.resolve(directory));
  }
  return entries;
}

/** Check declared byte freshness. Checkout mappings explicitly select working bytes, without network. */
export async function checkContentReviews(root, manifest, checkouts = []) {
  nonemptyArray(manifest.reviews, 'check reviews');
  const local = checkoutMap(checkouts);
  const revisions = new Map();
  const bytes = new Map();
  const observedRevisions = {};
  const read = async (entry) => {
    if (entry.path) return localBytes(root, entry.path);
    const source = githubContentReference(entry.url);
    if (local.has(source.repository)) {
      observedRevisions[source.repository] = 'local working bytes (explicit checkout mapping)';
      return localBytes(local.get(source.repository), source.path);
    }
    const key = `${source.repository}@${source.ref}`;
    if (!revisions.has(key)) {
      const result = await githubJson(`repos/${source.repository}/commits/${encodeURIComponent(source.ref)}`);
      if (!COMMIT.test(result.sha)) fail(`GitHub returned an invalid revision for ${key}`);
      revisions.set(key, result.sha);
      observedRevisions[key] = result.sha;
    }
    const revision = revisions.get(key);
    const fileKey = `${source.repository}@${revision}/${source.path}`;
    if (!bytes.has(fileKey)) {
      const result = await githubJson(`repos/${source.repository}/contents/${source.path.split('/').map(encodeURIComponent).join('/')}?ref=${revision}`);
      if (result.type !== 'file' || result.encoding !== 'base64' || typeof result.content !== 'string') fail(`GitHub did not return file bytes for ${entry.url}`);
      bytes.set(fileKey, Buffer.from(result.content, 'base64'));
    }
    return bytes.get(fileKey);
  };
  const failures = [];
  for (const review of manifest.reviews) {
    for (const [kind, entries] of [['input', review.inputs], ['output', review.outputs]]) {
      for (const entry of entries) {
        if (hash(await read(entry)) !== entry.sha256) failures.push(`${review.id}: changed ${kind}: ${entry.url ?? entry.path}`);
      }
    }
  }
  return {
    schemaVersion: 1, command: 'content check', verdict: failures.length ? 'fail' : 'pass',
    exitCode: failures.length ? 1 : 0, failures, observedRevisions,
    limits: 'Freshness of declared bytes only; not semantic correctness, complete dependency coverage, legal classification, release availability or deployment. Re-review claims before changing hashes.',
  };
}

export async function runContent({ root, manifest, mode, base, changed = [], checkouts = [] }) {
  const reviewed = readContentManifest(root, manifest);
  if (mode === 'check') {
    try { return await checkContentReviews(root, reviewed, checkouts); }
    catch (error) { fail(error.message); }
  }
  if (base !== undefined && changed.length) fail('choose --base or --changed-file, not both');
  if (base === undefined && !changed.length) fail('impact needs --base or --changed-file');
  return {
    schemaVersion: 1, command: 'content impact', verdict: 'advisory', exitCode: 0,
    repository: reviewed.repository, surfaces: contentImpact(reviewed, base === undefined ? changed : changedFiles(root, base)),
    limits: 'Declared relationships are review leads, not proof that claims changed or a complete dependency graph.',
  };
}
