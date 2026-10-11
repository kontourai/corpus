import path from 'node:path';
import GithubSlugger, { slug } from 'github-slugger';
import { Parser, Tokenizer } from 'htmlparser2';
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

const URL_ATTRIBUTES = new Set(['href', 'src', 'srcset', 'poster']);
const ANCHOR_ATTRIBUTES = new Set(['id', 'name']);

/**
 * Every attribute of every start tag in an HTML fragment, from htmlparser2's
 * tokenizer, so comments, quoting (double, single, unquoted), and `<!--` or
 * `>` inside attribute values follow the HTML tokenizer rather than a regex.
 * `start`/`end` cover the attribute (name through value) so callers can
 * rewrite it in place. Values are entity-decoded.
 */
export function scanHtmlAttributes(html) {
  const attributes = [];
  let current = null;
  const tokenizer = new Tokenizer(
    { decodeEntities: false },
    {
      onattribname(start, endIndex) {
        current = { name: html.slice(start, endIndex).toLowerCase(), raw: '', start };
      },
      onattribdata(start, endIndex) {
        if (current) current.raw += html.slice(start, endIndex);
      },
      onattribend(_quote, endIndex) {
        if (!current) return;
        attributes.push({ name: current.name, value: decodeEntities(current.raw), start: current.start, end: endIndex });
        current = null;
      },
      onattribentity() {},
      oncdata() {},
      onclosetag() {},
      oncomment() {},
      ondeclaration() {},
      onend() {},
      onopentagend() {},
      onopentagname() {},
      onprocessinginstruction() {},
      onselfclosingtag() {},
      ontext() {},
      ontextentity() {},
    },
  );
  tokenizer.write(html);
  tokenizer.end();
  return attributes;
}

/**
 * Parse a srcset value into { url, descriptor } candidates, following the
 * HTML algorithm: a URL is a run of non-whitespace (so commas inside a data:
 * URI stay in the URL), trailing commas end it, and descriptors run to the
 * next comma outside parentheses.
 */
export function parseSrcset(value) {
  const candidates = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && /[\s,]/.test(value[i])) i++;
    if (i >= value.length) break;
    let url = '';
    while (i < value.length && !/\s/.test(value[i])) url += value[i++];
    let descriptor = '';
    if (/,+$/.test(url)) url = url.replace(/,+$/, '');
    else {
      let depth = 0;
      while (i < value.length) {
        const char = value[i];
        if (char === '(') depth++;
        else if (char === ')') depth = Math.max(0, depth - 1);
        else if (char === ',' && depth === 0) break;
        descriptor += char;
        i++;
      }
    }
    if (url) candidates.push({ url, descriptor: descriptor.trim() });
  }
  return candidates;
}

/** Raw-HTML references: { attr, url } for href, src, poster, and each srcset candidate. */
export function extractHtmlReferences(html) {
  const references = [];
  for (const { name, value } of scanHtmlAttributes(html)) {
    if (!URL_ATTRIBUTES.has(name)) continue;
    // An empty href/src is a legal "same document" reference in raw HTML.
    if (name === 'srcset') for (const { url } of parseSrcset(value)) references.push({ attr: name, url });
    else if (value.trim() !== '') references.push({ attr: name, url: value });
  }
  return references;
}

