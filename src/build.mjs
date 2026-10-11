import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { createAssetPolicy } from './assets.mjs';
import { assembleBundle, defaultSiteUrl, normalizeBaseUrl } from './bundle.mjs';
import { foldPath, formatCheckReport, publishedSources, runChecks } from './check.mjs';
import { EXIT_OK, GateFailure, UsageError } from './errors.mjs';
import { gitEnv, headSha, repoPrefix, trackedFiles } from './git.mjs';
import { execFileSync } from 'node:child_process';
import { outputPathFor } from './manifest.mjs';
import { analyzeMarkdown, decodeEntities, documentTitle, extractHtmlAnchors, extractHtmlReferences, firstParagraph, resolveLink, rewriteHtmlReferences } from './markdown.mjs';
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
function createHrefRewriter({ root, manifest, sha, prefix, published }) {
  const blobBase = `https://github.com/${manifest.repo}`;
  const assetPolicy = createAssetPolicy(root);
  return (href, fromSource, { image = false, pending } = {}) => {
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
    // Embedded resources (Markdown images, src, srcset, poster) and links to
    // images are copied when the shared asset policy allows it.
    const policy = assetPolicy(target.path, stat.kind, { embed: image || IMAGE_FILE.test(target.path) });
    if (policy.action === 'unpublishable') throw new GateFailure(`${fromSource}: unpublishable reference: ${target.path} ${policy.reason}`);
    if (policy.action === 'copy') {
      // Recorded as pending; copied only if the URL survives sanitization.
      const url = relativeUrl(fromOutput, target.path);
      pending?.set(url, target.path);
      return url;
    }
    const kind = stat.kind === 'dir' ? 'tree' : 'blob';
    return `${blobBase}/${kind}/${sha}/${encodePath(`${prefix}${target.path}`).replace(/\/$/, '')}${hash}`;
  };
}

/** True for a fenced block whose info string's first word is `mermaid`, as on GitHub. */
function isMermaidFence(token) {
  return /^mermaid(?:\s|$)/.test(token.lang ?? '');
}

/**
 * Render one page. Assets are collected from the sanitized HTML, so a file
 * referenced only by a tag the sanitizer strips (iframe, embed, script, ...)
 * is never copied. Returns { html, mermaid }, where `mermaid` says whether a
 * mermaid fence was rendered, so the page template loads Mermaid only there.
 */
