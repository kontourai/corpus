import { Lexer } from 'marked';
import { analyzeMarkdown, blockLines, decodeEntities, plainText } from './markdown.mjs';
import { encodePath } from './paths.mjs';

/**
 * Find a quoted passage, typically text selected on a rendered docs page, in
 * a bundle's Markdown and report where it lives in the source file.
 *
 * Both sides are reduced to a comparable form: letters and digits, lowercased
 * and NFKD-decomposed with combining marks dropped, and every run of
 * whitespace or punctuation collapsed to one space. Markdown that renders as
 * nothing is dropped from the document side first: link and image
 * destinations, HTML tags and comments, fence lines, list and task markers,
 * and reference definitions. Entities are decoded. Emphasis and code marks
 * (`*`, `_`, `~`, backticks) and backslashes are dropped on both sides
 * without leaving a gap, so `**foo**bar` matches the rendered `foobar`. Code
 * (fenced, indented, and code spans) renders literally, so nothing inside it
 * is dropped except those marks. Each kept character remembers its offset in
 * the original Markdown, so a match maps back to exact lines.
 */

const DROPPED = /[*_~`\\]/;
const WORD = /[\p{L}\p{N}]/u;
const MARK = /\p{M}/u;
const MIN_QUOTE = 3;
const ANCHOR_WORDS = 4;
/** Alternatives returned for an ambiguous quote; `matchCount` reports the total. */
export const MAX_ALTERNATIVES = 10;

/** Line-start offsets, counting CRLF, a lone CR, and LF as one break each, as the Markdown lexer does. */
function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 10 || (code === 13 && text.charCodeAt(i + 1) !== 10)) starts.push(i + 1);
  }
  return {
    starts,
    /** 1-based line of a character offset. */
    lineOf(offset) {
      let low = 0;
      let high = starts.length - 1;
      while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (starts[mid] <= offset) low = mid;
        else high = mid - 1;
      }
      return low + 1;
    },
  };
}

/** Offsets that are code content (rendered literally): fenced and indented code lines, and code spans. */
function codeRanges(markdown, index) {
  const literal = new Uint8Array(markdown.length);
  const lineSpan = (first, last) => {
    const from = index.starts[first - 1];
    const to = last < index.starts.length ? index.starts[last] : markdown.length;
    literal.fill(1, from, to);
  };
  // Fences at any depth (in lists and blockquotes too): the lines between the fences, 1-based.
  const lines = markdown.split(/\r\n|\r|\n/);
  let open = null;
  lines.forEach((line, i) => {
    const fence = /^[ \t>]*(`{3,}|~{3,})/.exec(line);
    if (open === null) {
      // A backtick fence's info string cannot contain a backtick.
      if (fence && !(fence[1][0] === '`' && line.slice(fence[0].length).includes('`'))) open = { first: i + 2, char: fence[1][0], length: fence[1].length };
    } else if (fence && fence[1][0] === open.char && fence[1].length >= open.length && /^[ \t>]*[`~]+[ \t]*$/.test(line)) {
      if (i >= open.first) lineSpan(open.first, i);
      open = null;
    }
  });
  if (open !== null && open.first <= lines.length) lineSpan(open.first, lines.length);
  // Indented code blocks are top-level code tokens without a fence.
  for (const { token, start, end } of blockLines(Lexer.lex(markdown, { gfm: true })))
    if (token.type === 'code' && !/^[ \t]*(?:`{3,}|~{3,})/.test(token.raw)) lineSpan(start, end);
  // Code spans: a backtick run, content, the same run, within one paragraph.
  // Scanning paragraph by paragraph keeps an unmatched backtick from making
  // the lazy match scan to the end of the document from every start.
  for (const paragraph of markdown.matchAll(/[^\n]+(?:\n(?![ \t]*\r?$)[^\n]*)*/gm))
    for (const match of paragraph[0].matchAll(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g)) {
      const at = paragraph.index + match.index;
      if (literal[at]) continue;
      literal.fill(1, at + match[1].length, at + match[1].length + match[2].length);
    }
  return literal;
}

