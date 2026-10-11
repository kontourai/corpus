import { execFileSync } from 'node:child_process';
import { UsageError } from './errors.mjs';

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function gitError(error) {
  const stderr = error?.stderr?.toString().trim();
  return stderr || error?.message || String(error);
}

/** HEAD commit of the checkout containing `root`, or throws UsageError. */
export function headSha(root) {
  try {
    return git(root, ['rev-parse', '--verify', 'HEAD']).trim();
  } catch (error) {
    throw new UsageError(
      `cannot read the git HEAD of ${root}: ${gitError(error)}\n` +
        'docs-kit needs a git checkout with at least one commit to stamp the bundle sha.',
    );
  }
}

/** HEAD sha, or null when `root` is not a git checkout (in-memory MCP use). */
export function headShaOrNull(root) {
  try {
    return git(root, ['rev-parse', '--verify', 'HEAD']).trim();
  } catch {
    return null;
  }
}

/**
 * Path of `root` relative to the git top level, with a trailing slash ('' at
 * the top level). Blob links need it when the docs root is a subdirectory.
 */
export function repoPrefix(root) {
  try {
    return git(root, ['rev-parse', '--show-prefix']).trim();
  } catch {
    return '';
  }
}

/**
 * Files changed between the merge base of `base` and HEAD, relative to `root`
 * (`--relative` also limits the diff to that subtree). A bad ref or a missing
 * repository is a usage error, never an empty change set.
 */
export function changedFiles(root, base) {
  if (typeof base !== 'string' || base.trim() === '' || base.startsWith('-'))
    throw new UsageError(`--base must be a git ref, got "${base}"`);
  try {
    git(root, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  } catch (error) {
    throw new UsageError(
      `--base ${base} does not resolve to a commit in ${root}` +
        (gitError(error) ? `: ${gitError(error)}` : '') +
        '\n(in CI, fetch the base branch, e.g. actions/checkout with fetch-depth: 0)',
    );
  }
  try {
    // --no-renames lists a renamed file's old path too, so covers on it still match.
    return git(root, ['diff', '--name-only', '--no-renames', '--relative', '-z', `${base}...HEAD`])
      .split('\0')
      .filter(Boolean);
  } catch (error) {
    throw new UsageError(`git diff ${base}...HEAD failed: ${gitError(error)}`);
  }
}

/**
 * Tracked files under `root` (repo-relative to root), or null outside git.
 * `git ls-files` lists paths relative to the working directory and limits
 * them to that subtree.
 */
export function trackedFiles(root) {
  try {
    return git(root, ['ls-files', '-z', '--cached']).split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

/** True when the checkout has uncommitted changes (tracked or untracked). */
export function isDirty(root) {
  try {
    return git(root, ['status', '--porcelain', '--untracked-files=normal', '--', '.']).trim() !== '';
  } catch {
    return false;
  }
}

/** `owner/name` from the origin remote, or null. Used only by `init`. */
export function originRepo(root) {
  try {
    const url = git(root, ['remote', 'get-url', 'origin']).trim();
    const match = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
    return match ? `${match[1]}/${match[2]}` : null;
  } catch {
    return null;
  }
}
