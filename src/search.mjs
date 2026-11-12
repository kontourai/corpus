import { analyzeMarkdown, plainText } from './markdown.mjs';

// Ranked search over docs bundles.
//
// The approach (BM25 over a part's fields, a part per table row that names a
// thing, half-weight synonyms, and a light stemmer applied to both sides) is
// adapted from pmndrs/pine's `src/manual.ts` (MIT, https://github.com/pmndrs/pine).
// The code here is written for Corpus bundles, not copied.
//
// A bundle is indexed the first time it is searched and the index is kept for
// as long as the bundle object lives. Row parts are derived from each
// document's Markdown at that point, so they need nothing from the bundle
// format: a bundle built by any Corpus version gets them.

/**
 * How much a hit in each field counts (`weight`, BM25F style) and how strongly
 * a long field is held against it (`b`). The weights are the ones term
 * matching used before BM25: title 5, id/source/tag 3, summary 2, body 1.
 * Headings and inline code are new fields and count like a summary.
 */
export const FIELDS = [
  { name: 'title', weight: 5, b: 0.3 },
  { name: 'meta', weight: 3, b: 0.4 },
  { name: 'summary', weight: 2, b: 0.5 },
  { name: 'headings', weight: 2, b: 0.5 },
  { name: 'code', weight: 2, b: 0.6 },
  { name: 'body', weight: 1, b: 0.75 },
];
const K1 = 1.2;
const SYNONYM_WEIGHT = 0.5;
const SNIPPET_WIDTH = 220;

/**
 * Words that say the same thing across the Kontour suite. A query word in a
 * group also finds the others at half weight. A product adds its own groups
 * with `synonyms` in corpus.json, which `build` copies into the bundle.
 */
export const SUITE_SYNONYMS = [
  ['schedule', 'cron', 'timer', 'recurring', 'periodic', 'interval', 'daily', 'hourly', 'nightly'],
  ['approval', 'approve', 'permission', 'consent', 'confirm', 'confirmation', 'allow', 'authorize', 'authorization', 'ask'],
  ['bypass', 'skip', 'override', 'waive', 'waiver', 'exception'],
  ['preview', 'plan', 'dryrun', 'simulate'],
  ['gate', 'check', 'guard', 'guardrail', 'block', 'checkpoint'],
  ['evidence', 'proof', 'receipt', 'attestation'],
  ['error', 'failure', 'fail', 'broken', 'problem', 'diagnostic'],
  ['troubleshoot', 'debug', 'diagnose', 'recover', 'recovery', 'fix'],
  ['install', 'setup', 'download'],
  ['configuration', 'config', 'configure', 'setting', 'option', 'preference'],
  ['command', 'cli', 'terminal', 'shell'],
  ['flag', 'option', 'argument', 'switch', 'parameter'],
  ['plugin', 'extension', 'addon'],
  ['mcp', 'tool', 'connector', 'integration'],
  ['session', 'conversation', 'chat', 'thread'],
  ['agent', 'assistant', 'bot', 'engine'],
  ['model', 'llm', 'provider', 'inference'],
  ['secret', 'credential', 'token', 'password', 'apikey'],
  ['document', 'doc', 'page', 'documentation', 'manual'],
  ['publish', 'deploy', 'release', 'ship'],
  ['search', 'find', 'lookup', 'query', 'retrieve'],
  ['find', 'discover', 'discovery', 'detect', 'locate', 'lookup'],
  ['website', 'site', 'web', 'webpage'],
  ['delete', 'remove', 'erase', 'purge', 'uninstall'],
  ['retry', 'rerun', 'resume', 'again'],
  ['phone', 'mobile', 'android', 'ios'],
  ['keyboard', 'shortcut', 'hotkey', 'keybinding'],
  ['link', 'url', 'href'],
  ['stale', 'outdated', 'freshness', 'obsolete'],
  ['notification', 'notify', 'alert'],
  ['workflow', 'process', 'pipeline'],
  ['decision', 'adr'],
  ['repository', 'repo', 'checkout'],
  ['folder', 'directory', 'dir'],
  ['offline', 'local'],
];

