import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { contentDigest, readContentManifest } from './content.mjs';
import { readFileAtMergeBase } from './git.mjs';
import { UsageError } from './errors.mjs';
import { statInRepo } from './paths.mjs';

const MANIFEST = 'corpus-content.json';

function currentFile(root, entry) {
  // Freshness stays offline: remote reviews belong to `content check`.
  if (!entry.path || statInRepo(root, entry.path)?.kind !== 'file') return false;
  return contentDigest(readFileSync(path.resolve(root, entry.path)), entry.pointer) === entry.sha256;
}

/** Local, newly recorded byte reviews can justify leaving covering prose unchanged. */
export function reviewedContentDocuments(root, base, documents, changed) {
  const approved = new Set();
  if (!existsSync(path.resolve(root, MANIFEST))) return approved;
  const manifest = readContentManifest(root);
  if (!changed.includes(MANIFEST) || !manifest.reviews?.length) return approved;
  const previousBytes = readFileAtMergeBase(root, base, MANIFEST);
  let previous;
  try { previous = previousBytes === null ? null : JSON.parse(previousBytes); }
  catch { throw new UsageError('content review manifest at the merge base is not valid JSON'); }
  const previousReviews = new Map((previous?.reviews ?? []).map((review) => [review.id, review]));
  for (const review of manifest.reviews) {
    if (JSON.stringify(previousReviews.get(review.id)) === JSON.stringify(review)) continue;
    if (!review.inputs.every((entry) => currentFile(root, entry)) ||
      !review.outputs.every((entry) => currentFile(root, entry))) continue;
    const inputs = new Set(review.inputs.filter((entry) => entry.pointer === undefined).map((entry) => entry.path));
    for (const { source, covered } of documents) {
      if (covered.every((file) => inputs.has(file)) && review.outputs.some((entry) => entry.path === source && entry.pointer === undefined)) approved.add(source);
    }
  }
  return approved;
}
