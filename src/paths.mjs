import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Repo-relative paths in docs-kit.json are POSIX, normalized, and confined to
 * the repository: no absolute paths, no `..` segments, no backslashes.
 * Returns an error string, or null when the path is acceptable.
 */
export function repoPathError(value) {
  if (typeof value !== 'string' || value.length === 0)
    return 'must be a non-empty string';
  if (value.includes('\0')) return 'must not contain NUL';
  if (value.includes('\\')) return 'must use forward slashes';
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value))
    return 'must be relative to the repository root, not absolute';
  if (value.split('/').includes('..'))
    return 'must not contain ".." (paths stay inside the repository)';
  if (path.posix.normalize(value) !== value || value.endsWith('/'))
    return `must be a normalized path (did you mean "${path.posix.normalize(value).replace(/\/$/, '')}"?)`;
  return null;
}

/** The same confinement rules for globs, which may contain wildcards. */
export function repoGlobError(value) {
  if (typeof value !== 'string' || value.trim().length === 0)
    return 'must be a non-empty string';
  if (value.includes('\\')) return 'must use forward slashes';
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value))
    return 'must be relative to the repository root, not absolute';
  if (value.split('/').includes('..'))
    return 'must not contain ".." (globs match paths inside the repository)';
  return null;
}

/** Absolute filesystem path for a repo-relative POSIX path. */
export function toFsPath(root, repoPath) {
  return path.join(root, ...repoPath.split('/').filter(Boolean));
}

/**
 * Stat a repo-relative path only if it exists with exactly this spelling and
 * resolves inside the root. Case-insensitive filesystems (macOS, Windows)
 * would otherwise accept `Docs/A.md` locally and break on Linux CI and GitHub.
 * Returns { kind: 'file' | 'dir' } or null.
 */
export function statInRepo(root, repoPath) {
  const segments = repoPath.split('/').filter(Boolean);
  let current = root;
  for (const segment of segments) {
    let entries;
    try {
      entries = readdirSync(current);
    } catch {
      return null;
    }
    if (!entries.includes(segment)) return null;
    current = path.join(current, segment);
  }
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(current);
    const relative = path.relative(realRoot, real);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    const stat = statSync(current);
    if (stat.isFile()) return { kind: 'file' };
    if (stat.isDirectory()) return { kind: 'dir' };
    return null;
  } catch {
    return null;
  }
}

/** True when the repo-relative path is a regular file inside the root. */
export function isRepoFile(root, repoPath) {
  return statInRepo(root, repoPath)?.kind === 'file';
}

/** Every `*.md` under a repo-relative directory, as sorted repo-relative paths. */
export function listMarkdownFiles(root, directory) {
  const found = [];
  const start = toFsPath(root, directory);
  try {
    if (!lstatSync(start).isDirectory()) return found;
  } catch {
    return found;
  }
  const visit = (fsDir, repoDir) => {
    for (const entry of readdirSync(fsDir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const repoPath = `${repoDir}/${entry.name}`;
      if (entry.isDirectory()) visit(path.join(fsDir, entry.name), repoPath);
      else if (entry.isFile() && entry.name.endsWith('.md')) found.push(repoPath);
    }
  };
  visit(start, directory);
  return found.sort();
}

/** Every file under root (repo-relative), skipping .git and node_modules. Fallback outside git. */
export function listFiles(root) {
  const found = [];
  const visit = (fsDir, repoDir) => {
    for (const entry of readdirSync(fsDir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const repoPath = repoDir ? `${repoDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path.join(fsDir, entry.name), repoPath);
      else if (entry.isFile()) found.push(repoPath);
    }
  };
  visit(root, '');
  return found.sort();
}

/** Relative URL from one generated page to another generated file. */
export function relativeUrl(fromOutput, toOutput) {
  const relative = path.posix.relative(path.posix.dirname(fromOutput), toOutput);
  return encodePath(relative || path.posix.basename(toOutput));
}

export function encodePath(repoPath) {
  return repoPath.split('/').map(encodeURIComponent).join('/');
}
