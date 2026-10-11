import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { assembleBundle, defaultSiteUrl, normalizeBaseUrl } from './bundle.mjs';
import { formatCheckReport, publishedSources, runChecks } from './check.mjs';
import { EXIT_OK, GateFailure, UsageError } from './errors.mjs';
import { gitEnv, headSha, repoPrefix, trackedFiles } from './git.mjs';
import { execFileSync } from 'node:child_process';
import { outputPathFor } from './manifest.mjs';
import { analyzeMarkdown, documentTitle, extractHtmlAnchors, extractHtmlReferences, firstParagraph, resolveLink, rewriteHtmlReferences } from './markdown.mjs';
import { encodePath, relativeUrl, statInRepo, toFsPath } from './paths.mjs';
import { SITE_CSS, escapeHtml, sitePage } from './site-template.mjs';

const IMAGE_FILE = /\.(?:png|jpe?g|gif|svg|webp|avif|ico|bmp)$/i;
const SAFE_EXTERNAL = /^(?:https?:|mailto:|\/\/)/i;
const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif);/i;

/**
 * Every product site shares the https://kontourai.github.io origin, so a
 * script in one product's docs could act on every other product's pages.
 * Rendered Markdown is sanitized to GitHub-like output: no script/style, no
 * on* handlers, and only http(s)/mailto URLs (plus data: images).
 */