/** Words too common in questions to say anything about the answer. */
const STOP_WORDS = new Set(
  (
    'a an the and or of to in on for with by is are was were be been being how do does did i my me it its that this these those from as at into ' +
    'via can could should would will what which when where who whom why you your we our us there here if then than so not no yes use using ' +
    'want need about have has had mean means tell please just one some any each also way something anything everything thing things happen happens see would anyway still may might'
  ).split(' '),
);

/** Short forms that are the same word, not a synonym: they stem to the long form's stem. */
const SHORT_FORMS = { doc: 'document', docs: 'document', repo: 'repository', repos: 'repository', dir: 'directory', dirs: 'directory', env: 'environment' };

/**
 * A word without its ending, so subscribe, subscribes, subscribed and
 * subscribing are one word. Deliberately rough (plurals, -ing, -ed, a doubled
 * final consonant, a final e) and applied the same way to the bundle and the
 * query, so a mistake on one side is made on the other too. Words with
 * anything but a-z, and words of three letters or fewer, are left alone.
 */
export function stem(word) {
  if (Object.hasOwn(SHORT_FORMS, word)) return SHORT_FORMS[word];
  if (word.length <= 3 || !/^[a-z]+$/.test(word)) return word;
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (/(?:x|ch|sh|ss|zz|[^aeiou]o)es$/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith('s') && !/(?:ss|us|is)$/.test(w)) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  if (w.length > 3 && /([bdfgklmnprtz])\1$/.test(w)) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

/** A run of letters and digits, split at camelCase humps, lowercased. */
function pieces(run) {
  return run
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .toLowerCase()
    .split(' ');
}

/** Lowercased words of a text: punctuation, snake_case, kebab-case and camelCase split. Not stemmed. */
export function splitWords(text) {
  return (String(text ?? '').match(/[\p{L}\p{N}]+/gu) ?? []).flatMap(pieces);
}

/** Names written in one piece (`requireAnchors`, `base-url`, `list_topics`), joined and lowercased. */
function compounds(text) {
  return (String(text ?? '').match(/[\p{L}\p{N}]+(?:[_-][\p{L}\p{N}]+|(?<=\p{Ll}|\p{N})\p{Lu}[\p{L}\p{N}]*)+/gu) ?? []).map((name) =>
    name.replace(/[_-]/g, '').toLowerCase(),
  );
}

/** Stemmed index terms of a text; `withCompounds` also adds names written in one piece. */
function terms(text, withCompounds = false) {
  const list = splitWords(text);
  if (withCompounds) list.push(...compounds(text));
  return list.map(stem);
}

/** Every stem a synonym group joins to each of its words. */
function synonymMap(groups, into = new Map()) {
  for (const group of groups) {
    const stems = [...new Set(group.flatMap((word) => splitWords(word)).map(stem))];
    for (const s of stems) {
      const set = into.get(s) ?? new Set();
      for (const other of stems) if (other !== s) set.add(other);
      into.set(s, set);
    }
  }
  return into;
}

const SUITE_MAP = synonymMap(SUITE_SYNONYMS);

/**
 * Error for a `synonyms` value, or null. Shared by the manifest and the bundle
 * reader: an array of groups, each an array of at least two distinct single
 * words (letters and digits only, so a group never needs the tokenizer to
 * agree on where a phrase splits). `label` names the value in the message.
 */
export function synonymsError(value, label = 'synonyms') {
  if (!Array.isArray(value)) return `${label} must be an array of synonym groups`;
  for (const [index, group] of value.entries()) {
    const at = `${label}[${index}]`;
    if (!Array.isArray(group) || group.length < 2) return `${at} must be an array of at least two words`;
    for (const word of group)
      if (typeof word !== 'string' || !/^[\p{L}\p{N}]+$/u.test(word)) return `${at} has ${JSON.stringify(word)}; each entry must be one word of letters and digits`;
    if (new Set(group.map((word) => word.toLowerCase())).size !== group.length) return `${at} lists a word more than once`;
  }
  return null;
}

/** Inline code spans of up to 64 characters: names of keys, commands and flags. */
function codeSpans(markdown) {
  return (markdown.match(/`[^`\n]{1,64}`/g) ?? []).join(' ');
}

/**
 * Cut Markdown into passages at its headings of levels 1 to 3 (deeper
 * headings stay inside their passage), and collect the table rows that name
 * a thing: a row whose first cell has a code span (a key, a tool, a command,
 * a flag) and at least one more cell. A row's title is its first cell as it
 * reads and its name the first code span. Each carries the headings above it.
 * Only headings and tables outside lists and quotes count, as for topics.
 */
export function outline(markdown) {
  const { tokens } = analyzeMarkdown(markdown);
  const passages = [];
  const rows = [];
  const stack = []; // { depth, text, slug } of the headings above
  let current = { headings: [], text: '' };
  for (const token of tokens) {
    if (token.type === 'heading') {
      while (stack.length > 0 && stack.at(-1).depth >= token.depth) stack.pop();
      stack.push({ depth: token.depth, text: plainText(token.tokens).trim(), slug: token.slugId });
      if (token.depth <= 3) {
        if (current.text.trim()) passages.push(current);
        current = { headings: [...stack], text: '' };
      }
    }
    current.text += token.raw;
    if (token.type !== 'table') continue;
    const header = token.header.map((cell) => plainText(cell.tokens).trim());
    for (const row of token.rows) {
      const name = row[0]?.tokens.find((inline) => inline.type === 'codespan');
      if (!name || row.length < 2) continue;
      const told = row
        .slice(1)
        .map((cell, index) => {
          const text = plainText(cell.tokens).replace(/\s+/g, ' ').trim();
          return text && header[index + 1] ? `${header[index + 1]}: ${text}` : text;
        })
        .filter(Boolean);
      rows.push({
        name: plainText([name]).trim(),
        title: plainText(row[0].tokens).replace(/\s+/g, ' ').trim(),
        headings: [...stack],
        code: row.map((cell) => cell.text).join(' '),
        text: told.join('\n'),
        line: [row[0].text.trim(), ...told].join(' · '),
      });
    }
  }
  if (current.text.trim()) passages.push(current);
  return { passages, rows };
}

function countTerms(list) {
  const counts = new Map();
  for (const term of list) counts.set(term, (counts.get(term) ?? 0) + 1);
  return counts;
}

/** One passage's term counts per FIELDS entry: the unit's own fields, then the passage's headings, code and text. */
function passage(unitFields, headings, text, extra = {}) {
  const lists = [...unitFields, terms(headings.map((heading) => heading.text).join('\n')), terms(codeSpans(text), true), terms(text)];
  return { fields: lists.map((list) => ({ tf: countTerms(list), len: list.length })), ...extra };
}

const anchorUrl = (url, anchor) => `${url.replace(/#.*$/, '')}#${encodeURIComponent(anchor)}`;

/**
 * The bundle's searchable units (topics, documents, table rows), each with
 * the passages it is scored by. A document passage that a topic of the same
 * source covers (the topic's anchor is one of the headings it stands under,
 * or the topic is the whole file) belongs to that topic only, so one passage
 * never ranks twice. Rows come from documents.
 */
function buildIndex(bundle) {
  const units = [];
  const topicsBySource = new Map();
  for (const topic of bundle.topics) {
    const [path, ...rest] = topic.source.split('#');
    const anchor = rest.length > 0 ? rest.join('#') : null;
    if (!topicsBySource.has(path)) topicsBySource.set(path, []);
    topicsBySource.get(path).push(anchor);
    // The bundle's own fields only, so a stray `kind` or `meta` key in a bundle cannot add to what is searched.
    const own = [terms(topic.title, true), terms([topic.id, topic.source, ...(topic.tags ?? [])].join(' '), true), terms(topic.summary ?? '')];
    const { passages } = outline(topic.markdown);
    units.push({
      result: { kind: 'topic', topic },
      kindRank: 0,
      passages: (passages.length > 0 ? passages : [{ headings: [], text: topic.markdown }]).map((p) => passage(own, p.headings, p.text, { markdown: p.text })),
    });
  }
  for (const document of bundle.documents) {
    const covering = topicsBySource.get(document.source) ?? [];
    const covered = (headings) => covering.some((anchor) => anchor === null || headings.some((heading) => heading.slug === anchor));
    const own = [terms(document.title, true), terms(document.source, true), []];
    const { passages, rows } = outline(document.markdown);
    const free = passages.filter((p) => !covered(p.headings));
    if (free.length > 0) units.push({ result: { kind: 'document', document }, kindRank: 2, passages: free.map((p) => passage(own, p.headings, p.text, { markdown: p.text })) });
    for (const row of rows) {
      const anchor = row.headings.at(-1)?.slug;
      units.push({
        result: { kind: 'row', document, row, url: anchor ? anchorUrl(document.url, anchor) : document.url },
        kindRank: 1,
        passages: [passage([terms(row.title, true), terms(document.source, true), []], row.headings, `${row.code}\n${row.text}`, { line: row.line })],
      });
    }
  }
  const df = new Map();
  const lengths = FIELDS.map(() => 0);
  let count = 0;
  for (const unit of units)
    for (const entry of unit.passages) {
      count++;
      const seen = new Set();
      entry.fields.forEach((field, index) => {
        lengths[index] += field.len;
        for (const term of field.tf.keys()) seen.add(term);
      });
      for (const term of seen) df.set(term, (df.get(term) ?? 0) + 1);
    }
  const synonyms = Array.isArray(bundle.synonyms) ? synonymMap(bundle.synonyms, synonymMap(SUITE_SYNONYMS)) : SUITE_MAP;
  return { units, count, df, lengths, synonyms };
}

const indexes = new WeakMap();

function indexFor(bundle) {
  let index = indexes.get(bundle);
  if (!index) {
    index = buildIndex(bundle);
    indexes.set(bundle, index);
  }
  return index;
}

/**
 * What a query asks for. `words` are its stemmed words without stop words
 * (all of them when nothing else is left); each is one share of the coverage.
 * `bonus` are names written in one piece, from the query's own compounds and,
 * for two to four words, the words run together ("base url" finds `baseUrl`);
 * they add score but no coverage, since a part that has them has the words too.
 */
function parseQuery(query) {
  const raw = splitWords(query);
  const kept = raw.filter((word) => !STOP_WORDS.has(word));
  const words = [...new Set((kept.length > 0 ? kept : raw).map(stem))];
  const bonus = new Set(compounds(query).map(stem));
  if (kept.length >= 2 && kept.length <= 4) bonus.add(stem(kept.join('')));
  for (const word of words) bonus.delete(word);
  return { words, bonus: [...bonus] };
}

/** Plain-text snippet around the first word whose stem the query asked for, else one of its synonyms. */
function snippetFor(markdown, wanted, alternates) {
  let at = -1;
  let fallback = -1;
  for (const match of markdown.matchAll(/[\p{L}\p{N}]+/gu)) {
    const stems = pieces(match[0]).map(stem);
    if (stems.some((s) => wanted.has(s))) {
      at = match.index;
      break;
    }
    if (fallback === -1 && stems.some((s) => alternates.has(s))) fallback = match.index;
  }
  if (at === -1) at = Math.max(fallback, 0);
  const start = Math.max(0, at - 80);
  const text = markdown.slice(start, start + SNIPPET_WIDTH).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${text}${start + SNIPPET_WIDTH < markdown.length ? '…' : ''}`;
}

function rowSnippet(line) {
  return line.length > 300 ? `${line.slice(0, 299)}…` : line;
}

/** The optional hierarchy fields a topic carries, for list and search results. */
export function hierarchyFields(topic) {
  return {
    ...(topic.parentId !== undefined ? { parentId: topic.parentId } : {}),
    ...(topic.tags !== undefined ? { tags: topic.tags } : {}),
    ...(topic.summary !== undefined ? { summary: topic.summary } : {}),
  };
}

/** Source identity on every result: the bundle sha, plus `dirty: true` for an uncommitted checkout. */
export function stamp(bundle) {
  return bundle.dirty ? { sha: bundle.sha, dirty: true } : { sha: bundle.sha };
}

function resultFor(bundle, entry) {
  const { kind } = entry.result;
  if (kind === 'topic') {
    const { topic } = entry.result;
    return { product: bundle.product, kind, id: topic.id, ...hierarchyFields(topic), title: topic.title, source: topic.source, url: topic.url, ...stamp(bundle) };
  }
  const { document } = entry.result;
  if (kind === 'document') return { product: bundle.product, kind, title: document.title, source: document.source, url: document.url, ...stamp(bundle) };
  const { row } = entry.result;
  return { product: bundle.product, kind, name: row.name, title: row.title, source: document.source, headings: row.headings.map((heading) => heading.text), url: entry.result.url, ...stamp(bundle) };
}

/**
 * Ranked search over the topics, documents and table rows of some bundles.
 *
 * Each part scores BM25 over its fields (FIELDS), with the field weights as
 * BM25F boosts and the document frequencies and average lengths taken over
 * every part of the bundles searched, so scores compare across products. A
 * query word also finds its synonyms (the suite's and the bundle's own) at
 * half weight, and both sides are stemmed. The total is then scaled by the
 * share of query words a part has (a word found only through a synonym counts
 * half). Equal scores rank a topic before a table row before a document.
 */
export function searchBundles(bundles, query, limit = 10) {
  const { words, bonus } = parseQuery(query);
  if (words.length === 0) return [];
  const indexed = bundles.map((bundle) => ({ bundle, index: indexFor(bundle) }));
  const total = indexed.reduce((sum, { index }) => sum + index.count, 0) || 1;
  const average = FIELDS.map((_, field) => indexed.reduce((sum, { index }) => sum + index.lengths[field], 0) / total || 1);
  const idfCache = new Map();
  const idf = (term) => {
    if (!idfCache.has(term)) {
      const n = indexed.reduce((sum, { index }) => sum + (index.df.get(term) ?? 0), 0);
      idfCache.set(term, Math.log(1 + (total - n + 0.5) / (n + 0.5)));
    }
    return idfCache.get(term);
  };
  const bm25 = (entry, term) => {
    let combined = 0;
    entry.fields.forEach((field, index) => {
      const count = field.tf.get(term);
      if (count) combined += (FIELDS[index].weight * count) / (1 - FIELDS[index].b + (FIELDS[index].b * field.len) / average[index]);
    });
    return combined === 0 ? 0 : (idf(term) * combined * (K1 + 1)) / (combined + K1);
  };
  const wanted = new Set(words);
  const results = [];
  for (const { bundle, index } of indexed) {
    // [term, weight, which query word it stands for, or -1 for a bonus term]
    const weighted = words.map((word, origin) => [word, 1, origin]);
    const alternates = new Set();
    words.forEach((word, origin) => {
      for (const synonym of index.synonyms.get(word) ?? []) {
        if (wanted.has(synonym)) continue;
        weighted.push([synonym, SYNONYM_WEIGHT, origin]);
        alternates.add(synonym);
      }
    });
    for (const term of bonus) weighted.push([term, 1, -1]);
    const passageScore = (entry) => {
      let score = 0;
      const direct = new Set();
      const viaSynonym = new Set();
      for (const [term, weight, origin] of weighted) {
        const termScore = bm25(entry, term);
        if (termScore === 0) continue;
        score += weight * termScore;
        if (origin === -1) continue;
        (weight === 1 ? direct : viaSynonym).add(origin);
      }
      // Soft "and": a passage with half of the query's words keeps half of its score.
      const covered = direct.size + [...viaSynonym].filter((origin) => !direct.has(origin)).length * SYNONYM_WEIGHT;
      return score * (covered / words.length);
    };
    for (const unit of index.units) {
      let best = null;
      let bestScore = 0;
      for (const entry of unit.passages) {
        const score = passageScore(entry);
        if (score > bestScore) {
          best = entry;
          bestScore = score;
        }
      }
      if (best === null) continue;
      results.push({
        ...resultFor(bundle, unit),
        score: Math.round(bestScore * 100) / 100,
        snippet: best.line !== undefined ? rowSnippet(best.line) : snippetFor(best.markdown, wanted, alternates),
        kindRank: unit.kindRank,
      });
    }
  }
  results.sort(
    (a, b) =>
      b.score - a.score || a.kindRank - b.kindRank || a.product.localeCompare(b.product) || a.source.localeCompare(b.source) || a.title.localeCompare(b.title),
  );
  return results.slice(0, limit).map(({ kindRank, ...result }) => result);
}
