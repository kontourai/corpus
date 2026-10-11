import { analyzeMarkdown, blockLines, plainText } from './markdown.mjs';
import { encodePath } from './paths.mjs';

/**
 * Find a quoted passage, typically text selected on a rendered docs page, in
 * a bundle's Markdown and report where it lives in the source file.
 *
 * Both sides are reduced to a comparable form: lowercase letters and digits,
 * with every run of whitespace or punctuation collapsed to one space. Markdown
 * that renders as nothing is dropped from the document side first: link and
 * image destinations, HTML tags and comments, entities, fence lines, list and
 * task markers, and reference definitions. Emphasis and code marks (`*`, `_`,
 * `~`, backticks) and backslashes are dropped on both sides without leaving a
 * gap, so `**foo**bar` matches the rendered `foobar`. Each kept character
 * remembers its offset in the original Markdown, so a match maps back to
 * exact lines.
 */

const DROPPED = /[*_~`\\]/;
const WORD = /[\p{L}\p{N}]/u;
const MIN_QUOTE = 3;
const ANCHOR_WORDS = 4;

/** Character ranges of Markdown that render as nothing. */
function hiddenRanges(markdown) {
  const patterns = [
    /\]\((?:[^()\s]|\([^()]*\))*(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g, // ](destination "title")
    /\]\[[^\]\n]*\]/g, // ][reference]
    /^ {0,3}\[[^\]\n]+\]:.*$/gm, // [reference]: definition
    /<!--[\s\S]*?-->/g,
    /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/g, // tags, but not autolinks such as <https://x>
    /&(?:#x[\da-f]+|#\d+|[a-z][a-z\d]*);/gi,
    /^[ \t]*(?:`{3,}|~{3,}).*$/gm, // fence lines and their info strings
    /^[ \t>]*(?:[-+*]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, // list and task markers
  ];
  const hidden = new Uint8Array(markdown.length);
  for (const pattern of patterns)
    for (const match of markdown.matchAll(pattern)) {
      // A `](...)` match keeps its `]`; only the destination is hidden.
      const from = match[0].startsWith('](') || match[0].startsWith('][') ? match.index + 1 : match.index;
      hidden.fill(1, from, match.index + match[0].length);
    }
  return hidden;
}

/** The comparable form of `text`, plus each output character's offset in `text`. */
export function normalizeForMatch(text, { markdown = false } = {}) {
  const hidden = markdown ? hiddenRanges(text) : null;
  let normalized = '';
  const offsets = [];
  for (let i = 0; i < text.length; ) {
    const char = String.fromCodePoint(text.codePointAt(i));
    if (!hidden?.[i] && WORD.test(char)) {
      for (const unit of char.toLowerCase()) {
        normalized += unit;
        for (let k = 0; k < unit.length; k++) offsets.push(i);
      }
    } else if (!DROPPED.test(char) && normalized !== '' && !normalized.endsWith(' ')) {
      normalized += ' ';
      offsets.push(i);
    }
    i += char.length;
  }
  return { normalized, offsets };
}

function lineOfOffset(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
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

/**
 * Locate `quote` in the documents of `bundle` (optionally only `source`).
 * Returns { matches, documentsSearched } where each match has the source, the
 * 1-based file line range, the enclosing heading and anchor, the surrounding
 * Markdown blocks, the GitHub blob URL with #Lstart-Lend, the page URL, and
 * an `exact` flag (false for the head-and-tail fallback used when the whole
 * quote does not match, for example across an image or a diagram).
 */
export function locateInBundle(bundle, quote, { source } = {}) {
  const wanted = normalizeForMatch(quote).normalized.trim();
  if (wanted.length < MIN_QUOTE) return { error: `quote is too short to locate; it needs at least ${MIN_QUOTE} letters or digits` };
  const documents = source === undefined ? bundle.documents : bundle.documents.filter((document) => document.source === source);
  if (documents.length === 0) return { error: `unknown document "${source}"`, availableDocuments: bundle.documents.map((document) => document.source) };
  const collapsed = quote.replace(/\s+/g, ' ').trim();

  const spansIn = (normalized) => {
    const exact = occurrences(normalized, wanted).map((at) => ({ from: at, to: at + wanted.length, exact: true }));
    if (exact.length > 0) return exact;
    // Fallback: the first and last few words, in order, within a window a bit longer than the quote.
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

  const matches = [];
  for (const document of documents) {
    const { markdown } = document;
    const { normalized, offsets } = normalizeForMatch(markdown, { markdown: true });
    const spans = spansIn(normalized);
    if (spans.length === 0) continue;
    const lineOffset = document.lineOffset ?? 0;
    const repoPath = document.repoPath ?? document.source;
    const { blocks, headings } = documentOutline(markdown);
    const lines = markdown.split('\n');
    for (const { from, to, exact } of spans) {
      const startOffset = offsets[from];
      const endOffset = offsets[to - 1];
      const bodyStart = lineOfOffset(markdown, startOffset);
      const bodyEnd = lineOfOffset(markdown, endOffset);
      const heading = headings.filter((entry) => entry.line <= bodyStart).at(-1) ?? null;
      const around = blocks.filter((block) => block.end >= bodyStart && block.start <= bodyEnd);
      const contextStart = Math.min(bodyStart, ...around.map((block) => block.start));
      const contextEnd = Math.max(bodyEnd, ...around.map((block) => block.end));
      const startLine = bodyStart + lineOffset;
      const endLine = bodyEnd + lineOffset;
      // Verbatim: the quote, whitespace collapsed, is in the source around the
      // match (the normalized span leaves out leading and trailing punctuation).
      const slack = 32;
      const verbatim = markdown.slice(Math.max(0, startOffset - slack), endOffset + 1 + slack).replace(/\s+/g, ' ').includes(collapsed);
      matches.push({
        source: document.source,
        repoPath,
        startLine,
        endLine,
        heading: heading?.text ?? null,
        anchor: heading?.anchor ?? null,
        url: heading ? `${document.url}#${encodeURIComponent(heading.anchor)}` : document.url,
        blobUrl: `https://github.com/${bundle.repo}/blob/${bundle.sha ?? 'HEAD'}/${encodePath(repoPath)}#L${startLine}-L${endLine}`,
        markdown: `${lines.slice(contextStart - 1, contextEnd).join('\n').replace(/\r$/gm, '')}\n`,
        exact,
        verbatim: exact && verbatim,
        ...(document.lineOffset === undefined ? { note: 'this bundle predates docs-kit 0.6.0, so line numbers assume the file has no front matter' } : {}),
      });
    }
  }
  return { matches, documentsSearched: documents.length };
}

/**
 * Confidence for the best match: 1 for a unique verbatim match, 0.9 when it
 * only matched after normalization (formatting, whitespace, punctuation), 0.5
 * for the head-and-tail fallback, divided by the number of candidates of that
 * kind when the quote is ambiguous.
 */
export function rankMatches(matches) {
  const exact = matches.filter((match) => match.exact);
  const pool = exact.length > 0 ? exact : matches;
  const ordered = [...pool].sort((a, b) => Number(b.verbatim) - Number(a.verbatim));
  const [best, ...alternatives] = ordered;
  const base = best.verbatim ? 1 : best.exact ? 0.9 : 0.5;
  return { best, alternatives, confidence: Math.round((base / pool.length) * 100) / 100 };
}