const SANITIZE_OPTIONS = {
  allowedTags: [
    ...new Set([
      ...sanitizeHtml.defaults.allowedTags,
      'img', 'picture', 'source', 'video', 'h1', 'h2', 'details', 'summary', 'del', 'ins', 's', 'kbd', 'sup', 'sub', 'input', 'div', 'span',
    ]),
  ],
  allowedAttributes: {
    '*': ['id', 'class', 'title', 'align', 'dir', 'lang', 'aria-label', 'aria-hidden'],
    a: ['href', 'name'],
    img: ['src', 'srcset', 'alt', 'width', 'height', 'loading'],
    source: ['src', 'srcset', 'media', 'type'],
    video: ['src', 'controls', 'width', 'height', 'poster', 'muted', 'loop', 'autoplay', 'playsinline'],
    details: ['open'],
    input: ['type', 'checked', 'disabled'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan'],
    ol: ['start'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'], source: ['http', 'https', 'data'], video: ['http', 'https'] },
  allowProtocolRelative: true,
};

/**
 * Map a link written in `fromSource` to its URL on the generated site:
 * published docs become their pages, local images and embedded media are copied, other repo
 * files go to GitHub at the built commit, and unsafe schemes are neutralized.
 * Unresolvable local targets are left as written so the generated-site check
 * reports them.
 */
function createHrefRewriter({ root, manifest, sha, prefix, published, assets }) {
  const blobBase = `https://github.com/${manifest.repo}`;
  return (href, fromSource, { image = false } = {}) => {
    const fromOutput = outputPathFor(manifest, fromSource);
    const target = resolveLink(href, fromSource);
    if (target.kind === 'external') {
      const trimmed = href.trim();
      if (SAFE_EXTERNAL.test(trimmed) || (image && SAFE_DATA_IMAGE.test(trimmed))) return trimmed;
      return '#';
    }
    if (target.kind !== 'local') return href;
    const hash = target.rawFragment ? `#${target.rawFragment}` : '';
    if (published.has(target.path)) return `${relativeUrl(fromOutput, outputPathFor(manifest, target.path))}${hash}`;
    const stat = statInRepo(root, target.path);
    if (!stat) return href;
    // Embedded resources (Markdown images, src, srcset: images, video, audio)
    // are copied; plain links copy only image files.
    if (stat.kind === 'file' && (image || IMAGE_FILE.test(target.path))) {
      assets.add(target.path);
      return relativeUrl(fromOutput, target.path);
    }
    const kind = stat.kind === 'dir' ? 'tree' : 'blob';
    return `${blobBase}/${kind}/${sha}/${encodePath(`${prefix}${target.path}`).replace(/\/$/, '')}${hash}`;
  };
}

function renderMarkdown(markdown, fromSource, rewrite) {
  const md = new Marked({ gfm: true });
  md.use({
    renderer: {
      heading(token) {
        const inner = this.parser.parseInline(token.tokens);
        const id = escapeHtml(token.slugId);
        return `<h${token.depth} id="${id}">${inner}<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h${token.depth}>\n`;
      },
    },
  });
  // analyzeMarkdown assigns GitHub slugs in walk order; reuse it so page ids
  // and the anchors the gates validated are the same function.
  const { tokens } = analyzeMarkdown(markdown);
  md.walkTokens(tokens, (token) => {
    if (token.type === 'link' || token.type === 'image') token.href = rewrite(token.href, fromSource, { image: token.type === 'image' });
    else if (token.type === 'html' && token.text) {
      const rewritten = rewriteHtmlReferences(token.text, (url, attr) => rewrite(url, fromSource, { image: attr !== 'href' }));
      token.text = rewritten;
      if ('raw' in token) token.raw = rewritten;
    }
  });
  return sanitizeHtml(md.parser(tokens), SANITIZE_OPTIONS)
    .replaceAll('<table>', '<div class="table-scroll" tabindex="0" role="region" aria-label="Scrollable table"><table>')
    .replaceAll('</table>', '</table></div>');
}

function navigation(manifest, titles, activeSource) {
  const fromOutput = outputPathFor(manifest, activeSource);
  const link = (source, label) => {
    const current = source === activeSource ? ' aria-current="page"' : '';
    return `<li><a href="${relativeUrl(fromOutput, outputPathFor(manifest, source))}"${current}>${escapeHtml(label)}</a></li>`;
  };
  const sections = new Map();
  for (const document of manifest.documents) {
    if (!sections.has(document.section)) sections.set(document.section, []);
    sections.get(document.section).push(document.source);
  }
  const groups = [`<h2>Overview</h2>\n<ul>\n${link(manifest.landing, 'Home')}\n</ul>`];
  for (const [section, sources] of sections)
    groups.push(`<h2>${escapeHtml(section)}</h2>\n<ul>\n${sources.map((source) => link(source, titles.get(source))).join('\n')}\n</ul>`);
  return groups.join('\n');
}

function sectionCards(manifest, titles, descriptions) {
  const sections = new Map();
  for (const document of manifest.documents) {
    if (!sections.has(document.section)) sections.set(document.section, []);
    sections.get(document.section).push(document.source);
  }
  if (sections.size === 0) return '';
  const blocks = [...sections].map(([section, sources]) => {
    const cards = sources
      .map(
        (source) =>
          `<a class="card" href="${relativeUrl('index.html', outputPathFor(manifest, source))}"><strong>${escapeHtml(titles.get(source))}</strong>${descriptions.get(source) ? `<span>${escapeHtml(descriptions.get(source))}</span>` : ''}</a>`,
      )
      .join('\n');
    return `<h3>${escapeHtml(section)}</h3>\n<div class="cards">\n${cards}\n</div>`;
  });
  return `<section class="section-cards" aria-labelledby="docs-heading">\n<h2 id="docs-heading">Documentation</h2>\n${blocks.join('\n')}\n</section>`;
}

function gitIn(cwd, args) {
  return execFileSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export const BUILD_MARKER = '.docs-kit-build';

/**
 * `build` deletes --out before writing, so only delete what docs-kit made:
 * refuse the repository root or an ancestor, anything inside a .git
 * directory, a directory holding git-tracked files, and any existing
 * non-empty directory without the BUILD_MARKER a previous build wrote. This
 * holds inside and outside git, git-ignored or not.
 */
function assertSafeOut(root, out) {
  const resolvedRoot = path.resolve(root);
  const resolvedOut = path.resolve(out);
  const relative = path.relative(resolvedOut, resolvedRoot);
  if (relative === '' || !relative.startsWith('..'))
    throw new UsageError(`--out ${out} is the repository root or one of its parents; refusing to delete it`);
  if (resolvedOut.split(path.sep).includes('.git')) throw new UsageError(`--out ${out} is inside a .git directory; refusing to delete it`);
  let stat;
  try {
    stat = statSync(resolvedOut);
  } catch {
    return; // does not exist yet
  }
  if (!stat.isDirectory()) throw new UsageError(`--out ${out} exists and is not a directory; refusing to delete it`);
  try {
    const gitDir = path.resolve(resolvedOut, gitIn(resolvedOut, ['rev-parse', '--absolute-git-dir']).trim());
    const insideGitDir = path.relative(gitDir, resolvedOut);
    if (insideGitDir === '' || (!insideGitDir.startsWith('..') && !path.isAbsolute(insideGitDir)))
      throw new UsageError(`--out ${out} is inside a .git directory; refusing to delete it`);
    const tracked = trackedFiles(resolvedOut) ?? [];
    if (tracked.length > 0)
      throw new UsageError(`--out ${out} contains ${tracked.length} git-tracked file(s) (e.g. ${tracked[0]}); refusing to delete it`);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    // Not inside a git checkout: the marker rule below still applies.
  }
  const entries = readdirSync(resolvedOut);
  if (entries.length > 0 && !entries.includes(BUILD_MARKER))
    throw new UsageError(
      `--out ${out} is a non-empty directory that docs-kit did not create (no ${BUILD_MARKER} marker); refusing to delete it. ` +
        'Choose an empty or new directory.',
    );
}

/** Every internal href/src in the generated site must resolve, including #fragments. */
export function checkGeneratedSite(out) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name.endsWith('.html')) files.push(full);
    }
  };
  visit(out);
  const idCache = new Map();
  const idsOf = (file) => {
    if (!idCache.has(file)) idCache.set(file, new Set(extractHtmlAnchors(readFileSync(file, 'utf8'))));
    return idCache.get(file);
  };
  const failures = [];
  for (const file of files.sort()) {
    const html = readFileSync(file, 'utf8');
    const page = path.relative(out, file).split(path.sep).join('/');
    for (const { attr, url } of extractHtmlReferences(html)) {
      const value = url.trim();
      const label = `${attr}="${value}"`;
      if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//')) continue;
      const hashIndex = value.indexOf('#');
      const pathPart = (hashIndex === -1 ? value : value.slice(0, hashIndex)).split('?')[0];
      let fragment = hashIndex === -1 ? '' : value.slice(hashIndex + 1);
      let decodedPath;
      try {
        decodedPath = decodeURIComponent(pathPart);
        fragment = decodeURIComponent(fragment);
      } catch {
        failures.push(`${page}: ${label} - malformed percent-encoding`);
        continue;
      }
      let target = file;
      if (decodedPath !== '') {
        target = decodedPath.startsWith('/') ? path.join(out, decodedPath) : path.resolve(path.dirname(file), decodedPath);
        const inside = path.relative(out, target);
        if (inside.startsWith('..') || path.isAbsolute(inside)) {
          failures.push(`${page}: ${label} - points outside the generated site`);
          continue;
        }
        let stat;
        try {
          stat = statSync(target);
        } catch {
          failures.push(`${page}: ${label} - missing generated target`);
          continue;
        }
        if (stat.isDirectory()) target = path.join(target, 'index.html');
        try {
          statSync(target);
        } catch {
          failures.push(`${page}: ${label} - directory without index.html`);
          continue;
        }
      }
      if (fragment && target.endsWith('.html') && !idsOf(target).has(fragment)) failures.push(`${page}: ${label} - missing anchor #${fragment}`);
    }
  }
  return { files: files.length, failures };
}