function escapeAttributeValue(value) {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Rewrite every href/src/srcset/poster URL with `rewrite(url, attr)`; output is double-quoted. */
export function rewriteHtmlReferences(html, rewrite) {
  const targets = scanHtmlAttributes(html).filter((attribute) => URL_ATTRIBUTES.has(attribute.name));
  let output = html;
  for (const attribute of targets.reverse()) {
    const value =
      attribute.name === 'srcset'
        ? parseSrcset(attribute.value)
            .map(({ url, descriptor }) => [rewrite(url, 'srcset'), descriptor].filter(Boolean).join(' '))
            .join(', ')
        : attribute.value.trim() === ''
          ? attribute.value
          : rewrite(attribute.value, attribute.name);
    output = `${output.slice(0, attribute.start)}${attribute.name}="${escapeAttributeValue(value)}"${output.slice(attribute.end)}`;
  }
  return output;
}

/** Fragment targets declared in HTML: `id` and `name` attributes in any quoting. */
export function extractHtmlAnchors(html) {
  return scanHtmlAttributes(html)
    .filter((attribute) => ANCHOR_ATTRIBUTES.has(attribute.name) && attribute.value !== '')
    .map((attribute) => attribute.value);
}

export const FRONT_MATTER_MAX_LINES = 200;
const FRONT_MATTER_OPEN = /^---[ \t]*$/;
const FRONT_MATTER_CLOSE = /^(?:---|\.\.\.)[ \t]*$/;

/**
 * Split a leading YAML front-matter block, Jekyll style: `---` on line 1 and
 * a closing `---` or `...` line within the first FRONT_MATTER_MAX_LINES
 * lines. An unclosed block is not front matter, so nothing is stripped.
 * Returns { body, lineOffset, title }: `lineOffset` is the number of source
 * lines removed, so body line N is source line N + lineOffset, and `title`
 * is a simple top-level `title: value` (optionally quoted) or null. No YAML
 * parser: any other form of title is ignored.
 */
export function splitFrontMatter(text) {
  const none = { body: text, lineOffset: 0, title: null };
  const lines = text.split('\n');
  if (lines.length < 2 || !FRONT_MATTER_OPEN.test(lines[0].replace(/\r$/, ''))) return none;
  const limit = Math.min(lines.length, FRONT_MATTER_MAX_LINES);
  for (let close = 1; close < limit; close++) {
    if (!FRONT_MATTER_CLOSE.test(lines[close].replace(/\r$/, ''))) continue;
    return {
      body: lines.slice(close + 1).join('\n'),
      lineOffset: close + 1,
      title: frontMatterTitle(lines.slice(1, close).map((line) => line.replace(/\r$/, ''))),
    };
  }
  return none;
}

function frontMatterTitle(lines) {
  for (const line of lines) {
    const match = /^title:(?:[ \t]+(.*))?$/.exec(line);
    if (!match) continue;
    const value = (match[1] ?? '').trim();
    let title;
    const quoted = /^"((?:[^"\\]|\\.)*)"(?:[ \t]+#.*)?$/.exec(value) ?? /^'((?:[^']|'')*)'(?:[ \t]+#.*)?$/.exec(value);
    if (quoted) title = value[0] === '"' ? quoted[1].replace(/\\(["\\])/g, '$1') : quoted[1].replaceAll("''", "'");
    // Unquoted: a plain scalar up to a ` #` comment. Block scalars, flow
    // collections, anchors, tags, and null are not the simple form.
    else if (/^[|>[{&*!'"%@`]/.test(value)) return null;
    else title = value.replace(/[ \t]+#.*$/, '');
    title = title.trim();
    return title === '' || (!quoted && /^(?:~|null)$/i.test(title)) ? null : title;
  }
  return null;
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
 * the title (first top-level Markdown H1, else the first top-level raw-HTML
 * `<h1>` with text, else `frontMatterTitle`). `source` is the body after
 * front matter; `lineOffset` maps its line numbers back to the file.
 */
export function analyzeMarkdown(source, { lineOffset = 0, frontMatterTitle = null } = {}) {
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
          links.push({ kind: 'html', attr, href: url, text: attr, line: index === -1 ? null : lineAt(source, index) + lineOffset });
      }
    } else if ((token.type === 'link' || token.type === 'image') && typeof token.href === 'string') {
      let index = source.indexOf(token.raw, cursor);
      if (index === -1) index = source.indexOf(token.raw);
      if (index !== -1) cursor = index + token.raw.length;
      links.push({
        kind: token.type,
        href: token.href,
        text: token.type === 'image' ? token.text : plainText(token.tokens) || token.text,
        line: index === -1 ? null : lineAt(source, index) + lineOffset,
      });
    }
  });

  const h1 = headings.find((heading) => heading.depth === 1 && heading.topLevel);
  return { tokens, headings, anchors, links, title: h1?.text || htmlH1Text(tokens) || frontMatterTitle };
}

/**
 * Text of the first raw-HTML `<h1>` with text in a top-level HTML block, as a
 * browser would show it (tags dropped, entities decoded, whitespace
 * collapsed). An `<h1>` holding only an image has no text and is skipped.
 */
function htmlH1Text(tokens) {
  for (const token of tokens) {
    if (token.type !== 'html' || !token.text) continue;
    const found = [];
    let depth = 0;
    let text = '';
    const parser = new Parser(
      {
        onopentag(name) {
          if (name === 'h1' && depth++ === 0) text = '';
        },
        ontext(chunk) {
          if (depth > 0) text += chunk;
        },
        onclosetag(name) {
          if (name === 'h1' && depth > 0 && --depth === 0) found.push(text);
        },
      },
      { decodeEntities: true },
    );
    parser.write(token.text);
    parser.end();
    // An <h1> left open at the end of the block (closed in a later block) still counts.
    if (depth > 0) found.push(text);
    const title = found.map((value) => value.replace(/\s+/g, ' ').trim()).find(Boolean);
    if (title) return title;
  }
  return null;
}

/**
 * Document title: the manifest `title` override, else the first Markdown H1,
 * else the first raw-HTML `<h1>`, else the front-matter `title`, else the
 * file name without its extension.
 */
export function documentTitle(analysis, source, override = null) {
  return override || analysis.title || path.posix.basename(source).replace(/\.md$/i, '');
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
