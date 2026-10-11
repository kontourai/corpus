import { statSync } from 'node:fs';
import { trackedFiles } from './git.mjs';
import { toFsPath } from './paths.mjs';

export const MAX_ASSET_BYTES = 25 * 1024 * 1024;

/**
 * Outside git there is no tracked set, so only these media/document types are
 * copied. Defense in depth: `build` needs a git sha today, so the CLI cannot
 * reach this branch.
 */
const ALLOWED_OUTSIDE_GIT = /\.(?:png|jpe?g|gif|svg|webp|avif|ico|bmp|mp4|webm|pdf|txt|json|css|woff2?|ttf|otf)$/i;

/**
 * Decide what a local reference may become on the published site. One policy
 * for `check` and `build`, so a reference check accepts is one build can
 * publish:
 * - unpublishable: under .git/, or (inside git) a file that is not tracked,
 *   i.e. untracked or git-ignored. These would leak local secrets such as
 *   `.env` or `.git/config`, so they fail with exit 1.
 * - copy: inside git a tracked file, outside git an allowlisted extension;
 *   either way at most MAX_ASSET_BYTES. Only for embedded references.
 * - link: everything else keeps the GitHub blob/tree link.
 */
export function createAssetPolicy(root) {
  let tracked;
  const trackedSet = () => (tracked ??= (() => {
    const files = trackedFiles(root);
    return files === null ? null : new Set(files);
  })());

  return (repoPath, kind, { embed = false } = {}) => {
    if (repoPath.split('/').includes('.git')) return { action: 'unpublishable', reason: 'is inside .git' };
    if (kind !== 'file') return { action: 'link' };
    const set = trackedSet();
    if (set !== null && !set.has(repoPath)) return { action: 'unpublishable', reason: 'is not tracked by git (untracked or ignored)' };
    if (!embed) return { action: 'link' };
    if (set === null && !ALLOWED_OUTSIDE_GIT.test(repoPath)) return { action: 'link' };
    let size;
    try {
      size = statSync(toFsPath(root, repoPath)).size;
    } catch {
      return { action: 'link' };
    }
    if (size > MAX_ASSET_BYTES) return { action: 'link', reason: `is larger than ${MAX_ASSET_BYTES / 1024 / 1024} MB` };
    return { action: 'copy' };
  };
}
