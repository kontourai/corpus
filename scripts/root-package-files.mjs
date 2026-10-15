// What the published @kontourai/corpus tarball may contain, written out
// independently of package.json `files` so that widening `files` (or a new
// top-level directory slipping in) fails the pack checks instead of shipping.
import { execFileSync } from 'node:child_process';
import { gitEnv } from '../src/git.mjs';

/** Exact top-level files. npm adds package.json itself. */
export const ALLOWED_FILES = ['LICENSE', 'README.md', 'package.json'];
/** Directories shipped whole: the CLI entry points, its sources, and public schemas. */
export const ALLOWED_DIRECTORIES = ['bin/', 'src/', 'schemas/'];
/** Paths a consumer cannot work without, checked by name. */
export const REQUIRED_FILES = [
  'bin/corpus.mjs',
  'bin/docs-kit.mjs',
  'src/index.mjs',
  'src/cli.mjs',
  'src/site-client.js',
  'schemas/decision-record.schema.json',
];

/** Tracked files under the shipped directories, so a source file left out of the tarball is caught too. */
export function trackedShippedFiles(repo) {
  return execFileSync('git', ['ls-files', '-z', '--', ...ALLOWED_DIRECTORIES], { cwd: repo, env: gitEnv(), encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

/** Every problem with a packed file list, or [] when it matches the allow-list. */
export function packedFileProblems(paths, tracked) {
  const problems = [];
  const packed = new Set(paths);
  for (const path of paths) {
    if (!ALLOWED_FILES.includes(path) && !ALLOWED_DIRECTORIES.some((directory) => path.startsWith(directory))) problems.push(`not allowed in the tarball: ${path}`);
  }
  for (const path of [...ALLOWED_FILES, ...REQUIRED_FILES, ...tracked]) {
    if (!packed.has(path)) problems.push(`missing from the tarball: ${path}`);
  }
  return [...new Set(problems)];
}
