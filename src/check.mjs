import { readFileSync } from 'node:fs';
import { EXIT_GATE, EXIT_OK, EXIT_USAGE, UsageError } from './errors.mjs';
import { changedFiles } from './git.mjs';
import { MANIFEST_FILE, globMatcher, readManifestJson, splitTopicSource, validateManifest } from './manifest.mjs';
import { analyzeMarkdown, resolveLink } from './markdown.mjs';
import { listMarkdownFiles, statInRepo, toFsPath } from './paths.mjs';

/** Lazily lexes repo Markdown so each file is read and analyzed once per run. */
export function createDocumentReader(root) {
  const cache = new Map();
  return (repoPath) => {
    if (!cache.has(repoPath)) {
      const markdown = readFileSync(toFsPath(root, repoPath), 'utf8');
      cache.set(repoPath, { markdown, analysis: analyzeMarkdown(markdown) });
    }
    return cache.get(repoPath);
  };
}

/** Published sources in site order: landing first, then documents in manifest order. */
export function publishedSources(manifest) {
  return [manifest.landing, ...manifest.documents.map((document) => document.source)];
}

/** Gate 2: Markdown links and images in published sources. External URLs are not fetched. */
export function checkLinks(root, manifest, read) {
  const failures = [];
  for (const source of publishedSources(manifest)) {
    const { analysis } = read(source);
    for (const link of analysis.links) {
      const at = `${source}${link.line ? `:${link.line}` : ''}: ${link.kind === 'image' ? '!' : ''}[${link.text}](${link.href})`;
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
      if (target.fragment && stat.kind === 'file' && target.path.endsWith('.md')) {
        const { analysis: targetAnalysis } = read(target.path);
        if (!targetAnalysis.anchors.has(target.fragment))
          failures.push(`${at} - missing anchor #${target.fragment} in ${target.path}`);
      }
    }
  }
  return failures;
}

/** Gate 3: every docs/**\/*.md is listed or excluded. */
export function checkReachability(root, manifest) {
  const listed = new Set(publishedSources(manifest));
  const isExcluded = globMatcher(manifest.exclude);
  return listMarkdownFiles(root, 'docs')
    .filter((file) => !listed.has(file) && !isExcluded(file))
    .map((file) => `${file} is neither listed in documents nor matched by exclude`);
}

/** Gate 4: topic anchors resolve to top-level headings (GitHub slug rules). */
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
      failures.push(`topic "${topic.id}": #${anchor} in ${path} is a heading nested in a quote or list; topics need a top-level heading`);
    }
  });
  return failures;
}

/**
 * Gate 5: a document whose `covers` globs match a changed file must itself be
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
    for (const name of ['links', 'reachability', 'topics', ...(freshness && base ? ['freshness'] : [])])
      gates.push({ name, skipped: `${MANIFEST_FILE} is invalid` });
    return { exitCode, gates, manifest: null };
  }

  const read = createDocumentReader(root);
  for (const [name, run] of [
    ['links', () => checkLinks(root, manifest, read)],
    ['reachability', () => checkReachability(root, manifest)],
    ['topics', () => checkTopics(manifest, read)],
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
