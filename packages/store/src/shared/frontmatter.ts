import { isDeepStrictEqual } from 'node:util';
import { dump, FAILSAFE_SCHEMA, CORE_SCHEMA, EVENT_ID, SCALAR_STYLE, getScalarValue, parseEvents, load, type Event, type ScalarEvent, type LoadOptions } from 'js-yaml';

interface ParsedMarkdown { meta: Record<string, unknown>; body: string }
type Path = (string | number)[];
interface SourceNode { kind: 'scalar' | 'mapping' | 'sequence' | 'alias'; start: number; end: number; scalar?: ScalarEvent; pairs?: { key: SourceNode; value: SourceNode; name: string }[]; items?: SourceNode[] }
interface SavedPair { path: Path; start: number; end: number; value: unknown }
interface SourceState { yaml: string; pairs: SavedPair[] }
// Enumerable symbols survive the record spreads in both adapters; YAML and JSON omit them.
const SOURCE = Symbol('corpus.frontmatter.source');
const ROOT_STRINGS = new Set(['id', 'type', 'title', 'category', 'status', 'created_at', 'updated_at', 'expires_at', '_body_sentinel']);
const PROVENANCE_STRINGS = new Set(['agent', 'session_id', 'note']);
const LINK_STRINGS = new Set(['target_id', 'kind', 'label']);
const LOG_STRINGS = new Set(['op', 'at', 'agent', 'note', 'rationale', 'new_id']);
const EVIDENCE_STRINGS: Record<string, Set<string>> = {
  update: new Set(), link: new Set(),
  propose: new Set(['concept_id', 'proposer_id', 'proposal']),
  apply: new Set(['proposer_id', 'rationale']),
  reject: new Set(['proposer_id', 'reason']),
  'superseded-by': new Set(['superseded_by_id']),
  retire: new Set(['targetStatus', 'rationale', 'implementedByRef', 'supersededByRef']),
};
function at(value: unknown, path: Path): unknown {
  for (const key of path) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}
