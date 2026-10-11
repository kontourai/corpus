import { readFileSync } from 'node:fs';
import { EXIT_GATE, EXIT_OK, EXIT_USAGE, UsageError } from './errors.mjs';
import picomatch from 'picomatch';
import { createAssetPolicy } from './assets.mjs';
import { changedFiles, trackedFiles } from './git.mjs';
import { MANIFEST_FILE, duplicateRedirectKeys, globMatcher, outputPathFor, readManifestJson, splitTopicSource, validateManifest } from './manifest.mjs';
import { analyzeMarkdown, resolveLink, splitFrontMatter } from './markdown.mjs';
import { listFiles, listMarkdownFiles, statInRepo, toFsPath } from './paths.mjs';

/** Lazily lexes repo Markdown so each file is read and analyzed once per run. */
export function createDocumentReader(root) {
  const cache = new Map();
  return (repoPath) => {
    if (!cache.has(repoPath)) {
      // Front matter is stripped once here, so links, anchors, topics, the
      // rendered page, and the bundle markdown all see the same body.
      const { body, lineOffset, title } = splitFrontMatter(readFileSync(toFsPath(root, repoPath), 'utf8'));
      cache.set(repoPath, { markdown: body, lineOffset, analysis: analyzeMarkdown(body, { lineOffset, frontMatterTitle: title }) });
    }
    return cache.get(repoPath);
  };
}

/**
 * Sources that get a page, in site order: landing first, then documents in
 * manifest order, without bundle-only (`publish: false`) documents.
 */
export function publishedSources(manifest) {
  return [manifest.landing, ...manifest.documents.filter((document) => document.publish).map((document) => document.source)];
}

/** Every source in docs-bundle.json: the published pages plus bundle-only documents. */
export function bundledSources(manifest) {
  return [manifest.landing, ...manifest.documents.map((document) => document.source)];
}

/**
 * Gate 2: Markdown links and images, plus raw-HTML href/src/srcset, in
 * published and bundle-only sources. External URLs are not fetched. A leading `/` resolves
 * from --root. References to files under .git or (inside git) untracked or
 * ignored files are unpublishable and fail.
 */
export function checkLinks(root, manifest, read) {
  const failures = [];
  const published = new Set(publishedSources(manifest));
  const assetPolicy = createAssetPolicy(root);
  for (const source of bundledSources(manifest)) {
    const { analysis } = read(source);
    for (const link of analysis.links) {
      const where = `${source}${link.line ? `:${link.line}` : ''}`;
      const at =
        link.kind === 'html' ? `${where}: <... ${link.attr}="${link.href}">` : `${where}: ${link.kind === 'image' ? '!' : ''}[${link.text}](${link.href})`;
      const target = resolveLink(link.href, source);
      if (target.kind === 'external') continue;
      if (target.kind === 'invalid') {
        failures.push(`${at} - ${target.reason}`);
        continue;
      }
      if (target.kind === 'fragment') {
        if (target.fragment && !analysis.anchors.has(target.fragment))
          failures.push(`${at} - missing anchor #${target.fragment} in ${source}`);
        continue;
      }
      const stat = statInRepo(root, target.path);
      if (!stat) {
        failures.push(`${at} - missing target ${target.path || '/'}`);
        continue;
      }
      if (!published.has(target.path)) {
        const policy = assetPolicy(target.path, stat.kind);
        if (policy.action === 'unpublishable') failures.push(`${at} - unpublishable reference: ${target.path} ${policy.reason}`);
      }
      if (target.fragment && stat.kind === 'file' && target.path.endsWith('.md')) {
        const { analysis: targetAnalysis } = read(target.path);
        if (!targetAnalysis.anchors.has(target.fragment))
          failures.push(`${at} - missing anchor #${target.fragment} in ${target.path}`);
      }
    }
  }
  return failures;
}

/** Gate 3: every docs/**\/*.md is listed (bundle-only documents count) or excluded. */
export function checkReachability(root, manifest) {
  const listed = new Set(bundledSources(manifest));
  const isExcluded = globMatcher(manifest.exclude);
  return listMarkdownFiles(root, 'docs')
    .filter((file) => !listed.has(file) && !isExcluded(file))
    .map((file) => `${file} is neither listed in documents nor matched by exclude`);
}

/** Gate 4: topic anchors resolve to headings outside blockquotes and lists (GitHub slug rules). */
export function checkTopics(manifest, read) {
  const failures = [];
  manifest.topics.forEach((topic) => {
    const { path, anchor } = splitTopicSource(topic.source);
    if (anchor === null) return;
    const { analysis } = read(path);
    const matches = analysis.headings.filter((heading) => heading.slug === anchor);
    if (matches.length === 0) {
      const known = analysis.headings.map((heading) => `#${heading.slug}`).slice(0, 12).join(', ');
      failures.push(`topic "${topic.id}": #${anchor} does not match a heading in ${path}${known ? ` (headings: ${known})` : ''}`);
    } else if (!matches.some((heading) => heading.topLevel)) {
      failures.push(`topic "${topic.id}": #${anchor} in ${path} is a heading nested in a quote or list; topics need a heading outside blockquotes and lists`);
    }
  });
  return failures;
}

