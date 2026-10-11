import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Marked } from 'marked';
import { assembleBundle, defaultSiteUrl, normalizeBaseUrl } from './bundle.mjs';
import { formatCheckReport, publishedSources, runChecks } from './check.mjs';
import { EXIT_OK, GateFailure, UsageError } from './errors.mjs';
import { headSha, repoPrefix } from './git.mjs';
import { outputPathFor } from './manifest.mjs';
import { analyzeMarkdown, decodeEntities, documentTitle, firstParagraph, resolveLink } from './markdown.mjs';
import { encodePath, relativeUrl, statInRepo, toFsPath } from './paths.mjs';
import { SITE_CSS, escapeHtml, sitePage } from './site-template.mjs';

const IMAGE_FILE = /\.(?:png|jpe?g|gif|svg|webp|avif|ico|bmp)$/i;
const SAFE_EXTERNAL = /^(?:https?:|mailto:|\/\/)/i;
const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif);/i;
const HTML_URL_ATTRIBUTE = /(\s(?:href|src)\s*=\s*)(["'])(.*?)\2/gi;

/**
 * Map a link written in `fromSource` to its URL on the generated site:
 * published docs become their pages, local images are copied, other repo
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
    if (stat.kind === 'file' && IMAGE_FILE.test(target.path)) {
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
      const rewritten = token.text.replace(HTML_URL_ATTRIBUTE, (_match, lead, quote, value) => {
        const isSrc = /src/i.test(lead);
        const next = rewrite(decodeEntities(value), fromSource, { image: isSrc });
        return `${lead}${quote}${escapeHtml(next)}${quote}`;
      });
      token.text = rewritten;
      if ('raw' in token) token.raw = rewritten;
    }
  });
  return md
    .parser(tokens)
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

/** Refuse output directories whose deletion would destroy sources. */
function assertSafeOut(root, out, manifest) {
  const resolvedRoot = path.resolve(root);
  const resolvedOut = path.resolve(out);
  const relative = path.relative(resolvedOut, resolvedRoot);
  if (relative === '' || !relative.startsWith('..'))
    throw new UsageError(`--out ${out} is the repository root or one of its parents; refusing to delete it`);
  for (const source of [...publishedSources(manifest), 'docs-kit.json']) {
    const inside = path.relative(resolvedOut, toFsPath(resolvedRoot, source));
    if (!inside.startsWith('..') && !path.isAbsolute(inside))
      throw new UsageError(`--out ${out} contains the source ${source}; refusing to delete it`);
  }
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
    if (!idCache.has(file)) {
      const html = readFileSync(file, 'utf8');
      idCache.set(file, new Set([...html.matchAll(/\sid="([^"]*)"/g)].map((match) => decodeEntities(match[1]))));
    }
    return idCache.get(file);
  };
  const failures = [];
  for (const file of files.sort()) {
    const html = readFileSync(file, 'utf8');
    const page = path.relative(out, file).split(path.sep).join('/');
    for (const match of html.matchAll(/\s(href|src)="([^"]*)"/g)) {
      const value = decodeEntities(match[2]).trim();
      if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//')) continue;
      const hashIndex = value.indexOf('#');
      const pathPart = (hashIndex === -1 ? value : value.slice(0, hashIndex)).split('?')[0];
      let fragment = hashIndex === -1 ? '' : value.slice(hashIndex + 1);
      let decodedPath;
      try {
        decodedPath = decodeURIComponent(pathPart);
        fragment = decodeURIComponent(fragment);
      } catch {
        failures.push(`${page}: ${match[1]}="${value}" - malformed percent-encoding`);
        continue;
      }
      let target = file;
      if (decodedPath !== '') {
        target = decodedPath.startsWith('/') ? path.join(out, decodedPath) : path.resolve(path.dirname(file), decodedPath);
        const inside = path.relative(out, target);
        if (inside.startsWith('..') || path.isAbsolute(inside)) {
          failures.push(`${page}: ${match[1]}="${value}" - points outside the generated site`);
          continue;
        }
        let stat;
        try {
          stat = statSync(target);
        } catch {
          failures.push(`${page}: ${match[1]}="${value}" - missing generated target`);
          continue;
        }
        if (stat.isDirectory()) target = path.join(target, 'index.html');
        try {
          statSync(target);
        } catch {
          failures.push(`${page}: ${match[1]}="${value}" - directory without index.html`);
          continue;
        }
      }
      if (fragment && target.endsWith('.html') && !idsOf(target).has(fragment))
        failures.push(`${page}: ${match[1]}="${value}" - missing anchor #${fragment}`);
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
  assertSafeOut(root, out, manifest);

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
