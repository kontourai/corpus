import path from 'node:path';
import GithubSlugger, { slug } from 'github-slugger';
import { Lexer, marked } from 'marked';

/** GitHub heading slug for one heading, via github-slugger (what GitHub uses). */
export function githubSlug(text) {
  return slug(text);
}

/** Per-document slugger: repeated headings get `-1`, `-2`, ... */
export function createSlugger() {
  const slugger = new GithubSlugger();
  return (text) => slugger.slug(text);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, body) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** The text content a browser would show for inline tokens (raw HTML tags dropped). */
export function plainText(tokens = []) {
  let text = '';
  for (const token of tokens) {
    if (token.type === 'html') continue;
    if (token.type === 'image') text += token.text ?? '';
    else if (token.tokens?.length) text += plainText(token.tokens);
    else if (token.type === 'br') text += ' ';
    else text += decodeEntities(token.text ?? '');
  }
  return text;
}

const HTML_TAG = /<[A-Za-z][^\s/>]*((?:"[^"]*"|'[^']*'|[^'">])*)>/dg;
const HTML_ATTRIBUTE = /(\s+)([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/dg;
const URL_ATTRIBUTES = new Set(['href', 'src', 'srcset']);
const ANCHOR_ATTRIBUTES = new Set(['id', 'name']);

/**
 * Every attribute of every start tag in an HTML fragment, in any quoting
 * (double, single, unquoted). `start`/`end` cover the attribute including its
 * leading whitespace, so callers can rewrite it in place. Values are
 * entity-decoded. This one scanner backs raw-HTML link checking, rewriting,
 * anchor collection, and the generated-site check.
 */
export function scanHtmlAttributes(html) {
  const attributes = [];
  for (const tag of html.matchAll(HTML_TAG)) {
    const [areaStart] = tag.indices[1];
    for (const attribute of tag[1].matchAll(HTML_ATTRIBUTE)) {
      const raw = attribute[3] ?? attribute[4] ?? attribute[5];
      attributes.push({
        name: attribute[2].toLowerCase(),
        value: raw === undefined ? '' : decodeEntities(raw),
        start: areaStart + attribute.index,
        end: areaStart + attribute.index + attribute[0].length,
      });
    }
  }
  return attributes;
}

/** URLs in a srcset value: each comma-separated candidate's first token. */
function srcsetUrls(value) {
  return value
    .split(',')
    .map((candidate) => candidate.trim().split(/\s+/)[0])
    .filter(Boolean);
}

/** Raw-HTML references: { attr, url } for href, src, and each srcset candidate. */
export function extractHtmlReferences(html) {
  const references = [];
  for (const { name, value } of scanHtmlAttributes(html)) {
    if (!URL_ATTRIBUTES.has(name)) continue;
    if (name === 'srcset') for (const url of srcsetUrls(value)) references.push({ attr: name, url });
    else references.push({ attr: name, url: value });
  }
  return references;
}

function escapeAttributeValue(value) {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Rewrite every href/src/srcset URL with `rewrite(url, attr)`; output is double-quoted. */
export function rewriteHtmlReferences(html, rewrite) {
  const targets = scanHtmlAttributes(html).filter((attribute) => URL_ATTRIBUTES.has(attribute.name));
  let output = html;
  for (const attribute of targets.reverse()) {
    const leading = html.slice(attribute.start).match(/^\s+/)[0];
    const value =
      attribute.name === 'srcset'
        ? attribute.value
            .split(',')
            .map((candidate) => {
              const [url, ...descriptor] = candidate.trim().split(/\s+/);
              return url ? [rewrite(url, 'srcset'), ...descriptor].join(' ') : '';
            })
            .filter(Boolean)
            .join(', ')
        : rewrite(attribute.value, attribute.name);
    output = `${output.slice(0, attribute.start)}${leading}${attribute.name}="${escapeAttributeValue(value)}"${output.slice(attribute.end)}`;
  }
  return output;
}

/** Fragment targets declared in HTML: `id` and `name` attributes in any quoting. */
export function extractHtmlAnchors(html) {
  return scanHtmlAttributes(html)
    .filter((attribute) => ANCHOR_ATTRIBUTES.has(attribute.name) && attribute.value !== '')
    .map((attribute) => attribute.value);
}

function lineAt(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

/**
 * Lex a Markdown document once and report what the gates and the builder
 * need: headings with GitHub slugs, every anchor (heading slugs plus raw-HTML
 * id/name), every Markdown link and image plus raw-HTML href/src/srcset, and
 * the title (first top-level H1).
 */
export function analyzeMarkdown(source) {
  const tokens = Lexer.lex(source, { gfm: true });
  const slug = createSlugger();
  const headings = [];
  const anchors = new Set();
  const links = [];
  const topLevel = new Set(tokens);
  let cursor = 0;

  marked.walkTokens(tokens, (token) => {
    if (token.type === 'heading') {
      const text = plainText(token.tokens).trim();
      const id = slug(text);
      token.slugId = id;
      anchors.add(id);
      headings.push({ depth: token.depth, text, slug: id, topLevel: topLevel.has(token), token });
    } else if (token.type === 'html' && token.text) {
      for (const anchor of extractHtmlAnchors(token.text)) anchors.add(anchor);
      const references = extractHtmlReferences(token.text);
      if (references.length > 0) {
        let index = source.indexOf(token.raw, cursor);
        if (index === -1) index = source.indexOf(token.raw);
        if (index !== -1) cursor = index + token.raw.length;
        for (const { attr, url } of references)
          links.push({ kind: 'html', attr, href: url, text: attr, line: index === -1 ? null : lineAt(source, index) });
      }
    } else if ((token.type === 'link' || token.type === 'image') && typeof token.href === 'string') {
      let index = source.indexOf(token.raw, cursor);
      if (index === -1) index = source.indexOf(token.raw);
      if (index !== -1) cursor = index + token.raw.length;
      links.push({
        kind: token.type,
        href: token.href,
        text: token.type === 'image' ? token.text : plainText(token.tokens) || token.text,
        line: index === -1 ? null : lineAt(source, index),
      });
    }
  });

  const h1 = headings.find((heading) => heading.depth === 1 && heading.topLevel);
  return { tokens, headings, anchors, links, title: h1?.text || null };
}

/** Document title: first H1, else the file name without its extension. */
export function documentTitle(analysis, source) {
  return analysis.title || path.posix.basename(source).replace(/\.md$/i, '');
}

/**
 * Markdown of one heading's section: the heading itself through the token
 * before the next top-level heading of the same or a higher level.
 */
export function extractSection(analysis, slug) {
  const heading = analysis.headings.find((entry) => entry.slug === slug && entry.topLevel);
  if (!heading) return null;
  const start = analysis.tokens.indexOf(heading.token);
  let raw = '';
  for (let i = start; i < analysis.tokens.length; i++) {
    const token = analysis.tokens[i];
    if (i > start && token.type === 'heading' && token.depth <= heading.depth) break;
    raw += token.raw;
  }
  return `${raw.trim()}\n`;
}

/** First prose paragraph as plain text, for page descriptions and cards. */
export function firstParagraph(analysis, max = 200) {
  const paragraph = analysis.tokens.find((token) => token.type === 'paragraph');
  if (!paragraph) return '';
  const text = plainText(paragraph.tokens).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * Classify a link target written in a document at `fromSource`.
 * - external: has a URL scheme or is protocol-relative; never fetched
 * - fragment: `#anchor` within the same document
 * - local: a repo-relative `path` (POSIX, normalized) plus optional fragment;
 *   a leading `/` is repository-root-relative, as GitHub renders it
 * - invalid: escapes the repository or cannot be decoded
 */
export function resolveLink(href, fromSource) {
  const value = href.trim();
  if (value === '') return { kind: 'invalid', reason: 'empty link target' };
  if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//')) return { kind: 'external' };
  const hashIndex = value.indexOf('#');
  const pathPart = hashIndex === -1 ? value : value.slice(0, hashIndex);
  const rawFragment = hashIndex === -1 ? '' : value.slice(hashIndex + 1);
  let fragment;
  let decodedPath;
  try {
    fragment = decodeURIComponent(rawFragment);
    decodedPath = decodeURIComponent(pathPart.split('?')[0]);
  } catch {
    return { kind: 'invalid', reason: 'malformed percent-encoding' };
  }
  if (decodedPath === '') return { kind: 'fragment', fragment, rawFragment };
  if (decodedPath.includes('\0') || decodedPath.includes('\\'))
    return { kind: 'invalid', reason: 'unsupported characters in path' };
  const joined = decodedPath.startsWith('/')
    ? path.posix.normalize(decodedPath.slice(1) || '.')
    : path.posix.normalize(path.posix.join(path.posix.dirname(fromSource), decodedPath));
  const normalized = joined.replace(/\/$/, '');
  if (normalized === '..' || normalized.startsWith('../'))
    return { kind: 'invalid', reason: 'escapes the repository root' };
  return {
    kind: 'local',
    path: normalized === '.' ? '' : normalized,
    fragment,
    rawFragment,
  };
}