/** Files every build writes besides pages and copied assets. */
export const SITE_FILES = ['docs-kit.css', '.nojekyll', 'docs-bundle.json', '.docs-kit-build'];

/**
 * The comparison key for output paths: NFC-normalized and lowercased, so two
 * spellings that one file on macOS or Windows would hold compare equal.
 */
export function foldPath(file) {
  return file.normalize('NFC').toLowerCase();
}

/** `a/b/c.html` -> ['a', 'a/b']. */
function ancestors(file) {
  const parts = file.split('/');
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
}

/**
 * Gate 5: every redirects key is written once and overwrites nothing docs-kit
 * generates (compared after NFC normalization and case folding, because macOS
 * and Windows checkouts
 * would clobber), and every source target is published with a resolvable
 * #anchor (the links-gate anchor rule). Copied assets are only known after
 * rendering, so build checks those collisions itself.
 */
export function checkRedirects(root, manifest, read) {
  const failures = [];
  if (manifest.redirects.length === 0) return failures;
  for (const key of duplicateRedirectKeys(readFileSync(toFsPath(root, MANIFEST_FILE), 'utf8')))
    failures.push(`redirects["${key}"] appears more than once in ${MANIFEST_FILE}`);

  const written = new Map(); // lowercased path -> description
  for (const source of publishedSources(manifest)) written.set(foldPath(outputPathFor(manifest, source)), `the page generated for ${source}`);
  for (const file of SITE_FILES) written.set(foldPath(file), `the generated ${file}`);
  const keys = new Map(manifest.redirects.map(({ from }) => [foldPath(from), from]));
  const published = new Set(publishedSources(manifest));

  for (const { from, source, anchor } of manifest.redirects) {
    const at = `redirects["${from}"]`;
    const lower = foldPath(from);
    if (written.has(lower)) failures.push(`${at} would overwrite ${written.get(lower)}`);
    else if (keys.get(lower) !== from) failures.push(`${at} differs only in case or Unicode normalization from redirects["${keys.get(lower)}"]`);
    for (const dir of ancestors(lower)) {
      if (written.has(dir)) failures.push(`${at} needs a directory where docs-kit writes ${written.get(dir)}`);
      else if (keys.has(dir)) failures.push(`${at} needs a directory where redirects["${keys.get(dir)}"] writes a page`);
    }
    for (const [file, what] of written)
      if (ancestors(file).includes(lower)) failures.push(`${at} would occupy a directory that holds ${what}`);

    if (source === undefined) continue;
    if (!statInRepo(root, source)) {
      failures.push(`${at}: target "${source}" does not exist`);
      continue;
    }
    if (!published.has(source)) {
      if (manifest.documents.some((document) => document.source === source))
        failures.push(`${at}: target "${source}" is bundle-only (publish: false) and has no page; a redirect needs a page or an https:// URL`);
      else failures.push(
        `${at}: target "${source}" is not published; a redirect must point at the landing page, a listed document, or an https:// URL`,
      );
      continue;
    }
    if (anchor !== null && !read(source).analysis.anchors.has(anchor))
      failures.push(`${at}: target "${source}#${anchor}" - missing anchor #${anchor} in ${source}`);
  }
  return failures;
}

/**
 * Absolute home-directory paths: `/Users/<name>/`, `/home/<name>/`, and
 * `C:\Users\<name>\` (any drive letter, either slash, doubled backslashes as
 * in escaped JSON). The lookbehind keeps `https://host/home/x/` and
 * `/srv/home/x/` out; `file:///Users/x/` still matches. A name made of
 * placeholder characters (`<name>`, `$USER`, `%USERNAME%`, `{user}`) is not a
 * real path and does not match. `/Users/Shared/` (macOS shared folder) and
 * `/home/runner/` (GitHub Actions runner) are not personal and are exempt.
 */