const ENTITY = /&(?:#x[\da-f]+|#\d+|[a-z][a-z\d]*);/gi;

/** Character ranges of Markdown that render as nothing, and entities to decode, outside code. */
function markdownMask(markdown, index) {
  const literal = codeRanges(markdown, index);
  const hidden = new Uint8Array(markdown.length);
  const patterns = [
    /\]\((?:[^()\s]|\([^()]*\))*(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g, // ](destination "title")
    /\]\[[^\]\n]*\]/g, // ][reference]
    /^ {0,3}\[[^\]\n]+\]:.*$/gm, // [reference]: definition
    /<!--[\s\S]*?-->/g,
    /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/g, // tags, but not autolinks such as <https://x>
    /^[ \t]*(?:`{3,}|~{3,}).*$/gm, // fence lines and their info strings
    /^[ \t>]*(?:[-+*]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, // list and task markers
  ];
  for (const pattern of patterns)
    for (const match of markdown.matchAll(pattern)) {
      if (literal[match.index]) continue;
      // A `](...)` or `][...]` match keeps its `]`; only the destination is hidden.
      const from = match[0].startsWith('](') || match[0].startsWith('][') ? match.index + 1 : match.index;
      for (let i = from; i < match.index + match[0].length; i++) if (!literal[i]) hidden[i] = 1;
    }
  const entities = new Map();
  for (const match of markdown.matchAll(ENTITY)) {
    if (literal[match.index] || hidden[match.index]) continue;
    const decoded = decodeEntities(match[0]);
    if (decoded === match[0]) hidden.fill(1, match.index, match.index + match[0].length);
    else entities.set(match.index, { end: match.index + match[0].length, text: decoded });
  }
  return { hidden, entities };
}

/** The comparable form of `text`, plus each output character's offset in `text`. */
export function normalizeForMatch(text, { markdown = false, index = null } = {}) {
  const { hidden, entities } = markdown ? markdownMask(text, index ?? lineIndex(text)) : { hidden: null, entities: new Map() };
  let normalized = '';
  const offsets = [];
  // Tracked here: endsWith on a string built with += flattens it on every call.
  let open = false;
  const separator = (offset) => {
    if (open) {
      normalized += ' ';
      offsets.push(offset);
      open = false;
    }
  };
  const emit = (value, offset) => {
    const code = value.charCodeAt(0);
    // ASCII fast path; everything else goes through NFKD.
    if (value.length === 1 && code < 128) {
      if ((code >= 48 && code <= 57) || (code >= 97 && code <= 122)) {
        normalized += value;
        offsets.push(offset);
        open = true;
      } else if (code >= 65 && code <= 90) {
        normalized += String.fromCharCode(code + 32);
        offsets.push(offset);
        open = true;
      } else if (!DROPPED.test(value)) separator(offset);
      return;
    }
    for (const part of value.normalize('NFKD').toLowerCase()) {
      if (MARK.test(part) || DROPPED.test(part)) continue;
      if (WORD.test(part)) {
        normalized += part;
        for (let k = 0; k < part.length; k++) offsets.push(offset);
        open = true;
      } else separator(offset);
    }
  };
  for (let i = 0; i < text.length; ) {
    const entity = entities.get(i);
    if (entity) {
      emit(entity.text, i);
      i = entity.end;
      continue;
    }
    const char = String.fromCodePoint(text.codePointAt(i));
    if (!hidden?.[i]) emit(char, i);
    i += char.length;
  }
  return { normalized, offsets };
}

/** Every start index of `needle` in `haystack`. */
function occurrences(haystack, needle) {
  const found = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) found.push(at);
  return found;
}

/**
 * Top-level blocks with body lines, and the top-level headings with the id
 * the page gives them (analyzeMarkdown is what the site build slugs with).
 */
function documentOutline(markdown) {
  const blocks = blockLines(analyzeMarkdown(markdown).tokens);
  const headings = blocks
    .filter(({ token }) => token.type === 'heading')
    .map(({ token, start }) => ({ line: start, text: plainText(token.tokens).trim(), anchor: token.slugId }));
  return { blocks, headings };
}

const collapse = (text) => text.replace(/\s+/g, ' ');

/**
 * Locate `quote` in the documents of `bundle` (optionally only `source`).
 * Returns { best, alternatives, matchCount, confidence, documentsSearched }
 * (`best` is null when nothing matches), or { error }. Matching counts every
 * candidate cheaply; only the best and up to MAX_ALTERNATIVES others are
 * described in full: the source, the 1-based file line range, the enclosing
 * heading and anchor, the surrounding Markdown blocks, the GitHub blob URL
 * with #Lstart-Lend, and the page URL.
 *
 * Ranking and confidence: verbatim matches (the quote, whitespace collapsed,
 * appears as written) come first, then normalized ones, each group in
 * document order. Confidence is 1 for a verbatim best match, 0.9 for a
 * normalized one, and 0.5 for the head-and-tail fallback (the first and last
 * four words in order within a nearby window, used only when nothing matches
 * whole), divided by the number of candidates.
 */
export function locateInBundle(bundle, quote, { source } = {}) {
  const wanted = normalizeForMatch(quote).normalized.trim();
  if (wanted.replace(/ /g, '').length < MIN_QUOTE) return { error: `quote is too short to locate; it needs at least ${MIN_QUOTE} letters or digits` };
  const documents = source === undefined ? bundle.documents : bundle.documents.filter((document) => document.source === source);
  if (documents.length === 0) return { error: `unknown document "${source}"`, availableDocuments: bundle.documents.map((document) => document.source) };

  // The quote as written, split around its first and last letter or digit, for the verbatim check.
  const written = collapse(quote).trim();
  const core = written.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '');
  const lead = written.slice(0, written.indexOf(core));
  const trail = written.slice(written.indexOf(core) + core.length);

  const spansIn = (normalized) => {
    const exact = occurrences(normalized, wanted).map((at) => ({ from: at, to: at + wanted.length, exact: true }));
    if (exact.length > 0) return exact;
    const words = wanted.split(' ');
    if (words.length < ANCHOR_WORDS * 2) return [];
    const head = words.slice(0, ANCHOR_WORDS).join(' ');
    const tail = words.slice(-ANCHOR_WORDS).join(' ');
    const spans = [];
    for (const at of occurrences(normalized, head)) {
      const end = normalized.indexOf(tail, at + head.length);
      if (end !== -1 && end + tail.length - at <= wanted.length * 1.5 + 200) spans.push({ from: at, to: end + tail.length, exact: false });
    }
    return spans;
  };
  let candidates = documents.flatMap((document) => {
    const index = lineIndex(document.markdown);
    const { normalized, offsets } = normalizeForMatch(document.markdown, { markdown: true, index });
    const { markdown } = document;
    return spansIn(normalized).map(({ from, to, exact }) => {
      const start = offsets[from];
      const end = offsets[to - 1] + 1;
      const verbatim =
        exact &&
        collapse(markdown.slice(start, end)) === core &&
        collapse(markdown.slice(Math.max(0, start - lead.length), start)) === lead &&
        collapse(markdown.slice(end, end + trail.length)) === trail;
      return { document, index, start, end, exact, verbatim };
    });
  });
  if (candidates.some((candidate) => candidate.exact)) candidates = candidates.filter((candidate) => candidate.exact);
  if (candidates.length === 0) return { best: null, documentsSearched: documents.length };
  const ordered = [...candidates.filter((candidate) => candidate.verbatim), ...candidates.filter((candidate) => !candidate.verbatim)];
  const best = ordered[0];
  const base = best.verbatim ? 1 : best.exact ? 0.9 : 0.5;

  const outlines = new Map();
  const describe = ({ document, index, start, end, exact, verbatim }) => {
    if (!outlines.has(document)) outlines.set(document, { ...documentOutline(document.markdown), lines: document.markdown.split(/\r\n|\r|\n/) });
    const { blocks, headings, lines } = outlines.get(document);
    const lineOffset = document.lineOffset ?? 0;
    const repoPath = document.repoPath ?? document.source;
    const bodyStart = index.lineOf(start);
    const bodyEnd = index.lineOf(end - 1);
    const heading = headings.filter((entry) => entry.line <= bodyStart).at(-1) ?? null;
    const around = blocks.filter((block) => block.end >= bodyStart && block.start <= bodyEnd);
    const contextStart = Math.min(bodyStart, ...around.map((block) => block.start));
    const contextEnd = Math.max(bodyEnd, ...around.map((block) => block.end));
    const startLine = bodyStart + lineOffset;
    const endLine = bodyEnd + lineOffset;
    return {
      source: document.source,
      repoPath,
      startLine,
      endLine,
      heading: heading?.text ?? null,
      anchor: heading?.anchor ?? null,
      url: heading ? `${document.url}#${encodeURIComponent(heading.anchor)}` : document.url,
      blobUrl: `https://github.com/${bundle.repo}/blob/${bundle.sha ?? 'HEAD'}/${encodePath(repoPath)}#L${startLine}-L${endLine}`,
      markdown: `${lines.slice(contextStart - 1, contextEnd).join('\n')}\n`,
      match: verbatim ? 'verbatim' : exact ? 'normalized' : 'head-and-tail',
      ...(document.lineOffset === undefined ? { note: 'this bundle predates docs-kit 0.6.0, so line numbers assume the file has no front matter' } : {}),
    };
  };
  return {
    best: describe(best),
    alternatives: ordered.slice(1, 1 + MAX_ALTERNATIVES).map(describe),
    matchCount: ordered.length,
    confidence: Math.max(0.01, Math.round((base / ordered.length) * 100) / 100),
    documentsSearched: documents.length,
  };
}
