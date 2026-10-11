import path from 'node:path';
import { Lexer, marked } from 'marked';

/**
 * GitHub heading slug: lowercase, drop everything except letters, marks,
 * numbers, connector punctuation (`_`), hyphens and spaces, then turn each
 * space into a hyphen. This mirrors github-slugger, which GitHub uses for
 * rendered Markdown anchors.
 */
export function githubSlug(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

/** Repeated headings get `-1`, `-2`, ... exactly as github-slugger counts them. */
export function createSlugger() {
  const occurrences = new Map();
  return (text) => {
    const original = githubSlug(text);
    let result = original;
    while (occurrences.has(result)) {
      const next = occurrences.get(original) + 1;
      occurrences.set(original, next);
      result = `${original}-${next}`;
    }
    occurrences.set(result, 0);
    return result;
  };
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

const HTML_ID = /\s(?:id|name)\s*=\s*["']([^"']+)["']/gi;

function lineAt(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

/**
 * Lex a Markdown document once and report what the gates and the builder
 * need: headings with GitHub slugs, every anchor id, every Markdown link and
 * image, and the title (first top-level H1).
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
      for (const match of token.text.matchAll(HTML_ID)) anchors.add(decodeEntities(match[1]));
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