function renderMarkdown(markdown, fromSource, rewrite, assets) {
  const pending = new Map();
  let mermaid = false;
  const md = new Marked({ gfm: true });
  md.use({
    renderer: {
      // Mermaid reads the diagram source from the element's text, so it is
      // escaped like any code block and passes the sanitizer as plain text.
      code(token) {
        if (!isMermaidFence(token)) return false;
        mermaid = true;
        return `<pre class="mermaid">${escapeHtml(token.text)}</pre>\n`;
      },
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
    if (token.type === 'link' || token.type === 'image') token.href = rewrite(token.href, fromSource, { image: token.type === 'image', pending });
    else if (token.type === 'html' && token.text) {
      const rewritten = rewriteHtmlReferences(token.text, (url, attr) => rewrite(url, fromSource, { image: attr !== 'href', pending }));
      token.text = rewritten;
      if ('raw' in token) token.raw = rewritten;
    }
  });
  const html = sanitizeHtml(md.parser(tokens), SANITIZE_OPTIONS);
  for (const { url } of extractHtmlReferences(html)) if (pending.has(url)) assets.add(pending.get(url));
  return {
    html: html
      .replaceAll('<table>', '<div class="table-scroll" tabindex="0" role="region" aria-label="Scrollable table"><table>')
      .replaceAll('</table>', '</table></div>'),
    mermaid,
  };
}

/** Section -> page sources, in manifest order. Bundle-only documents have no page, so no entry. */
function pageSections(manifest) {
  const sections = new Map();
  for (const document of manifest.documents) {
    if (!document.publish) continue;
    if (!sections.has(document.section)) sections.set(document.section, []);
    sections.get(document.section).push(document.source);
  }
  return sections;
}

function navigation(manifest, titles, activeSource) {
  const fromOutput = outputPathFor(manifest, activeSource);
  const link = (source, label) => {
    const current = source === activeSource ? ' aria-current="page"' : '';
    return `<li><a href="${relativeUrl(fromOutput, outputPathFor(manifest, source))}"${current}>${escapeHtml(label)}</a></li>`;
  };
  const sections = pageSections(manifest);
  const groups = [`<h2>Overview</h2>\n<ul>\n${link(manifest.landing, 'Home')}\n</ul>`];
  for (const [section, sources] of sections)
    groups.push(`<h2>${escapeHtml(section)}</h2>\n<ul>\n${sources.map((source) => link(source, titles.get(source))).join('\n')}\n</ul>`);
  return groups.join('\n');
}

function sectionCards(manifest, titles, descriptions) {
  const sections = pageSections(manifest);
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
 * non-empty directory unless every file in it is listed in the BUILD_MARKER
 * manifest a previous build wrote (a hand-added file blocks the rebuild).
 * This holds inside and outside git, git-ignored or not. A forged marker is
 * trusted.
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
  const present = filesUnder(resolvedOut);
  if (present.length === 0) return;
  let listed;
  try {
    const marker = JSON.parse(readFileSync(path.join(resolvedOut, BUILD_MARKER), 'utf8'));
    if (marker?.generator !== '@kontourai/docs-kit' || !Array.isArray(marker.files)) throw new Error('not a docs-kit marker');
    listed = new Set(marker.files);
  } catch {
    throw new UsageError(
      `--out ${out} is a non-empty directory without a valid ${BUILD_MARKER} manifest, so docs-kit did not create it; refusing to delete it. ` +
        'Choose an empty or new directory.',
    );
  }
  const unexpected = present.find((file) => file !== BUILD_MARKER && !listed.has(file));
  if (unexpected)
    throw new UsageError(`--out ${out} contains ${unexpected}, which the previous docs-kit build did not write; refusing to delete it`);
}

/** Every file under `dir`, dotfiles included, as sorted POSIX paths relative to it. */
function filesUnder(dir) {
  const found = [];
  const visit = (fsDir, relative) => {
    for (const entry of readdirSync(fsDir, { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path.join(fsDir, entry.name), child);
      else found.push(child);
    }
  };
  visit(dir, '');
  return found.sort();
}

/**
 * A string as a JavaScript literal safe inside an HTML <script> element.
 * JSON.stringify quotes and escapes backslashes, quotes, and control characters;
 * escaping every "<" as \u003c rules out "</script" and "<!--", the only ways
 * text can leave or confuse a script element. U+2028 and U+2029 are escaped
 * too: legal in string literals since ES2019, but line terminators to older
 * parsers. The literal means the same string.
 */
export function scriptString(value) {
  return JSON.stringify(String(value)).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * A redirect stub for a page that moved. GitHub Pages cannot send HTTP
 * redirects, so the stub redirects immediately, names the canonical URL, asks
 * not to be indexed, and shows a plain link.
 *
 * A meta refresh drops the incoming #fragment, so an inline script runs first
 * and carries it over with location.replace (which also keeps the stub out of
 * history). A target that has its own #anchor keeps it: the manifest named
 * that anchor on purpose, and an old page's fragment may not exist on the new
 * page. The meta refresh stays as the no-JS fallback. The script is template
 * output, not document content, so it does not pass through the sanitizer;
 * the target is embedded with scriptString.
 */
export function redirectStub({ href, canonical }) {
  const url = escapeHtml(href);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Redirecting…</title>
<script>(function(){var t=${scriptString(href)};location.replace(t.indexOf("#")<0?t+location.hash:t);})();</script>
<meta http-equiv="refresh" content="0; url=${url}">
<link rel="canonical" href="${escapeHtml(canonical)}">
<meta name="robots" content="noindex">
<meta name="generator" content="@kontourai/docs-kit">
</head>
<body>
<p>This page has moved to <a href="${url}">${url}</a>.</p>
</body>
</html>
`;
}

/** Write one stub per redirects key; returns the count. Refuses to overwrite a copied asset. */
function writeRedirects({ manifest, out, siteUrl, assets }) {
  const lowerAssets = new Map([...assets].map((asset) => [foldPath(asset), asset]));
  for (const { from, source, anchor, url } of manifest.redirects) {
    const clash = lowerAssets.get(foldPath(from)) ?? [...lowerAssets].find(([folded]) => folded.startsWith(`${foldPath(from)}/`))?.[1];
    if (clash) throw new GateFailure(`docs-kit build: redirects["${from}"] would overwrite the copied asset ${clash}`);
    let href = url;
    let canonical = url;
    if (source !== undefined) {
      const output = outputPathFor(manifest, source);
      href = `${relativeUrl(from, output)}${anchor ? `#${encodeURIComponent(anchor)}` : ''}`;
      canonical = new URL(encodePath(output), siteUrl).href;
    }
    const target = toFsPath(out, from);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, redirectStub({ href, canonical }));
  }
  return manifest.redirects.length;
}

const REFRESH_URL = /<meta http-equiv="refresh" content="0; url=([^"]*)">/g;
const STUB_SCRIPT = /<script>\(function\(\)\{var t=("(?:[^"\\\n]|\\.)*");location\.replace\(/g;

/**
 * Every internal href/src in the generated site must resolve, including
 * #fragments, and so must the URL of a redirect stub's meta refresh. A stub's
 * script target must be readable and equal its meta refresh URL, so the JS and
 * no-JS paths cannot diverge.
 */
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
    const references = extractHtmlReferences(html);
    const refreshes = [...html.matchAll(REFRESH_URL)].map(([, url]) => decodeEntities(url));
    for (const url of refreshes) references.push({ attr: 'refresh', url });
    const scripts = [];
    for (const [, literal] of html.matchAll(STUB_SCRIPT)) {
      try {
        scripts.push(JSON.parse(literal));
      } catch {
        failures.push(`${page}: redirect script target ${literal} - not a readable string literal`);
      }
    }
    for (const url of scripts) references.push({ attr: 'script', url });
    if (refreshes.length > 0) {
      const scriptCount = (html.match(/<script\b/gi) ?? []).length;
      if (scriptCount !== 1 || scripts.length !== 1) failures.push(`${page}: redirect stub needs exactly one redirect script, found ${scriptCount}`);
      else if (scripts[0] !== refreshes[0]) failures.push(`${page}: script="${scripts[0]}" - does not match refresh="${refreshes[0]}"`);
    }
    for (const { attr, url } of references) {
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
  const rewrite = createHrefRewriter({ root, manifest, sha, prefix, published });
  const titles = new Map();
  const descriptions = new Map();
  const overrides = new Map(manifest.documents.map((document) => [document.source, document.title]));
  for (const source of published) {
    const { analysis } = read(source);
    titles.set(source, documentTitle(analysis, source, overrides.get(source)));
    descriptions.set(source, firstParagraph(analysis));
  }

  for (const source of published) {
    const { markdown } = read(source);
    const output = outputPathFor(manifest, source);
    const depth = output.split('/').length - 1;
    const toRoot = '../'.repeat(depth);
    const isLanding = source === manifest.landing;
    const { html: body, mermaid } = renderMarkdown(markdown, source, rewrite, assets);
    const sourceUrl = `https://github.com/${manifest.repo}/blob/${sha}/${encodePath(`${prefix}${source}`)}`;
    const content = [
      `<article class="doc">\n${body}\n</article>`,
      isLanding ? sectionCards(manifest, titles, descriptions) : '',
      `<p class="doc-meta">Source: <a href="${escapeHtml(sourceUrl)}">${escapeHtml(source)}</a></p>`,
    ].join('\n');
    const html = sitePage({
      manifest,
      title: isLanding
        ? manifest.tagline
          ? `${manifest.title} — ${manifest.tagline}`
          : `${manifest.title} documentation`
        : `${titles.get(source)} · ${manifest.title}`,
      description: isLanding ? manifest.tagline || descriptions.get(source) : descriptions.get(source),
      navHtml: navigation(manifest, titles, source),
      content,
      toRoot,
      sha,
      mermaid,
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
  const redirects = writeRedirects({ manifest, out, siteUrl, assets });
  writeFileSync(path.join(out, 'docs-kit.css'), SITE_CSS);
  writeFileSync(path.join(out, '.nojekyll'), '');

  const bundle = assembleBundle({ manifest, read, sha, siteUrl, root, prefix });
  writeFileSync(path.join(out, 'docs-bundle.json'), `${JSON.stringify(bundle, null, 2)}\n`);

  // The marker lists every file this build wrote; the next build replaces
  // the directory only if nothing else has appeared in it.
  writeFileSync(
    path.join(out, BUILD_MARKER),
    `${JSON.stringify({ generator: '@kontourai/docs-kit', note: 'Written by docs-kit build; the directory is replaced on the next build only if it holds exactly these files.', files: filesUnder(out) }, null, 2)}\n`,
  );
  const generated = checkGeneratedSite(out);
  if (generated.failures.length > 0)
    throw new GateFailure(
      `docs-kit build: generated site has ${generated.failures.length} broken internal link${generated.failures.length === 1 ? '' : 's'}:\n` +
        generated.failures.map((failure) => `  - ${failure}`).join('\n'),
    );
  return {
    exitCode: EXIT_OK,
    report:
      `docs-kit build: ${published.size} pages, ${assets.size} images, ${bundle.topics.length} topics${redirects ? `, ${redirects} redirects` : ''} -> ${out}\n` +
      `  verified ${generated.files} generated pages; bundle ${bundle.sha.slice(0, 7)} digest ${bundle.digest.slice(0, 12)} for ${siteUrl}`,
  };
}