/**
 * `docs-kit build`: gates 1-4, render the site, write docs-bundle.json, then
 * verify the generated links. Returns { exitCode, report }.
 */
export function runBuild({ root, out, baseUrl }) {
  const result = runChecks({ root, freshness: false });
  if (result.exitCode !== EXIT_OK) {
    const report = `${formatCheckReport(result, root)}\ndocs-kit build: refusing to build until check passes`;
    return { exitCode: result.exitCode, report };
  }
  const { manifest, read } = result;
  const siteUrl = baseUrl ? normalizeBaseUrl(baseUrl) : defaultSiteUrl(manifest.product);
  const sha = headSha(root);
  const prefix = repoPrefix(root);
  assertSafeOut(root, out);

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const published = new Set(publishedSources(manifest));
  const assets = new Set();
  const rewrite = createHrefRewriter({ root, manifest, sha, prefix, published, assets });
  const titles = new Map();
  const descriptions = new Map();
  for (const source of published) {
    const { analysis } = read(source);
    titles.set(source, documentTitle(analysis, source));
    descriptions.set(source, firstParagraph(analysis));
  }

  for (const source of published) {
    const { markdown } = read(source);
    const output = outputPathFor(manifest, source);
    const depth = output.split('/').length - 1;
    const toRoot = '../'.repeat(depth);
    const isLanding = source === manifest.landing;
    const body = renderMarkdown(markdown, source, rewrite);
    const sourceUrl = `https://github.com/${manifest.repo}/blob/${sha}/${encodePath(`${prefix}${source}`)}`;
    const content = [
      `<article class="doc">\n${body}\n</article>`,
      isLanding ? sectionCards(manifest, titles, descriptions) : '',
      `<p class="doc-meta">Source: <a href="${escapeHtml(sourceUrl)}">${escapeHtml(source)}</a></p>`,
    ].join('\n');
    const html = sitePage({
      manifest,
      title: isLanding ? `${manifest.title} documentation` : `${titles.get(source)} · ${manifest.title}`,
      description: isLanding ? manifest.tagline || descriptions.get(source) : descriptions.get(source),
      navHtml: navigation(manifest, titles, source),
      content,
      toRoot,
      sha,
    });
    const target = toFsPath(out, output);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, html);
  }

  for (const asset of [...assets].sort()) {
    const target = toFsPath(out, asset);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(toFsPath(root, asset), target);
  }
  writeFileSync(path.join(out, 'docs-kit.css'), SITE_CSS);
  writeFileSync(path.join(out, '.nojekyll'), '');
  writeFileSync(path.join(out, BUILD_MARKER), 'Generated by docs-kit build. This directory is replaced on every build.\n');
  const bundle = assembleBundle({ manifest, read, sha, siteUrl });
  writeFileSync(path.join(out, 'docs-bundle.json'), `${JSON.stringify(bundle, null, 2)}\n`);

  const generated = checkGeneratedSite(out);
  if (generated.failures.length > 0)
    throw new GateFailure(
      `docs-kit build: generated site has ${generated.failures.length} broken internal link${generated.failures.length === 1 ? '' : 's'}:\n` +
        generated.failures.map((failure) => `  - ${failure}`).join('\n'),
    );
  return {
    exitCode: EXIT_OK,
    report:
      `docs-kit build: ${published.size} pages, ${assets.size} images, ${bundle.topics.length} topics -> ${out}\n` +
      `  verified ${generated.files} generated pages; bundle ${bundle.sha.slice(0, 7)} digest ${bundle.digest.slice(0, 12)} for ${siteUrl}`,
  };
}
