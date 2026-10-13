import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { UsageError } from './errors.mjs';
import { originRepo } from './git.mjs';
import { DEFAULT_LANDING, MANIFEST_FILE, manifestFile } from './manifest.mjs';
import { isRepoFile, listMarkdownFiles } from './paths.mjs';

function titleCase(value) {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

/** Section guess: the first directory under docs/, or "Documentation" for docs/*.md. */
export function guessSection(source) {
  const parts = source.split('/');
  return parts.length > 2 ? titleCase(parts[1]) : 'Documentation';
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '') || 'product';
}

/** `docs-kit init`: write a starter docs-kit.json; never overwrite one. */
export function runInit({ root }) {
  const target = path.join(root, MANIFEST_FILE);
  const existing = path.join(root, manifestFile(root));
  if (existsSync(existing)) throw new UsageError(`${existing} already exists; refusing to overwrite it`);

  const repo = originRepo(root) ?? `kontourai/${slugify(path.basename(path.resolve(root)))}`;
  const product = repo.split('/')[1];
  let tagline = '';
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (typeof pkg.description === 'string') tagline = pkg.description.trim();
  } catch {
    // No package.json, or not JSON: leave the tagline for the author.
  }

  const manifest = {
    schemaVersion: 1,
    product,
    title: titleCase(product),
    tagline,
    repo,
    landing: DEFAULT_LANDING,
    documents: listMarkdownFiles(root, 'docs').map((source) => ({ source, section: guessSection(source) })),
    topics: [],
    exclude: [],
  };
  writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
  const notes = [`docs-kit init: wrote ${target} with ${manifest.documents.length} documents`];
  if (!isRepoFile(root, DEFAULT_LANDING)) notes.push(`  note: ${DEFAULT_LANDING} does not exist; create it or set "landing"`);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(product)) notes.push(`  note: product "${product}" is not a lowercase slug; adjust product and repo`);
  notes.push('  next: review sections and order, move unpublished docs to "exclude", add "topics" and "covers", then run docs-kit check');
  return notes.join('\n');
}