/** All fields written by Station are enumerated here; unknown extensions use lossless core scalars. */
function fieldType(path: Path, meta: unknown): 'string' | 'number' | 'container' | 'unknown' {
  const [root, index, key, evidenceKey, item, linkKey] = path;
  if (path.length === 1) {
    if (ROOT_STRINGS.has(String(root))) return 'string';
    if (root === 'ttl_seconds') return 'number';
    if (['tags', 'aliases', 'links', 'provenance', 'mutation_log'].includes(String(root))) return 'container';
  }
  if (['tags', 'aliases'].includes(String(root)) && path.length === 2) return 'string';
  if (root === 'provenance') {
    if (path.length === 2 && PROVENANCE_STRINGS.has(String(index))) return 'string';
    if (index === 'source_ids') return path.length === 2 ? 'container' : 'string';
  }
  if (root === 'links') {
    if (path.length === 2) return 'container';
    if (path.length === 3 && LINK_STRINGS.has(String(key))) return 'string';
  }
  if (root === 'mutation_log') {
    if (path.length === 2) return 'container';
    if (path.length === 3 && LOG_STRINGS.has(String(key))) return 'string';
    if (key === 'evidence') {
      if (path.length === 3) return 'container';
      const op = at(meta, ['mutation_log', index, 'op']);
      if (path.length === 4 && EVIDENCE_STRINGS[String(op)]?.has(String(evidenceKey))) return 'string';
      if (op === 'supersede' && evidenceKey === 'superseded_count' && path.length === 4) return 'number';
      if (op === 'update' && evidenceKey === 'fields') return path.length === 4 ? 'container' : 'string';
      if (op === 'link' && evidenceKey === 'added') {
        if (path.length <= 5) return 'container';
        if (path.length === 6 && typeof item === 'number' && LINK_STRINGS.has(String(linkKey))) return 'string';
      }
    }
  }
  return 'unknown';
}
function sourceTree(source: string, options?: Pick<LoadOptions, 'maxDepth'>): SourceNode {
  const events = parseEvents(source, options ?? {});
  let cursor = 1; // document event
  function node(): SourceNode {
    const event: Event = events[cursor++];
    if (event.type === EVENT_ID.SCALAR) {
      const quoted = event.style === SCALAR_STYLE.SINGLE_QUOTED || event.style === SCALAR_STYLE.DOUBLE_QUOTED;
      return { kind: 'scalar', start: event.valueStart - (quoted ? 1 : 0), end: event.valueEnd + (quoted ? 1 : 0), scalar: event };
    }
    if (event.type === EVENT_ID.ALIAS) return { kind: 'alias', start: event.anchorStart - 1, end: event.anchorEnd };
    if (event.type !== EVENT_ID.MAPPING && event.type !== EVENT_ID.SEQUENCE) throw new Error('Invalid frontmatter event tree');
    const result: SourceNode = { kind: event.type === EVENT_ID.MAPPING ? 'mapping' : 'sequence', start: event.start, end: event.start };
    if (result.kind === 'mapping') {
      result.pairs = [];
      while (events[cursor].type !== EVENT_ID.POP) {
        const key = node();
        const value = node();
        if (!key.scalar) throw new Error('Frontmatter keys must be scalar');
        result.pairs.push({ key, value, name: getScalarValue(source, key.scalar) });
        result.end = Math.max(result.end, value.end);
      }
    } else {
      result.items = [];
      while (events[cursor].type !== EVENT_ID.POP) {
        const child = node(); result.items.push(child); result.end = Math.max(result.end, child.end);
      }
    }
    cursor++;
    // Flow closing delimiters are outside the last child's source range.
    if (event.style === 2) result.end = source.indexOf(result.kind === 'mapping' ? '}' : ']', result.end) + 1;
    return result;
  }
  return node();
}
function pairEnd(source: string, end: number): number {
  const newline = source.indexOf('\n', end);
  const tail = source.slice(end, newline < 0 ? source.length : newline);
  return /^[ \t]*(?:#.*)?$/.test(tail) ? (newline < 0 ? source.length : newline) : end;
}
function pairs(root: SourceNode, source: string, meta: unknown): SavedPair[] {
  const result: SavedPair[] = [];
  function walk(node: SourceNode, path: Path) {
    for (const pair of node.pairs ?? []) {
      const childPath = [...path, pair.name];
      if (fieldType(childPath, meta) === 'unknown') {
        result.push({ path: childPath, start: pair.key.start, end: pairEnd(source, pair.value.end), value: structuredClone(at(meta, childPath)) });
      }
      walk(pair.value, childPath);
    }
    node.items?.forEach((item, i) => walk(item, [...path, i]));
  }
  walk(root, []);
  return result;
}
function repairDash(source: string): { source: string; originalOffset: (offset: number) => number } {
  const edits: { start: number; end: number; replacement: string }[] = [];
  // Old scalar writers emitted these invalid plain mapping values, including extension fields.
  const pattern = /^( *)(?:- )?[^:\n]+: (-[^\r\n]*)$/gm;
  for (const match of source.matchAll(pattern)) {
    const rawValue = match[2];
    const comment = rawValue.indexOf(" #");
    const value = comment < 0 ? rawValue : rawValue.slice(0, comment);
    if (value.trim() !== value || !/^-(?:[ \t].*)?$/.test(value) || /[:#\[\]{},&*?|<>=!%@`"'\r]/.test(value)) continue;
    const start = match.index! + match[0].length - rawValue.length;
    edits.push({ start, end: start + value.length, replacement: JSON.stringify(value) });
  }
  let repaired = source;
  for (const edit of [...edits].reverse()) repaired = repaired.slice(0, edit.start) + edit.replacement + repaired.slice(edit.end);
  return { source: repaired, originalOffset(offset) {
    let extra = 0;
    for (const edit of edits) {
      const start = edit.start + extra;
      if (offset <= start) break;
      if (offset < start + edit.replacement.length) return edit.start + Math.min(offset - start, edit.end - edit.start);
      extra += edit.replacement.length - (edit.end - edit.start);
    }
    return offset - extra;
  } };
}
function convert(meta: Record<string, unknown>, core: unknown, root: SourceNode): void {
  function walk(node: SourceNode, path: Path) {
    if (node.scalar && path.length) {
      const original = at(meta, path);
      const typed = at(core, path);
      const kind = fieldType(path, meta);
      const plain = node.scalar.style === SCALAR_STYLE.PLAIN;
      let value = original;
      if (kind === 'number' && plain && typeof typed === 'number') value = typed;
      else if (kind === 'unknown' && plain && (typed === null && original === 'null' || typeof typed === 'boolean' && String(typed) === original || typeof typed === 'number' && Number.isFinite(typed) && String(typed) === original)) value = typed;
      const parent = at(meta, path.slice(0, -1)) as Record<string | number, unknown>;
      parent[path.at(-1)!] = value;
    }
    for (const pair of node.pairs ?? []) walk(pair.value, [...path, pair.name]);
    node.items?.forEach((item, i) => walk(item, [...path, i]));
  }
  walk(root, []);
}
export function parseMarkdown(text: string, options?: Pick<LoadOptions, 'maxDepth' | 'maxAliases' | 'maxTotalMergeKeys'>): ParsedMarkdown {
  if (!text.startsWith('---\n')) return { meta: {}, body: text };
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) return { meta: {}, body: text };
  const raw = text.slice(4, end);
  const body = text.slice(end + 5).replace(/^\n+/, '');
  let source = raw;
  let offset = (position: number) => position;
  let value: unknown;
  try { value = load(source, { ...options, schema: FAILSAFE_SCHEMA }); }
  catch (error) {
    const repaired = repairDash(raw);
    if (repaired.source === raw) throw error;
    source = repaired.source; offset = repaired.originalOffset;
    value = load(source, { ...options, schema: FAILSAFE_SCHEMA });
  }
  const meta = value ?? {};
  if (typeof meta !== 'object' || Array.isArray(meta)) throw new Error('Knowledge frontmatter must be a mapping');
  const record = meta as Record<string, unknown>;
  const tree = sourceTree(source, options);
  convert(record, load(source, { ...options, schema: CORE_SCHEMA }), tree);
  const saved = pairs(tree, source, record).map((pair) => ({ ...pair, start: offset(pair.start), end: offset(pair.end) }));
  Object.defineProperty(record, SOURCE, { enumerable: true, value: { yaml: raw, pairs: saved } satisfies SourceState });
  return { meta: record, body };
}
export function serializeMarkdown(meta: Record<string, unknown>, body: string): string {
  let frontmatter = dump(meta, { lineWidth: -1 }).trimEnd();
  const saved = (meta as Record<symbol, SourceState>)[SOURCE];
  if (saved?.pairs.length) {
    const emitted = pairs(sourceTree(frontmatter), frontmatter, meta);
    const replacements: { start: number; end: number; text: string }[] = [];
    for (const pair of saved.pairs) {
      if (!isDeepStrictEqual(at(meta, pair.path), pair.value)) continue;
      const target = emitted.find((candidate) => isDeepStrictEqual(candidate.path, pair.path));
      if (target) replacements.push({ start: target.start, end: target.end, text: saved.yaml.slice(pair.start, pair.end) });
    }
    const outermost = replacements.filter((candidate) => !replacements.some((parent) => parent !== candidate && parent.start <= candidate.start && parent.end >= candidate.end));
    for (const replacement of outermost.sort((a, b) => b.start - a.start)) frontmatter = frontmatter.slice(0, replacement.start) + replacement.text + frontmatter.slice(replacement.end);
  }
  return `---\n${frontmatter}\n---\n\n${body}`;
}