const LOCAL_PATH = /(?<![\w.~-])(?:\/(?:Users\/(?!Shared\/)|home\/(?!runner\/))[^\s/\\<>"'`$%{}()[\]*]+\/|[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)[^\s/\\<>"'`$%{}()[\]*]+(?:\\|\/))/g;

/**
 * Gate 6: no published or bundled document, nor the landing page, contains an
 * absolute home-directory path, in prose, code, links, or raw HTML. The whole
 * body is scanned as text (front matter is never published). Documents listed
 * in `allowLocalPaths` are skipped.
 */
export function checkLocalPaths(manifest, read) {
  const failures = [];
  const allowed = new Set(manifest.allowLocalPaths);
  for (const source of bundledSources(manifest)) {
    if (allowed.has(source)) continue;
    const { markdown, lineOffset } = read(source);
    markdown.split('\n').forEach((line, index) => {
      for (const [hit] of line.matchAll(LOCAL_PATH))
        failures.push(`${source}:${index + 1 + lineOffset}: local path "${hit}" (list the file in allowLocalPaths if it is a deliberate example)`);
    });
  }
  return failures;
}

/**
 * Gate 7: every `covers` glob matches at least one tracked file (every file
 * outside git). A glob that matches nothing can never mark its document stale.
 */
export function checkCovers(root, manifest) {
  const failures = [];
  let files;
  manifest.documents.forEach((document) => {
    document.covers.forEach((glob, index) => {
      files ??= trackedFiles(root) ?? listFiles(root);
      const matches = picomatch(glob, { dot: true });
      if (files.some((file) => matches(file))) return;
      const written = document.coversAsWritten[index];
      failures.push(`${document.source}: covers "${written}" matches no tracked file${written !== glob ? ` (expanded to "${glob}")` : ''}`);
    });
  });
  return failures;
}

/**
 * Gate 8: a document whose `covers` globs match a changed file must itself be
 * in the change set. Git errors throw UsageError; they never pass silently.
 */
export function checkFreshness(root, manifest, base) {
  const changed = changedFiles(root, base);
  const changedSet = new Set(changed);
  const failures = [];
  for (const document of manifest.documents) {
    if (document.covers.length === 0) continue;
    const covered = changed.filter(globMatcher(document.covers));
    if (covered.length === 0 || changedSet.has(document.source)) continue;
    const sample = covered.slice(0, 5).join(', ') + (covered.length > 5 ? `, +${covered.length - 5} more` : '');
    failures.push(`${document.source} is stale: covered files changed since ${base} (${sample}) but the document did not`);
  }
  return { failures, changedCount: changed.length };
}

/**
 * Run the gates. Returns { exitCode, gates, manifest } and never throws for
 * gate failures. An invalid manifest is a configuration error (exit 2) and the
 * dependent gates are reported as skipped.
 */
export function runChecks({ root, base = null, advisory = false, freshness = true }) {
  const gates = [];
  let exitCode = EXIT_OK;
  const raise = (code) => {
    exitCode = Math.max(exitCode, code);
  };

  const { manifest, errors } = validateManifest(readManifestJson(root), root);
  gates.push({ name: 'manifest', failures: errors, failureExit: EXIT_USAGE });
  if (errors.length > 0) {
    raise(EXIT_USAGE);
    for (const name of ['links', 'reachability', 'topics', 'redirects', 'paths', ...(freshness ? ['covers'] : []), ...(freshness && base ? ['freshness'] : [])])
      gates.push({ name, skipped: `${MANIFEST_FILE} is invalid` });
    return { exitCode, gates, manifest: null };
  }

  const read = createDocumentReader(root);
  for (const [name, run] of [
    ['links', () => checkLinks(root, manifest, read)],
    ['reachability', () => checkReachability(root, manifest)],
    ['topics', () => checkTopics(manifest, read)],
    ['redirects', () => checkRedirects(root, manifest, read)],
    ['paths', () => checkLocalPaths(manifest, read)],
    // covers only feeds freshness, so build (freshness: false) is not blocked by it.
    ...(freshness ? [['covers', () => checkCovers(root, manifest)]] : []),
  ]) {
    const failures = run();
    gates.push({ name, failures });
    if (failures.length > 0) raise(EXIT_GATE);
  }

  if (freshness && base !== null) {
    try {
      const { failures, changedCount } = checkFreshness(root, manifest, base);
      if (advisory) {
        gates.push({ name: 'freshness', failures: [], warnings: failures, note: `${changedCount} changed files since ${base}, advisory` });
      } else {
        gates.push({ name: 'freshness', failures, note: `${changedCount} changed files since ${base}` });
        if (failures.length > 0) raise(EXIT_GATE);
      }
    } catch (error) {
      if (!(error instanceof UsageError)) throw error;
      gates.push({ name: 'freshness', error: error.message });
      raise(EXIT_USAGE);
    }
  }
  return { exitCode, gates, manifest, read };
}

export function formatCheckReport({ gates, exitCode }, root) {
  const lines = [`docs-kit check ${root}`];
  for (const gate of gates) {
    if (gate.skipped) {
      lines.push(`  SKIP ${gate.name} (${gate.skipped})`);
      continue;
    }
    if (gate.error) {
      lines.push(`  ERROR ${gate.name}`);
      lines.push(...gate.error.split('\n').map((line) => `    ${line}`));
      continue;
    }
    const status = gate.failures.length > 0 ? 'FAIL' : gate.warnings?.length ? 'WARN' : 'PASS';
    lines.push(`  ${status} ${gate.name}${gate.note ? ` (${gate.note})` : ''}`);
    for (const failure of gate.failures) lines.push(`    - ${failure}`);
    for (const warning of gate.warnings ?? []) lines.push(`    warning: ${warning}`);
  }
  const failed = gates.reduce((sum, gate) => sum + (gate.failures?.length ?? 0) + (gate.error ? 1 : 0), 0);
  if (exitCode === EXIT_OK) lines.push('docs-kit check passed');
  else if (exitCode === EXIT_USAGE) lines.push(`docs-kit check: configuration error (${failed} problem${failed === 1 ? '' : 's'})`);
  else lines.push(`docs-kit check failed: ${failed} failure${failed === 1 ? '' : 's'}`);
  return lines.join('\n');
}
