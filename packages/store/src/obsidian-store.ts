import { captureRootBinding } from './root-binding.js';
import { scaffoldNewRootIdentity } from './shared/file-transactions.js';
import { RootBindingMismatchError } from './errors.js';
/**
 * Station-owned Kit-format adapter with an Obsidian vault layout.
 * Disk layout, external-edit behavior, and the original H1/M1/M2 regression
 * rationale are in docs/guides/knowledge.md#store-formats-and-external-edits.
 *
 * Do not simplify delimiter handling: bodies may contain sentinel text and
 * authored labels must not forge a generated-section boundary. The writer
 * records a collision-free _body_sentinel; reads use the last exact line,
 * preserve unrecognized trailing content, and hide this bookkeeping field.
 * Removing the real boundary AND inserting a look-alike in one external edit
 * remains a known limitation. Keep the obsidian-store.contract.test.ts cases.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  ApplyEvidence,
  CategoryListOptions,
  CreateInput,
  CreateProposalListOptions,
  KitCreateProposal,
  KitLink,
  KitMutationLogEntry,
  KitRecord,
  KitRecordType,
  KitReverseLink,
  KnowledgeStoreAdapter,
  KnowledgeStoreCreateProposals,
  KnowledgeStorePurger,
  LinkEvidence,
  ListOptions,
  ProposeEvidence,
  PurgeEvidence,
  PurgeResult,
  RejectEvidence,
  RetireEvidence,
  SupersedeEvidence,
  UpdateEvidence,
  UpdateFields,
} from './contracts.js';
import { resolveServices, type StoreOptions, type ResolvedServices, diagnostics } from './services.js';
import {
  KnowledgeRecordNotFoundError,
  KnowledgeStoreCorruptionError,
  MissingEvidenceError,
  ReadOnlyStoreError,
} from './errors.js';
import { isValidCategory } from './shared/category.js';
import { assertCreateFields } from './shared/create-input.js';
import { CreateProposals, PROPOSALS_DIRECTORY } from './shared/create-proposals.js';
import { KnowledgeFileTransactions } from './shared/file-transactions.js';
import { assertCompiledSource } from './shared/compiled-source.js';
import { expiryFilter, freshnessPatch } from './shared/freshness.js';
import { includesHistory, isHistorical } from './shared/lifecycle.js';
import { parseMarkdown, serializeMarkdown } from './shared/frontmatter.js';
import {
  addLinksToGraph,
  assertGraphIndex,
  canonicalGraph,
  emptyGraph,
  type GraphIndex,
  type ReindexResult,
  removeLinksFromGraph,
} from './shared/graph-index.js';
import {
  type AliasIndex,
  assertAliasIndex,
  emptyAliasIndex,
  normalizeAliases,
  registerAliases,
  resolveRecordId,
  unregisterAliases,
} from './shared/identity.js';
import {
  assertNoPurgedSupport,
  assertNotPurged,
  planPurge,
  survivorOf,
  TOMBSTONE_SHAPES,
  tombstoneOf,
  validatePurgeInput,
} from './shared/purge.js';
import {
  assertKitRecord,
  VALID_STATUS_TRANSITIONS,
} from './shared/record-schema.js';
import {
  appendUniqueLinks,
  extractWikilinks,
  mergeLinks,
  sanitizeLinks,
} from './shared/wikilinks.js';

const logger = diagnostics;

export type { ReindexResult };

// Invisible sentinel emitted between the body and any generated structural sections
// (Sources/People/Related) in every rendered note. Obsidian renders HTML comments as
// nothing, so vault readers never see it. On read, everything before the sentinel
// ACTUALLY used for this record (see `_body_sentinel` frontmatter key / `readRecord`)
// is the canonical body — collision-proof against user body text containing
// `## Sources`-shaped headings AND against user body text containing the sentinel
// substring itself (H1 fix; see `chooseBodySentinel` below).
const BODY_END_SENTINEL_BASE = '<!-- kit:body-end -->';
// Frontmatter key recording the ACTUAL sentinel used for a record, only ever written
// when it differs from `BODY_END_SENTINEL_BASE`. Underscore-prefixed so it reads
// unambiguously as adapter-owned bookkeeping rather than a Kit contract field — the
// unknown-frontmatter-key preservation guarantee (OKF v0.1 tolerance; see
// contract-suite.ts) means any other conformant reader that doesn't know this key
// simply ignores it, exactly like any other foreign frontmatter field.
const BODY_SENTINEL_FRONTMATTER_KEY = '_body_sentinel';
// Shape a `_body_sentinel` frontmatter value must match to be trusted as an
// adapter-generated delimiter (either the bare default, or the filler-based lengthened
// form `chooseBodySentinel` can produce). Guards against a user's own, unrelated
// `_body_sentinel` key (M1 edge case, Wave-2 code review iteration 2): a value that
// does not match this shape is treated as malformed rather than authoritative.
const SENTINEL_SHAPE_PATTERN = /^<!-- kit:body-end(?::x+)? -->$/;
// The exact set of generated-section headings `renderObsidianBody` can append after the
// sentinel line. Anything else found after the sentinel on read is human-authored
// content, not adapter output, and is merged back into the body rather than discarded
// (M2 fix, Wave-2 code review iteration 2 — see `extractUnrecognizedTrailingContent`).
const KNOWN_TRAILING_SECTION_PREFIXES = [
  '## Sources',
  '## Appears In',
  '## People',
  '## Related',
];
const RAW_CALLOUT_HEADER = '> [!note]- Raw Notes';

/**
 * Choose the exact sentinel string to delimit a record's body from any generated
 * structural sections that follow it in the rendered note.
 *
 * Correctness argument (deterministic, not probabilistic — no loop, no randomness):
 * - If `renderedBodyPart` (the fully-rendered body text, including the raw-callout
 *   `"> "` quoting for `raw` records) does not contain the literal substring
 *   `BODY_END_SENTINEL_BASE`, that default sentinel is used verbatim (the common case
 *   — matches every existing on-disk record, so this is a purely additive change).
 * - Otherwise, a fresh sentinel is built by interposing a run of filler characters
 *   (`'x'.repeat(renderedBodyPart.length + 1)`) between a distinguishing prefix and
 *   suffix. The resulting candidate's length is, by construction, STRICTLY GREATER
 *   than `renderedBodyPart.length`. A string can never contain a substring longer
 *   than itself, so this candidate is *provably* absent from `renderedBodyPart` —
 *   this holds for every possible input, including the adversarial "recursion" case
 *   where `renderedBodyPart` itself contains text shaped exactly like a sentinel this
 *   same function could produce for some OTHER (shorter) body: any such embedded
 *   lengthened-looking marker is, definitionally, shorter than `renderedBodyPart`,
 *   while our chosen candidate is always longer than the WHOLE of `renderedBodyPart`.
 *   No search/retry loop is needed and none can be required — the length argument
 *   alone is dispositive, which is what makes this the simpler of the two schemes
 *   considered (the alternative, escape-on-write/unescape-on-read, requires a
 *   separate, harder proof that escaping is its own exact inverse under nested/
 *   repeated escape sequences; the length-based MIME-boundary-style scheme sidesteps
 *   that class of bug entirely).
 */
function chooseBodySentinel(renderedBodyPart: string): string {
  if (!renderedBodyPart.includes(BODY_END_SENTINEL_BASE)) {
    return BODY_END_SENTINEL_BASE;
  }
  const filler = 'x'.repeat(renderedBodyPart.length + 1);
  return `<!-- kit:body-end:${filler} -->`;
}

/**
 * Defense-in-depth against the label-injection sentinel-corruption class (H1 fix,
 * Wave-2 code review iteration 4 — see the header comment's "(b)" bullet). Scans
 * `text` (a single generated section's rendered content, e.g. the `## Related`
 * block) line by line and neutralizes — by wrapping in backticks, which turns an
 * would-be HTML-comment sentinel line into inline code text instead — any line that
 * is a full, line-exact match for `SENTINEL_SHAPE_PATTERN` (i.e. any shape
 * `chooseBodySentinel` could ever produce). This is a structural guard, not a
 * label-specific patch: it fires regardless of which field produced the offending
 * line, so it also protects a pre-fix/externally-authored record whose on-disk
 * `label` was never sanitized (root-cause fix (a) only cleans labels going through
 * a Station-driven write; it cannot retroactively clean bytes already on disk).
 * Should never fire in ordinary operation now that (a) sanitizes every label at the
 * write boundary — a warning is logged if it ever does, since that means some other
 * free-text field independently reproduced the same shape.
 */
function neutralizeSentinelShapedLines(
  text: string,
  context: { id: string; section: string },
): string {
  return text
    .split('\n')
    .map((line) => {
      if (!SENTINEL_SHAPE_PATTERN.test(line)) return line;
      logger.warn(
        'a rendered line inside a generated section coincidentally matched this ' +
          "adapter's sentinel shape (SENTINEL_SHAPE_PATTERN); wrapping it in " +
          'backticks so it can never be mistaken for the real structural body/' +
          'sentinel boundary on read (defense-in-depth, H1 fix, Wave-2 code review ' +
          'iteration 4)',
        { id: context.id, section: context.section, line },
      );
      return `\`${line}\``;
    })
    .join('\n');
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find the character offset where the LAST occurrence of `sentinel`, appearing as an
 * entire line by itself (not merely as a substring somewhere inside a longer line),
 * starts within `renderedText`. Returns -1 if no such line-exact occurrence exists.
 *
 * Anchoring to the LAST line-exact match (rather than the FIRST substring match,
 * `String.prototype.indexOf`'s behavior) is what makes a human-pasted copy of the
 * sentinel inside the body inert (M2 fix, Wave-2 code review iteration 2):
 * `renderObsidianBody` always writes the real, chosen sentinel as its own line
 * immediately after the complete, unmodified body text — any generated Sources/People/
 * Related sections come strictly AFTER it — so the real sentinel line is always the
 * physically LAST line-exact match in a file this adapter wrote or subsequently
 * rewrote, regardless of what a human pastes earlier in the body. A bare substring
 * match embedded mid-line (e.g. inside a sentence) never matches at all here, which is
 * an intentional, additional safety margin beyond the H1 write-side pigeonhole scheme.
 */
function findLastSentinelLineIndex(
  renderedText: string,
  sentinel: string,
): number {
  const pattern = new RegExp(
    `(?:^|\\n)(${escapeForRegExp(sentinel)})(?=\\n|$)`,
    'g',
  );
  let lastIndex = -1;
  let match: RegExpExecArray | null = pattern.exec(renderedText);
  while (match !== null) {
    lastIndex = match.index + (match[0].length - match[1].length);
    match = pattern.exec(renderedText);
  }
  return lastIndex;
}

interface SectionLinkGroups {
  sourceLinks: KitLink[];
  appearsInLinks: KitLink[];
  peopleLinks: KitLink[];
  relatedLinks: KitLink[];
}

/**
 * Partition a record's `links` by the generated-section kind they feed
 * (`renderObsidianBody` and `generatedSectionHeadingAvailability` both call this, so
 * the two can never drift apart on what counts as "this record has a Sources/
 * Appears-In/People/Related section" — a shared single source of truth rather than
 * two independently-maintained copies of the same filter logic).
 */
function partitionLinksForGeneratedSections(
  links: KitLink[] | undefined,
): SectionLinkGroups {
  const list = Array.isArray(links) ? links : [];
  return {
    sourceLinks: list.filter((l) => l.kind === 'source'),
    appearsInLinks: list.filter((l) => l.kind === 'appears-in'),
    peopleLinks: list.filter((l) => l.kind === 'person'),
    relatedLinks: list.filter(
      (l) => l.kind === 'related' || l.kind === 'refines',
    ),
  };
}

/**
 * For a given record (type + links), determine which of the four
 * `KNOWN_TRAILING_SECTION_PREFIXES` headings Station would ACTUALLY generate for it
 * right now — i.e. the exact conditions `renderObsidianBody` below uses to decide
 * whether to emit each section. Used by `extractUnrecognizedTrailingContent` (M1 fix,
 * Wave-2 code review iteration 4) so that heading TEXT alone is never treated as
 * proof of adapter authorship: a chunk that merely starts with `## Sources` but whose
 * record carries no `source`-kind link could never have been generated by Station,
 * so it must be hand-authored content that happens to share a heading name.
 */
function generatedSectionHeadingAvailability(
  type: KitRecordType,
  links: KitLink[] | undefined,
): Record<string, boolean> {
  const { sourceLinks, appearsInLinks, peopleLinks, relatedLinks } =
    partitionLinksForGeneratedSections(links);
  return {
    '## Sources': sourceLinks.length > 0,
    '## Appears In': type === 'person' && appearsInLinks.length > 0,
    '## People': peopleLinks.length > 0,
    '## Related': relatedLinks.length > 0,
  };
}

/**
 * `renderObsidianBody` follows the sentinel line with either nothing, or one or more of
 * exactly the four `KNOWN_TRAILING_SECTION_PREFIXES` sections, each starting with its
 * heading verbatim and separated by a blank line — safe to discard on read ONLY when
 * Station would actually generate that specific section for this record's current
 * links (`availability`, from `generatedSectionHeadingAvailability`), because such
 * content is recomputed from `graph-index.json` on every Station-driven write, never
 * hand-authored data. A chunk whose heading text matches one of the four prefixes but
 * whose corresponding `availability` entry is `false` is NOT safe to discard — Station
 * could never have generated it for this record, so it must be hand-authored content
 * that merely looks like adapter output (M1 fix, Wave-2 code review iteration 4: never
 * discard silently — this case now logs a warning, matching every other lossy branch
 * in this read path). Anything else found after the sentinel — a human directly
 * editing the file below the delimiter, per this adapter's own "browse as a normal
 * Obsidian vault" invitation — is NOT a recognized-and-available shape and would
 * otherwise be silently discarded the next time Station rewrites the file. Returns
 * the unrecognized remainder (trimmed), or `''` if the trailing content is empty or
 * fully accounted for by sections Station would actually generate.
 */
function extractUnrecognizedTrailingContent(
  trailing: string,
  id: string,
  availability: Record<string, boolean>,
): string {
  const trimmed = trailing.replace(/^\n+/, '');
  if (!trimmed.trim()) return '';
  const chunks = trimmed.split(/\n\n(?=## )/);
  const unrecognized: string[] = [];
  for (const chunk of chunks) {
    const matchedPrefix = KNOWN_TRAILING_SECTION_PREFIXES.find((prefix) =>
      chunk.startsWith(prefix),
    );
    if (matchedPrefix && availability[matchedPrefix]) {
      // Station would generate this exact section for this record's current links —
      // safe to discard silently, recomputed from graph-index.json on every
      // Station-driven write, never hand-authored data.
      continue;
    }
    if (matchedPrefix) {
      // Heading TEXT matches a generated-section heading, but Station would NOT
      // actually generate that section for this record (no links of the
      // corresponding kind right now) — treat as hand-authored content that merely
      // looks like adapter output; never discard silently (M1 fix, Wave-2 code
      // review iteration 4).
      logger.warn(
        'record has a hand-authored heading matching a generated-section prefix, ' +
          'but Station would not generate that section for this record right now ' +
          '(no matching links) — preserving it into the body instead of discarding',
        { id, heading: matchedPrefix },
      );
    }
    unrecognized.push(chunk);
  }
  return unrecognized.join('\n\n').trimEnd();
}

export interface PathIndexEntry {
  path: string;
  archived: boolean;
}

export interface PathIndex {
  by_id: Record<string, PathIndexEntry>;
  by_path: Record<string, string>;
}

function emptyPathIndex(): PathIndex {
  return { by_id: {}, by_path: {} };
}

export function assertPathIndex(value: unknown, source: string): PathIndex {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${source}: path index must be an object`);
  }
  const index = value as Partial<PathIndex>;
  if (
    !index.by_id ||
    typeof index.by_id !== 'object' ||
    Array.isArray(index.by_id) ||
    !index.by_path ||
    typeof index.by_path !== 'object' ||
    Array.isArray(index.by_path)
  ) {
    throw new Error(`${source}: path index has an unsupported shape`);
  }
  for (const [id, entry] of Object.entries(index.by_id)) {
    const normalized = resolve('/', entry?.path ?? '');
    if (
      !id ||
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.path !== 'string' ||
      isAbsolute(entry.path) ||
      normalized === '/' ||
      normalized.startsWith('/../') ||
      entry.path.split(/[\\/]/).includes('..') ||
      typeof entry.archived !== 'boolean' ||
      index.by_path[entry.path] !== id
    ) {
      throw new Error(`${source}: path index contains an invalid entry`);
    }
  }
  for (const [path, id] of Object.entries(index.by_path)) {
    if (!path || !id || index.by_id[id]?.path !== path) {
      throw new Error(`${source}: path index reverse mapping is inconsistent`);
    }
  }
  return index as PathIndex;
}

export interface KitObsidianStoreOptions extends StoreOptions {
  /** Subfolder name for raw/compiled (source-level) records under each category. Default "sources". */
  sourcesDir?: string;
  /** Names for category segments after the domain, written as vault frontmatter only. */
  dimensions?: readonly string[];
}

const RESERVED_DIMENSIONS = new Set([
  'id', 'type', 'title', 'body', 'category', 'tags', 'aliases', 'links', 'provenance',
  'created_at', 'updated_at', 'expires_at', 'ttl_seconds', 'status', 'mutation_log',
  '_body_sentinel', '__proto__', 'constructor', 'prototype',
]);

/** The canonical vault path index. */
export const PATH_INDEX_FILE = 'path-index.json';
/**
 * The Knowledge Kit's vault path index (`kit-v1`): same payload, different name.
 * A vault that has only this file opens read-only; `corpus-store migrate`
 * converts it to the canonical index.
 */
export const KIT_V1_PATH_INDEX_FILE = '.graph-index.json';
/** Derived indexes whose presence proves records were written here. */
const DERIVED_INDEX_FILES = ['graph-index.json', 'alias-index.json'];

/** Stands in for the id `create` will generate when sizing a proposal's candidate. */
const PLACEHOLDER_RECORD_ID = '00000000-0000-0000-0000-000000000000';
const PLACEHOLDER_TIMESTAMP = '1970-01-01T00:00:00.000Z';
const CREATE_IDENTITY_MAX_ENTRIES = 10_000;
/**
 * The largest serialized note the vault accepts. Every identity scan and destination check
 * reads a note with this bound, so a larger note would make each later `create` fail.
 * `create`, `proposeCreate` and `applyCreate` refuse a record that would exceed it.
 */
export const VAULT_NOTE_MAX_BYTES = 16 * 1024 * 1024;
const CREATE_IDENTITY_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/**
 * Tombstones live here, under `archive/` so the path index keeps its rule that an
 * archived entry sits in an `archive/` location. The filename is derived from the
 * id, never from the title, so the erased title does not survive in a path, the
 * path index or a `[[wikilink]]`.
 */
const TOMBSTONE_DIR = 'archive/purged';

export class KitObsidianStoreAdapter implements KnowledgeStoreAdapter, KnowledgeStoreCreateProposals, KnowledgeStorePurger {
  private readonly services: ResolvedServices;
  private readonly root: string;
  private readonly binding: string | undefined;
  private readonly sourcesDir: string;
  private readonly dimensions: readonly string[];
  private readonly graphPath: string;
  private readonly pathIndexPath: string;
  private readonly kitV1PathIndexPath: string;
  private readonly aliasPath: string;
  private readonly files: KnowledgeFileTransactions;
  private readonly proposals: CreateProposals;

  constructor(options: KitObsidianStoreOptions) {
    if (!options?.storeRoot) throw new Error('storeRoot is required');
    this.services = resolveServices(options);
    this.root = resolve(options.storeRoot);
    this.sourcesDir = options.sourcesDir || 'sources';
    const dimensions = options.dimensions ?? [];
    if (!Array.isArray(dimensions) || new Set(dimensions).size !== dimensions.length
      || dimensions.some((name) => typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || RESERVED_DIMENSIONS.has(name))) {
      throw new MissingEvidenceError('vault dimensions must be unique identifier names that do not replace record fields');
    }
    this.dimensions = [...dimensions];
    this.graphPath = join(this.root, 'graph-index.json');
    this.pathIndexPath = join(this.root, PATH_INDEX_FILE);
    this.kitV1PathIndexPath = join(this.root, KIT_V1_PATH_INDEX_FILE);
    this.aliasPath = join(this.root, 'alias-index.json');
    const newRoot = !existsSync(this.root);
    mkdirSync(this.root, { recursive: true });
    if (newRoot) scaffoldNewRootIdentity(this.root);
    try { this.binding = captureRootBinding(this.root); }
    catch { /* An unreadable marker leaves the adapter unbound; records remain readable. */ }
    this.files = new KnowledgeFileTransactions(this.root, {}, this.services);
    Object.defineProperty(this, "files", { enumerable: false });
    this.proposals = new CreateProposals(this.files, this.root, this.services);
    Object.defineProperty(this, "proposals", { enumerable: false });
  }

  rootBinding(): string { if (!this.binding) throw new RootBindingMismatchError(); return this.binding; }

  // ── Internal: path index (id -> {path, archived}) ─────────────────────────

  /**
   * Selects the vault's path index. `path-index.json` is canonical. A vault with
   * only the Knowledge Kit's `.graph-index.json` (`kit-v1`) is read with it and
   * refuses writes. Both files at once is a conflict, and an occupied vault with
   * neither is refused rather than read as empty: either would silently hide
   * records.
   */
  private readPathIndexSource(): { raw: string | null; path: string; format: 'path-index' | 'kit-v1' } {
    const canonical = this.files.readText(this.pathIndexPath);
    const kitV1 = this.files.readText(this.kitV1PathIndexPath);
    if (canonical !== null && kitV1 !== null) {
      throw new KnowledgeStoreCorruptionError(
        `vault has both ${PATH_INDEX_FILE} and ${KIT_V1_PATH_INDEX_FILE}; refusing to choose one. Resolve it with corpus-store migrate.`,
      );
    }
    if (canonical !== null) return { raw: canonical, path: this.pathIndexPath, format: 'path-index' };
    if (kitV1 !== null) return { raw: kitV1, path: this.kitV1PathIndexPath, format: 'kit-v1' };
    if (this.occupiedWithoutIndex()) {
      throw new KnowledgeStoreCorruptionError(
        `vault holds records but has no ${PATH_INDEX_FILE}; refusing to open it as empty. Convert a Knowledge Kit vault with corpus-store migrate.`,
      );
    }
    return { raw: null, path: this.pathIndexPath, format: 'path-index' };
  }

  /**
   * A proposal file: `<root>/.corpus-proposals/*.json`. Their number is unbounded and they
   * are not records, so the record-identity scans neither count nor read them. Anything
   * else under that directory, such as a note, is still scanned.
   */
  private isProposalFile(directory: string, entry: { name: string; kind: string }): boolean {
    return (
      entry.kind === 'file' &&
      entry.name.endsWith('.json') &&
      directory === join(this.root, PROPOSALS_DIRECTORY)
    );
  }

  /**
   * True when the root already holds store data: a derived index, or a markdown
   * note whose frontmatter has an `id` or a `type`. Plain notes do not count.
   * Unreadable frontmatter or an exceeded bound counts as occupied (fail closed).
   */
  private occupiedWithoutIndex(): boolean {
    if (DERIVED_INDEX_FILES.some((name) => this.files.readText(join(this.root, name)) !== null)) {
      return true;
    }
    const directories = [this.root];
    let entries = 0;
    let remainingBytes = CREATE_IDENTITY_MAX_TOTAL_BYTES;
    while (directories.length > 0) {
      const directory = directories.pop()!;
      for (const entry of this.files.listDirectoryEntries(directory)) {
        if (this.isProposalFile(directory, entry)) continue;
        if (++entries > CREATE_IDENTITY_MAX_ENTRIES) return true;
        const path = join(directory, entry.name);
        if (entry.kind === 'directory') {
          directories.push(path);
          continue;
        }
        if (!entry.name.toLowerCase().endsWith('.md')) continue;
        const text = this.files.readText(path, Math.min(VAULT_NOTE_MAX_BYTES, remainingBytes));
        if (text === null) return true;
        remainingBytes -= Buffer.byteLength(text);
        if (remainingBytes < 0) return true;
        if (!/^(?:\uFEFF)?---\r?\n/.test(text)) continue;
        try {
          const { meta } = parseMarkdown(text, { maxDepth: 32, maxAliases: 50, maxTotalMergeKeys: 1000 });
          if (meta.id !== undefined || meta.type !== undefined) return true;
        } catch {
          return true;
        }
      }
    }
    return false;
  }

  private loadPathIndex(): PathIndex {
    const source = this.readPathIndexSource();
    if (source.raw === null) return emptyPathIndex();
    try {
      return assertPathIndex(JSON.parse(source.raw), source.path);
    } catch (error) {
      throw new KnowledgeStoreCorruptionError(
        `${basename(source.path)} is corrupt; refusing to mutate the vault`,
        {
          cause: error,
        },
      );
    }
  }

  /** Every mutation runs here, so a `kit-v1` vault refuses writes before any I/O. */
  private mutate<T>(
    operation: string,
    body: () => T,
    options: { erasure?: boolean } = {},
  ): Promise<T> {
    return this.files.mutate(operation, () => {
      if (this.readPathIndexSource().format === 'kit-v1') {
        throw new ReadOnlyStoreError(
          operation,
          `this vault uses the Knowledge Kit index ${KIT_V1_PATH_INDEX_FILE} and opens read-only; convert it with corpus-store migrate.`,
        );
      }
      return body();
    }, options);
  }

  private savePathIndex(index: PathIndex): void {
    this.files.writeText(
      this.pathIndexPath,
      `${JSON.stringify(index, null, 2)}\n`,
    );
  }

  /**
   * A path-index entry is local metadata but may be tampered with — never feed an
   * indexed path to `fs`/`path` helpers without this containment check.
   */
  private resolveStorePath(relPath: string): string {
    if (typeof relPath !== 'string' || !relPath) {
      throw new Error('Invalid store path in path index');
    }
    if (isAbsolute(relPath)) {
      throw new Error(`Path index entry escapes store root: ${relPath}`);
    }
    const absPath = resolve(this.root, relPath);
    const relativeToRoot = relative(this.root, absPath);
    if (
      relativeToRoot === '..' ||
      relativeToRoot.startsWith(`..${sep}`) ||
      isAbsolute(relativeToRoot)
    ) {
      throw new Error(`Path index entry escapes store root: ${relPath}`);
    }
    return absPath;
  }

  // ── Internal: slug / path routing (Addendum C.3) ───────────────────────────

  private slugify(title: string): string {
    return (
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'untitled'
    );
  }

  /**
   * Person records land in a top-level `people/` folder regardless of category
   * (Addendum C.3 — cross-cutting entities). Insight records (concept, snapshot) live
   * at the category node root; source-level records (raw, compiled) nest one level
   * down in `sourcesDir`. Filename collisions (same slug, different id) get a numeric
   * suffix.
   */
  private computeRelPath(
    category: string,
    title: string,
    id: string,
    type: KitRecordType,
    pathIndex: PathIndex,
  ): string {
    let catDir: string;
    if (type === 'person') {
      catDir = 'people';
    } else {
      catDir = category.replace(/\./g, '/');
      if (type === 'raw' || type === 'compiled') {
        catDir = `${catDir}/${this.sourcesDir}`;
      }
    }
    const baseSlug = this.slugify(title);
    let slug = baseSlug;
    let suffix = 2;
    while (true) {
      const relPath = `${catDir}/${slug}.md`;
      const existingId = pathIndex.by_path[relPath];
      if (!existingId) {
        if (
          this.files.readText(
            this.resolveStorePath(relPath),
            VAULT_NOTE_MAX_BYTES,
          ) !== null
        )
          throw new KnowledgeStoreCorruptionError(
            'Obsidian destination is occupied by an unindexed file',
          );
        return relPath;
      }
      if (existingId === id) return relPath;
      slug = `${baseSlug}-${suffix++}`;
    }
  }

  // ── Internal: record I/O ────────────────────────────────────────────────

  private getAbsPath(id: string, pathIndex: PathIndex): string | null {
    const entry = pathIndex.by_id[id];
    if (!entry) return null;
    return this.resolveStorePath(entry.path);
  }

  private readRecord(id: string, pathIndex: PathIndex): KitRecord | null {
    const absPath = this.getAbsPath(id, pathIndex);
    if (!absPath) return null;
    const text = this.files.readText(absPath);
    if (text === null)
      throw new KnowledgeStoreCorruptionError(
        'Obsidian path index names a missing record',
      );
    let meta: Record<string, unknown>;
    let renderedText: string;
    try {
      ({ meta, body: renderedText } = parseMarkdown(text));
    } catch (error) {
      throw new KnowledgeStoreCorruptionError(`${absPath}: record is corrupt`, {
        cause: error,
      });
    }
    if (!meta.id)
      throw new KnowledgeStoreCorruptionError(
        'Indexed Obsidian record has no id',
      );

    const rawSentinelValue = meta[BODY_SENTINEL_FRONTMATTER_KEY];
    let sentinel = BODY_END_SENTINEL_BASE;
    if (typeof rawSentinelValue === 'string') {
      if (SENTINEL_SHAPE_PATTERN.test(rawSentinelValue)) {
        sentinel = rawSentinelValue;
      } else {
        // Reserved-key edge case (M1, Wave-2 code review iteration 2): a user's own,
        // unrelated `_body_sentinel` frontmatter value doesn't look adapter-generated —
        // never trust it as a delimiter (it would either crash nothing today, since
        // `indexOf`/line-matching just fail to find it, but could silently misbehave on
        // a future format change), fall back to the default sentinel under the same
        // last-occurrence resolution, and warn so the collision is visible.
        logger.warn(
          'record has a malformed _body_sentinel frontmatter value (reserved key; ' +
            'does not look adapter-generated) — falling back to the default sentinel ' +
            'and last-occurrence resolution',
          { id, path: absPath },
        );
      }
    }

    // A tombstone's note has no body to parse; whatever follows its frontmatter is
    // not read, so a hand-edited tombstone cannot serve content.
    const availability = generatedSectionHeadingAvailability(
      meta.type as KitRecordType,
      meta.links as KitLink[] | undefined,
    );
    const body =
      meta.status === 'purged'
        ? ''
        : this.parseBodyFromRendered(
            id,
            meta.type as KitRecordType,
            renderedText,
            sentinel,
            availability,
          );

    // Strip the bookkeeping key before returning — mirrors the destructuring
    // `writeRecord` already does on the write side, so it never leaks onto the public
    // `KitRecord` returned by `get()`/`listByType()`/`listByCategory()` (M1 fix, Wave-2
    // code review iteration 2).
    const { [BODY_SENTINEL_FRONTMATTER_KEY]: _sentinelKey, ...publicMeta } =
      meta as Record<string, unknown>;
    for (const name of this.dimensions) delete publicMeta[name];

    const record = assertKitRecord(publicMeta, body, absPath);
    if (record.id !== id) {
      throw new KnowledgeStoreCorruptionError(
        `${absPath}: record id does not match its path-index identity`,
      );
    }
    return record;
  }

  /**
   * Write a record to disk. On first write: computes the slug path and registers it
   * in the path index. On a title/category change to an ACTIVE record: moves the file
   * (old path removed, new path used) — an archived record's write always stays at its
   * archive path (supersede-not-delete never resurrects the pre-archive location).
   * Caller owns `pathIndex` persistence (`savePathIndex`) — this method mutates the
   * in-memory index but does not save it, so a caller writing multiple records in one
   * op (e.g. `supersede`) persists the index once at the end.
   */
  private writeRecord(
    rawRecord: KitRecord,
    pathIndex: PathIndex,
    options: { enforceNoteBound?: string } = {},
  ): void {
    // Unconditionally sanitize `links` on the single write path every
    // mutation funnels through — closes the gap the Wave-2 code review
    // named: label sanitization previously only happened inside
    // `appendUniqueLinks` (create/update-with-links/link/supersede's
    // new-record merge), so a metadata-only mutation (retire, a tags-only
    // update, apply/reject/propose's untouched-links spreads) would carry
    // forward an already-bad, legacy/externally-authored `KitLink.label` on
    // disk indefinitely — never actually cleaned up at rest, only ever
    // neutralized at render time by `neutralizeSentinelShapedLines` below
    // (which stays in place as defense-in-depth; this closes the
    // persistence half of the gap, ending the same warning re-firing on
    // every future write to that record). Idempotent/harmless for
    // already-sanitized links (no re-warn) per `sanitizeLinks`'s own
    // contract.
    const record: KitRecord = rawRecord.links
      ? { ...rawRecord, links: sanitizeLinks(rawRecord.links) }
      : rawRecord;

    const existingEntry = pathIndex.by_id[record.id];
    let targetRelPath: string;

    if (existingEntry?.archived) {
      targetRelPath = existingEntry.path;
    } else if (existingEntry) {
      const newRelPath = this.computeRelPath(
        record.category,
        record.title,
        record.id,
        record.type,
        pathIndex,
      );
      if (newRelPath !== existingEntry.path) {
        const oldAbs = this.resolveStorePath(existingEntry.path);
        this.files.remove(oldAbs);
        delete pathIndex.by_path[existingEntry.path];
        pathIndex.by_id[record.id] = { path: newRelPath, archived: false };
        pathIndex.by_path[newRelPath] = record.id;
        targetRelPath = newRelPath;
      } else {
        targetRelPath = existingEntry.path;
      }
    } else {
      const newRelPath = this.computeRelPath(
        record.category,
        record.title,
        record.id,
        record.type,
        pathIndex,
      );
      pathIndex.by_id[record.id] = { path: newRelPath, archived: false };
      pathIndex.by_path[newRelPath] = record.id;
      targetRelPath = newRelPath;
    }

    const text = this.renderNote(record, pathIndex);
    // A new record has nothing on disk yet, so a refusal here leaves nothing written.
    if (options.enforceNoteBound) this.assertNoteFits(text, options.enforceNoteBound);

    const absPath = this.resolveStorePath(targetRelPath);
    this.files.writeText(absPath, text);
  }

  /** The note's exact bytes: frontmatter plus the rendered body. */
  private renderNote(record: KitRecord, pathIndex: PathIndex): string {
    const {
      body: _body,
      [BODY_SENTINEL_FRONTMATTER_KEY]: _staleSentinel,
      ...frontmatterFields
    } = record as unknown as Record<string, unknown>;
    if (record.status === 'purged') {
      // No body, no generated link sections and no category dimensions: only the
      // frontmatter a tombstone keeps.
      return serializeMarkdown(frontmatterFields, '');
    }
    const segments = record.category.split('.').slice(1);
    this.dimensions.forEach((name, index) => {
      delete frontmatterFields[name];
      if (segments[index] !== undefined) frontmatterFields[name] = segments[index];
    });
    const { text: obsidianBody, sentinel } = this.renderObsidianBody(
      record,
      pathIndex,
    );
    if (sentinel !== BODY_END_SENTINEL_BASE) {
      frontmatterFields[BODY_SENTINEL_FRONTMATTER_KEY] = sentinel;
    }
    return serializeMarkdown(
      frontmatterFields as Record<string, unknown>,
      obsidianBody,
    );
  }

  /** A note over {@link VAULT_NOTE_MAX_BYTES} would make every later identity scan fail. */
  private assertNoteFits(text: string, operation: string): void {
    const bytes = Buffer.byteLength(text);
    if (bytes > VAULT_NOTE_MAX_BYTES) {
      throw new MissingEvidenceError(
        `${operation}: the record serializes to a ${bytes}-byte note, but vault notes are limited to ${VAULT_NOTE_MAX_BYTES} bytes`,
      );
    }
  }

  /** Move an active record to `archive/` (supersede-not-delete invariant, A.5). */
  private archiveRecord(id: string, pathIndex: PathIndex): void {
    const entry = pathIndex.by_id[id];
    if (!entry || entry.archived) return;

    const archiveRelPath = `archive/${entry.path}`;
    const archiveAbs = this.resolveStorePath(archiveRelPath);

    const currentAbs = this.resolveStorePath(entry.path);
    this.files.move(currentAbs, archiveAbs);

    delete pathIndex.by_path[entry.path];
    pathIndex.by_id[id] = { path: archiveRelPath, archived: true };
    pathIndex.by_path[archiveRelPath] = id;
  }

  // ── Internal: Obsidian body render / parse (must be an exact inverse) ─────

  private parseBodyFromRendered(
    id: string,
    type: KitRecordType,
    renderedText: string,
    sentinel: string,
    availability: Record<string, boolean>,
  ): string {
    const sentinelIdx = findLastSentinelLineIndex(renderedText, sentinel);

    let bodySection: string;
    let extra = '';
    if (sentinelIdx === -1) {
      // External-edit case: the trailing sentinel line was deleted entirely (M2 fix,
      // Wave-2 code review iteration 2). Read to EOF rather than truncating to
      // nothing/guessing, warn so the gap is visible, and rely on the next
      // Station-driven write to self-heal (writeRecord always recomputes and
      // re-appends a fresh sentinel unconditionally).
      logger.warn(
        'record body is missing its structural sentinel line (likely deleted by an ' +
          'external edit); reading to end-of-file instead of truncating; a fresh ' +
          'sentinel will be written on the next Station-driven write',
        { id, sentinel },
      );
      bodySection = renderedText;
    } else {
      bodySection = renderedText.slice(0, sentinelIdx);
      const trailing = renderedText.slice(sentinelIdx + sentinel.length);
      extra = extractUnrecognizedTrailingContent(trailing, id, availability);
      if (extra) {
        // External-edit case: content was hand-added after the real sentinel line that
        // isn't one of the recognized generated sections (M2 fix, Wave-2 code review
        // iteration 2). Data-preserving choice: merge it back into the body on read
        // rather than silently dropping it the next time Station regenerates the
        // Sources/People/Related sections from graph-index.json.
        logger.warn(
          'record has unrecognized content after its structural sentinel (likely ' +
            'added by an external edit); merging it back into the body on read so it ' +
            'is not lost on the next Station-driven write',
          { id },
        );
      }
    }

    let body: string;
    if (type === 'raw') {
      const lines = bodySection.split('\n');
      const bodyLines: string[] = [];
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('> ')) {
          bodyLines.push(line.slice(2));
        } else if (line === '>') {
          bodyLines.push('');
        } else {
          break;
        }
      }
      body = bodyLines.join('\n');
    } else {
      body = bodySection.trimEnd();
    }

    return extra ? `${body}\n\n${extra}` : body;
  }

  private idToFilename(id: string, pathIndex: PathIndex): string {
    const entry = pathIndex.by_id[id];
    if (!entry) return id;
    return basename(this.resolveStorePath(entry.path), '.md');
  }

  private renderObsidianBody(
    record: KitRecord,
    pathIndex: PathIndex,
  ): { text: string; sentinel: string } {
    const { sourceLinks, appearsInLinks, peopleLinks, relatedLinks } =
      partitionLinksForGeneratedSections(record.links);

    const wikiLinks = (linkList: KitLink[]): string =>
      linkList
        .map((l) => {
          if (!l.target_id) return null;
          const slug = this.idToFilename(l.target_id, pathIndex);
          if (!slug) return null;
          return l.label ? `[[${slug}|${l.label}]]` : `[[${slug}]]`;
        })
        .filter((v): v is string => Boolean(v))
        .join(', ');

    // Build a generated section's text and immediately neutralize any line inside it
    // that coincidentally matches the sentinel's shape (H1 fix, Wave-2 code review
    // iteration 4, "(b)" defense-in-depth — see `neutralizeSentinelShapedLines`).
    // Root-cause fix "(a)" (`sanitizeLinks` in shared/wikilinks.ts) means a
    // Station-sanitized `label` can never by itself produce this on a fresh write —
    // this guard exists for any OTHER free-text field that might one day render into
    // a generated section, and for pre-fix/externally-authored records whose on-disk
    // `label` predates the write-side sanitization.
    const renderSection = (heading: string, linkList: KitLink[]): string =>
      neutralizeSentinelShapedLines(`${heading}\n\n${wikiLinks(linkList)}`, {
        id: record.id,
        section: heading,
      });

    let bodyPart: string;
    if (record.type === 'raw') {
      bodyPart = `${RAW_CALLOUT_HEADER}\n> ${record.body.replace(/\n/g, '\n> ')}`;
    } else {
      bodyPart = record.body;
    }

    // Collision-proof: the sentinel is chosen against the FULLY RENDERED bodyPart
    // (post raw-callout-quoting, if any) — not the raw `record.body` — so a
    // collision hiding behind the `"> "` quoting prefix is caught too (H1 fix).
    const sentinel = chooseBodySentinel(bodyPart);
    const parts = [`${bodyPart}\n${sentinel}`];

    if (sourceLinks.length > 0) {
      parts.push(renderSection('## Sources', sourceLinks));
    }
    if (record.type === 'person' && appearsInLinks.length > 0) {
      parts.push(renderSection('## Appears In', appearsInLinks));
    }
    if (peopleLinks.length > 0) {
      parts.push(renderSection('## People', peopleLinks));
    }
    if (relatedLinks.length > 0) {
      parts.push(renderSection('## Related', relatedLinks));
    }

    return { text: parts.join('\n\n'), sentinel };
  }

  /**
   * Every active (non-archived) record and every tombstone, for `reindex()`, so a
   * tombstone keeps its links in the graph. Other archived records remain
   * `get`/`getLinks`-able; lists reach them only with `includeHistory` (see
   * `listed`).
   */
  private allRecords(pathIndex: PathIndex): KitRecord[] {
    const records: KitRecord[] = [];
    for (const [id, entry] of Object.entries(pathIndex.by_id)) {
      if (entry.archived && !entry.path.startsWith(`${TOMBSTONE_DIR}/`)) continue;
      const record = this.readRecord(id, pathIndex);
      if (record) records.push(record);
    }
    return records;
  }

  // ── Internal: graph + alias index ──────────────────────────────────────

  private loadGraph(): GraphIndex {
    const raw = this.files.readText(this.graphPath);
    if (raw === null) return emptyGraph();
    try {
      return assertGraphIndex(JSON.parse(raw), this.graphPath);
    } catch (error) {
      if (error instanceof KnowledgeStoreCorruptionError) throw error;
      throw new KnowledgeStoreCorruptionError(
        `${this.graphPath}: graph index is corrupt`,
        { cause: error },
      );
    }
  }

  private loadGraphForReindex(): GraphIndex {
    try {
      return this.loadGraph();
    } catch (error) {
      if (!(error instanceof KnowledgeStoreCorruptionError)) throw error;
      logger.warn(
        'graph-index.json is corrupt; explicit reindex will rebuild it from authoritative records',
        { path: this.graphPath, error },
      );
      return emptyGraph();
    }
  }

  private saveGraph(graph: GraphIndex): void {
    this.files.writeText(this.graphPath, `${JSON.stringify(graph, null, 2)}\n`);
  }

  private loadAliasIndex(): AliasIndex {
    const raw = this.files.readText(this.aliasPath);
    if (raw === null) return emptyAliasIndex();
    try {
      return assertAliasIndex(JSON.parse(raw), this.aliasPath);
    } catch (error) {
      if (error instanceof KnowledgeStoreCorruptionError) throw error;
      throw new KnowledgeStoreCorruptionError(
        `${this.aliasPath}: alias index is corrupt`,
        { cause: error },
      );
    }
  }

  private saveAliasIndex(index: AliasIndex): void {
    this.files.writeText(this.aliasPath, `${JSON.stringify(index, null, 2)}\n`);
  }

  private resolveId(
    input: string,
    pathIndex?: PathIndex,
    aliasIndex?: AliasIndex,
  ): string | null {
    const idx = pathIndex ?? this.loadPathIndex();
    const aliases = aliasIndex ?? this.loadAliasIndex();
    return resolveRecordId(input, {
      idExists: (rid) => Boolean(idx.by_id[rid]),
      listIds: () => Object.keys(idx.by_id),
      bySlug: aliases.by_slug,
    });
  }

  /**
   * Rebuild the link graph + alias index from every currently-ACTIVE (non-archived)
   * record's own `links`/`aliases` (§5.2, Addendum H.5). Named, accepted limitation
   * (matches the Kit's own reference Obsidian adapter's equivalent behavior): a
   * superseded record's own outbound links are not replayed by `reindex()` because
   * archived records are excluded from the scan — this is safe for the graph's
   * *reverse* `supersedes` edges (those live on the still-active superseding record),
   * but an archived record's other, unrelated outbound links would not survive a
   * from-scratch `reindex()` after `graph-index.json` is lost. Out of scope for K2;
   * flagged here for whichever future wave (K3+) needs archive-aware reindexing.
   */
  async reindex(): Promise<ReindexResult> {
    return this.mutate('reindex', () => this.reindexLocked());
  }

  private reindexLocked(): ReindexResult {
    const pathIndex = this.loadPathIndex();
    const records = this.allRecords(pathIndex).sort((a, b) =>
      a.id.localeCompare(b.id),
    );

    const rebuiltGraph = emptyGraph();
    for (const record of records) {
      addLinksToGraph(
        rebuiltGraph,
        record.id,
        Array.isArray(record.links) ? record.links : [],
      );
    }
    const links = Object.values(rebuiltGraph.forward).reduce(
      (n, arr) => n + arr.length,
      0,
    );
    const changed =
      canonicalGraph(this.loadGraphForReindex()) !==
      canonicalGraph(rebuiltGraph);
    this.saveGraph(rebuiltGraph);

    const rebuiltAliases = emptyAliasIndex();
    for (const record of records) {
      const slugs = normalizeAliases(record.aliases);
      if (slugs.length) registerAliases(rebuiltAliases, record.id, slugs);
    }
    this.saveAliasIndex(rebuiltAliases);
    // Derived indexes with no path index read as an occupied vault with a lost index.
    // A vault with no records has none yet, so write the empty one beside them.
    if (this.files.readText(this.pathIndexPath) === null) this.savePathIndex(pathIndex);

    return {
      records: records.length,
      links,
      forwardSources: Object.keys(rebuiltGraph.forward).length,
      reverseTargets: Object.keys(rebuiltGraph.reverse).length,
      changed,
    };
  }

  // ── create (§6.1) ──────────────────────────────────────────────────────

  async create(input: CreateInput): Promise<string> {
    return this.mutate('create', () => this.createLocked(input));
  }

  private createLocked(
    input: CreateInput,
    origin?: (at: string) => KitMutationLogEntry,
  ): string {
    const sourceRefs = assertCreateFields(input, 'create');

    const id = input.id || this.services.ids();
    const pathIndex = this.loadPathIndex();
    if (this.readRecord(id, pathIndex)) {
      throw new MissingEvidenceError('create: record id already exists');
    }
    this.assertCreateIdentityAvailable(id, pathIndex);
    const now = new Date(this.services.clock()).toISOString();

    const aliases = normalizeAliases(input.aliases);
    let aliasIndex: AliasIndex | null = null;
    if (aliases.length) {
      aliasIndex = this.loadAliasIndex();
      registerAliases(aliasIndex, id, aliases);
    }

    const fresh = freshnessPatch(input);

    const explicitLinks = input.links ?? [];
    const wikilinks = extractWikilinks(input.body);
    const links = mergeLinks(explicitLinks, wikilinks);
    const lookup = (target: string) => this.readRecord(target, pathIndex);
    assertNoPurgedSupport('create', links, input.provenance.source_ids, lookup);
    assertCompiledSource(input.type, links, lookup);

    const record = this.newRecord(input, id, now, aliases, links, fresh, sourceRefs, origin);

    this.writeRecord(record, pathIndex, { enforceNoteBound: 'create' });
    this.savePathIndex(pathIndex);

    const graph = this.loadGraph();
    addLinksToGraph(graph, id, links);
    this.saveGraph(graph);

    if (aliasIndex) this.saveAliasIndex(aliasIndex);

    return id;
  }

  /** The record `create` stores for `input`; also what `proposeCreate` sizes before it stages one. */
  private newRecord(
    input: CreateInput,
    id: string,
    now: string,
    aliases: string[],
    links: KitLink[],
    fresh: ReturnType<typeof freshnessPatch>,
    sourceRefs: ReturnType<typeof assertCreateFields>,
    origin?: (at: string) => KitMutationLogEntry,
  ): KitRecord {
    return {
      id,
      type: input.type,
      title: input.title,
      category: input.category,
      tags: input.tags ?? [],
      ...(aliases.length ? { aliases } : {}),
      status: 'active',
      created_at: now,
      updated_at: now,
      ...fresh,
      provenance: {
        agent: input.provenance.agent,
        ...(input.provenance.session_id
          ? { session_id: input.provenance.session_id }
          : {}),
        ...(input.provenance.source_ids?.length
          ? { source_ids: input.provenance.source_ids }
          : {}),
        ...(sourceRefs !== undefined ? { source_refs: sourceRefs } : {}),
        ...(input.provenance.note ? { note: input.provenance.note } : {}),
      },
      links,
      mutation_log: origin ? [origin(now)] : [],
      body: input.body,
    };
  }

  /**
   * Refuse a candidate that `create` would refuse for size, before a proposal stages it.
   * The note is sized as `applyCreate` would write it, with `origin` as its first log entry
   * (so large proposal evidence counts), a stand-in id when the candidate has none, and the
   * candidate in the path index so a link to itself shows its file name. What is only known
   * at apply is stood in for by its largest form: the reviewer id with the largest YAML
   * expansion and the longest proposal id, which YAML quotes. In the tested cases (see
   * vault-note-bound.test.ts) the estimate was never below the applied note, and it ran about
   * 4 KiB above it for a plain reviewer. That is a margin, not a proof: a custom id generator
   * with ids longer than a UUID, a link that names the id `create` will generate, or another
   * record taking or renaming a destination or link target between propose and apply can
   * still move the applied note. `applyCreate` checks again and is authoritative.
   */
  private assertCandidateFits(candidate: CreateInput, origin: KitMutationLogEntry): void {
    const aliases = normalizeAliases(candidate.aliases);
    const links = mergeLinks(candidate.links ?? [], extractWikilinks(candidate.body));
    const id = candidate.id || PLACEHOLDER_RECORD_ID;
    // `writeRecord` adds the new record to the index before it renders, so a link to the
    // record itself shows its file name. Do the same here when the candidate names its id
    // (`proposeCreate` already refused an id that is taken). An id-less candidate cannot be
    // linked to by anything yet, and its stand-in id must not capture a link that names
    // another record. If the destination cannot be chosen, size without the entry:
    // `applyCreate` reports that.
    const pathIndex = this.loadPathIndex();
    if (candidate.id) {
      try {
        const path = this.computeRelPath(candidate.category, candidate.title, id, candidate.type, pathIndex);
        pathIndex.by_id[id] = { path, archived: false };
        pathIndex.by_path[path] = id;
      } catch {
        /* sized without the entry */
      }
    }
    const record = this.newRecord(
      candidate,
      id,
      PLACEHOLDER_TIMESTAMP,
      aliases,
      links,
      freshnessPatch(candidate),
      assertCreateFields(candidate, 'proposeCreate'),
      () => origin,
    );
    this.assertNoteFits(this.renderNote(record, pathIndex), 'proposeCreate');
  }

  /** The path index accelerates lookup; only physical records can prove absence. */
  private assertCreateIdentityAvailable(
    id: string,
    pathIndex: PathIndex,
  ): void {
    const directories = [this.root];
    const indexedPaths = new Set(Object.keys(pathIndex.by_path));
    let unindexedRecord = false;
    let entries = 0;
    let remainingBytes = CREATE_IDENTITY_MAX_TOTAL_BYTES;
    while (directories.length > 0) {
      const directory = directories.pop()!;
      for (const entry of this.files.listDirectoryEntries(directory)) {
        if (this.isProposalFile(directory, entry)) continue;
        if (++entries > CREATE_IDENTITY_MAX_ENTRIES)
          throw new KnowledgeStoreCorruptionError(
            'Obsidian identity inspection exceeds its entry bound',
          );
        const path = join(directory, entry.name);
        if (entry.kind === 'directory') {
          directories.push(path);
          continue;
        }
        if (!entry.name.toLowerCase().endsWith('.md')) continue;
        const text = this.files.readText(
          path,
          Math.min(VAULT_NOTE_MAX_BYTES, remainingBytes),
        );
        if (text === null)
          throw new KnowledgeStoreCorruptionError(
            'Obsidian file disappeared during identity inspection',
          );
        remainingBytes -= Buffer.byteLength(text);
        if (remainingBytes < 0)
          throw new KnowledgeStoreCorruptionError(
            'Obsidian identity inspection exceeds its byte bound',
          );
        let meta: Record<string, unknown>;
        let body: string;
        try {
          const frontmatterEnd = text.indexOf('\n---\n', 3);
          if (
            /^(?:\uFEFF)?---(?:\r?\n|$)/.test(text) &&
            (!text.startsWith('---\n') || frontmatterEnd === -1)
          )
            throw new Error('Unsupported or unterminated frontmatter');
          // Empty envelopes are ordinary notes; js-yaml rejects empty documents.
          if (
            text.startsWith('---\n') &&
            text.slice(4, frontmatterEnd).trim() === ''
          ) {
            meta = {};
            body = text.slice(frontmatterEnd + 5);
          } else {
            ({ meta, body } = parseMarkdown(text, {
              maxDepth: 32,
              maxAliases: 50,
              maxTotalMergeKeys: 1000,
            }));
          }
        } catch (error) {
          throw new KnowledgeStoreCorruptionError(
            'Obsidian identity inspection encountered invalid frontmatter',
            { cause: error },
          );
        }
        const rel = relative(this.root, path).split(sep).join('/');
        const indexedId = pathIndex.by_path[rel];
        if (meta.id === id)
          throw new MissingEvidenceError('create: record id already exists');
        if (indexedId) {
          const record = assertKitRecord(meta, body, path);
          if (record.id !== indexedId)
            throw new KnowledgeStoreCorruptionError(
              'Obsidian record identity differs from its path index',
            );
          indexedPaths.delete(rel);
        } else if (meta.provenance !== undefined && meta.type !== undefined) {
          unindexedRecord = true;
        }
      }
    }
    if (indexedPaths.size > 0)
      throw new KnowledgeStoreCorruptionError(
        'Obsidian path index names an unobserved record',
      );
    if (unindexedRecord)
      throw new KnowledgeStoreCorruptionError(
        'Obsidian path index omits an owned record',
      );
  }

  // ── update (§6.2) ──────────────────────────────────────────────────────

  async update(
    id: string,
    fields: UpdateFields,
    evidence: UpdateEvidence,
  ): Promise<void> {
    return this.mutate('update', () =>
      this.updateLocked(id, fields, evidence),
    );
  }

  private updateLocked(
    id: string,
    fields: UpdateFields,
    evidence: UpdateEvidence,
  ): void {
    if (!evidence?.agent) {
      throw new MissingEvidenceError(
        'update: missing required evidence field: agent',
      );
    }

    const pathIndex = this.loadPathIndex();
    const record = this.readRecord(id, pathIndex);
    if (!record) throw new KnowledgeRecordNotFoundError(id);
    assertNotPurged('update', record);

    const mutableKeys = [
      'title',
      'body',
      'category',
      'tags',
      'links',
      'aliases',
      'expires_at',
      'ttl_seconds',
    ] as const;
    const suppliedFields = fields as Record<string, unknown>;
    const supplied = mutableKeys.filter((k) => suppliedFields[k] !== undefined);
    if (supplied.length === 0) {
      throw new MissingEvidenceError(
        'update: at least one mutable field must be supplied',
      );
    }

    if (fields.category !== undefined && !isValidCategory(fields.category)) {
      throw new MissingEvidenceError(
        `update: invalid category: ${fields.category}`,
      );
    }

    const fresh = freshnessPatch(fields);
    const now = new Date(this.services.clock()).toISOString();

    const mergedAliases: string[] = Array.isArray(record.aliases)
      ? record.aliases.slice()
      : [];
    let aliasIndex: AliasIndex | null = null;
    if (fields.aliases !== undefined) {
      const incoming = normalizeAliases(fields.aliases);
      const seen = new Set(mergedAliases);
      for (const slug of incoming) {
        if (!seen.has(slug)) {
          seen.add(slug);
          mergedAliases.push(slug);
        }
      }
      aliasIndex = this.loadAliasIndex();
      registerAliases(aliasIndex, id, mergedAliases);
    }

    let newLinks: KitLink[] = record.links ?? [];
    if (fields.links !== undefined) {
      const wikilinks = extractWikilinks(
        fields.body !== undefined ? fields.body : record.body,
      );
      newLinks = mergeLinks(fields.links, wikilinks);
      const kept = record.links ?? [];
      assertNoPurgedSupport(
        'update',
        newLinks.filter((l) => !kept.some((k) => k.target_id === l.target_id && k.kind === l.kind)),
        undefined,
        (target) => this.readRecord(target, pathIndex),
      );
    } else if (fields.body !== undefined) {
      const wikilinks = extractWikilinks(fields.body);
      newLinks = mergeLinks(record.links ?? [], wikilinks);
    }

    const updated: KitRecord = {
      ...record,
      ...(fields.title !== undefined ? { title: fields.title } : {}),
      ...(fields.body !== undefined ? { body: fields.body } : {}),
      ...(fields.category !== undefined ? { category: fields.category } : {}),
      ...(fields.tags !== undefined ? { tags: fields.tags } : {}),
      ...(mergedAliases.length ? { aliases: mergedAliases } : {}),
      ...fresh,
      links: newLinks,
      updated_at: now,
      mutation_log: [
        ...(record.mutation_log ?? []),
        {
          op: 'update',
          at: now,
          agent: evidence.agent,
          ...(evidence.note ? { note: evidence.note } : {}),
          evidence: { fields: supplied },
        },
      ],
    };

    const graph = this.loadGraph();
    removeLinksFromGraph(graph, id);
    addLinksToGraph(graph, id, newLinks);
    this.saveGraph(graph);

    this.writeRecord(updated, pathIndex);
    this.savePathIndex(pathIndex);

    if (aliasIndex) this.saveAliasIndex(aliasIndex);
  }

  // ── link (§6.3) ────────────────────────────────────────────────────────

  async link(
    sourceId: string,
    links: KitLink[],
    evidence: LinkEvidence,
  ): Promise<void> {
    return this.mutate('link', () =>
      this.linkLocked(sourceId, links, evidence),
    );
  }

  private linkLocked(
    sourceId: string,
    links: KitLink[],
    evidence: LinkEvidence,
  ): void {
    if (!evidence?.agent) {
      throw new MissingEvidenceError(
        'link: missing required evidence field: agent',
      );
    }
    if (!links || links.length === 0) {
      throw new MissingEvidenceError('link: links array must be non-empty');
    }

    const pathIndex = this.loadPathIndex();
    const source = this.readRecord(sourceId, pathIndex);
    if (!source) throw new KnowledgeRecordNotFoundError(sourceId);
    assertNotPurged('link', source);

    for (const l of links) {
      const target = this.readRecord(l.target_id, pathIndex);
      if (!target) throw new KnowledgeRecordNotFoundError(l.target_id);
      assertNotPurged('link', target);
    }

    const now = new Date(this.services.clock()).toISOString();
    const newLinks = appendUniqueLinks(source.links ?? [], links);

    const updated: KitRecord = {
      ...source,
      links: newLinks,
      updated_at: now,
      mutation_log: [
        ...(source.mutation_log ?? []),
        {
          op: 'link',
          at: now,
          agent: evidence.agent,
          ...(evidence.note ? { note: evidence.note } : {}),
          evidence: { added: links },
        },
      ],
    };

    const graph = this.loadGraph();
    removeLinksFromGraph(graph, sourceId);
    addLinksToGraph(graph, sourceId, newLinks);
    this.saveGraph(graph);

    this.writeRecord(updated, pathIndex);
    this.savePathIndex(pathIndex);
  }

  // ── create proposals (owner decision, 2026-11-03) ──────────────────────

  async proposeCreate(
    candidate: CreateInput,
    proposerId: string,
    evidence: ProposeEvidence,
    options?: { requestKey?: string },
  ): Promise<string> {
    return this.mutate('proposeCreate', () =>
      this.proposals.stage(
        candidate,
        proposerId,
        evidence,
        (id) => this.readRecord(id, this.loadPathIndex()) !== null,
        options,
        (validated, origin) => this.assertCandidateFits(validated, origin),
        (stored) =>
          assertNoPurgedSupport('proposeCreate', stored.links ?? [], stored.provenance?.source_ids, (id) =>
            this.readRecord(id, this.loadPathIndex()),
          ),
      ),
    );
  }

  async applyCreate(proposalId: string, reviewerId: string): Promise<string> {
    return this.mutate('applyCreate', () => this.applyCreateLocked(proposalId, reviewerId));
  }

  async rejectCreate(proposalId: string, reviewerId: string, rationale: string): Promise<void> {
    return this.mutate('rejectCreate', () => this.rejectCreateLocked(proposalId, reviewerId, rationale));
  }

  private applyCreateLocked(proposalId: string, reviewerId: string): string {
    const proposal = this.proposals.pendingFor('applyCreate', proposalId, reviewerId);
    let at = '';
    const recordId = this.createLocked(proposal.candidate, (now) => {
      at = now;
      return this.proposals.applyOrigin(proposal, reviewerId, now);
    });
    this.proposals.settle(proposal, { state: 'applied', reviewerId, at, recordId });
    return recordId;
  }

  private rejectCreateLocked(proposalId: string, reviewerId: string, rationale: string): void {
    const proposal = this.proposals.pendingFor('rejectCreate', proposalId, reviewerId);
    const reason = CreateProposals.rationale(rationale);
    this.proposals.settle(proposal, {
      state: 'rejected',
      reviewerId,
      at: new Date(this.services.clock()).toISOString(),
      rationale: reason,
    });
  }

  async getProposal(proposalId: string): Promise<KitCreateProposal | null> {
    return this.files.read(() => this.proposals.get(proposalId));
  }

  async listProposals(options: CreateProposalListOptions = {}): Promise<KitCreateProposal[]> {
    return this.files.read(() => this.proposals.list(options));
  }

  // ── propose (§6.4) ─────────────────────────────────────────────────────

  async propose(
    conceptId: string,
    proposerId: string,
    evidence: ProposeEvidence,
  ): Promise<void> {
    return this.mutate('propose', () =>
      this.proposeLocked(conceptId, proposerId, evidence),
    );
  }

  private proposeLocked(
    conceptId: string,
    proposerId: string,
    evidence: ProposeEvidence,
  ): void {
    if (!evidence?.agent) {
      throw new MissingEvidenceError(
        'propose: missing required evidence field: agent',
      );
    }
    if (!evidence?.proposal?.trim()) {
      throw new MissingEvidenceError(
        'propose: missing required evidence field: proposal',
      );
    }

    const pathIndex = this.loadPathIndex();
    const concept = this.readRecord(conceptId, pathIndex);
    if (!concept) throw new KnowledgeRecordNotFoundError(conceptId);

    const proposer = this.readRecord(proposerId, pathIndex);
    if (!proposer) throw new KnowledgeRecordNotFoundError(proposerId);
    assertNotPurged('propose', concept);
    assertNotPurged('propose', proposer);

    const now = new Date(this.services.clock()).toISOString();

    const proposerLinks = proposer.links ?? [];
    const alreadyLinked = proposerLinks.some(
      (l) => l.target_id === conceptId && l.kind === 'proposes',
    );
    if (!alreadyLinked) {
      const updatedProposer: KitRecord = {
        ...proposer,
        links: [...proposerLinks, { target_id: conceptId, kind: 'proposes' }],
        updated_at: now,
        mutation_log: [
          ...(proposer.mutation_log ?? []),
          {
            op: 'propose',
            at: now,
            agent: evidence.agent,
            evidence: { concept_id: conceptId, proposal: evidence.proposal },
          },
        ],
      };
      this.writeRecord(updatedProposer, pathIndex);

      const graph = this.loadGraph();
      removeLinksFromGraph(graph, proposerId);
      addLinksToGraph(graph, proposerId, updatedProposer.links ?? []);
      this.saveGraph(graph);
    }

    const updatedConcept: KitRecord = {
      ...concept,
      mutation_log: [
        ...(concept.mutation_log ?? []),
        {
          op: 'propose',
          at: now,
          agent: evidence.agent,
          evidence: { proposer_id: proposerId, proposal: evidence.proposal },
        },
      ],
    };
    this.writeRecord(updatedConcept, pathIndex);
    this.savePathIndex(pathIndex);
  }

  // ── apply (§6.5) ───────────────────────────────────────────────────────

  async apply(
    conceptId: string,
    proposerId: string,
    evidence: ApplyEvidence,
  ): Promise<void> {
    return this.mutate('apply', () =>
      this.applyLocked(conceptId, proposerId, evidence),
    );
  }

  private applyLocked(
    conceptId: string,
    proposerId: string,
    evidence: ApplyEvidence,
  ): void {
    if (!evidence?.agent) {
      throw new MissingEvidenceError(
        'apply: missing required evidence field: agent',
      );
    }
    if (typeof evidence?.new_body !== 'string' || !evidence.new_body.trim()) {
      throw new MissingEvidenceError(
        'apply: missing required evidence field: new_body',
      );
    }
    if (!evidence?.rationale?.trim()) {
      throw new MissingEvidenceError(
        'apply: missing required evidence field: rationale',
      );
    }

    const pathIndex = this.loadPathIndex();
    const concept = this.readRecord(conceptId, pathIndex);
    if (!concept) throw new KnowledgeRecordNotFoundError(conceptId);

    const proposer = this.readRecord(proposerId, pathIndex);
    if (!proposer) throw new KnowledgeRecordNotFoundError(proposerId);
    assertNotPurged('apply', concept);
    assertNotPurged('apply', proposer);

    const proposerLinks = proposer.links ?? [];
    const hasProposesLink = proposerLinks.some(
      (l) => l.target_id === conceptId && l.kind === 'proposes',
    );
    if (!hasProposesLink) {
      throw new MissingEvidenceError(
        `apply: no "proposes" link from ${proposerId} to ${conceptId}`,
      );
    }

    const now = new Date(this.services.clock()).toISOString();
    const updatedConcept: KitRecord = {
      ...concept,
      body: evidence.new_body,
      updated_at: now,
      mutation_log: [
        ...(concept.mutation_log ?? []),
        {
          op: 'apply',
          at: now,
          agent: evidence.agent,
          evidence: { proposer_id: proposerId, rationale: evidence.rationale },
        },
      ],
    };
    this.writeRecord(updatedConcept, pathIndex);
    this.savePathIndex(pathIndex);
  }

  // ── reject (§6.6) ──────────────────────────────────────────────────────

  async reject(
    conceptId: string,
    proposerId: string,
    evidence: RejectEvidence,
  ): Promise<void> {
    return this.mutate('reject', () =>
      this.rejectLocked(conceptId, proposerId, evidence),
    );
  }

  private rejectLocked(
    conceptId: string,
    proposerId: string,
    evidence: RejectEvidence,
  ): void {
    if (!evidence?.agent) {
      throw new MissingEvidenceError(
        'reject: missing required evidence field: agent',
      );
    }
    if (!evidence?.reason?.trim()) {
      throw new MissingEvidenceError(
        'reject: missing required evidence field: reason',
      );
    }

    const pathIndex = this.loadPathIndex();
    const concept = this.readRecord(conceptId, pathIndex);
    if (!concept) throw new KnowledgeRecordNotFoundError(conceptId);

    const proposer = this.readRecord(proposerId, pathIndex);
    if (!proposer) throw new KnowledgeRecordNotFoundError(proposerId);
    assertNotPurged('reject', concept);
    assertNotPurged('reject', proposer);

    const proposerLinks = proposer.links ?? [];
    const hasProposesLink = proposerLinks.some(
      (l) => l.target_id === conceptId && l.kind === 'proposes',
    );
    if (!hasProposesLink) {
      throw new MissingEvidenceError(
        `reject: no "proposes" link from ${proposerId} to ${conceptId}`,
      );
    }

    const now = new Date(this.services.clock()).toISOString();
    const updatedConcept: KitRecord = {
      ...concept,
      mutation_log: [
        ...(concept.mutation_log ?? []),
        {
          op: 'reject',
          at: now,
          agent: evidence.agent,
          evidence: { proposer_id: proposerId, reason: evidence.reason },
        },
      ],
    };
    this.writeRecord(updatedConcept, pathIndex);
    this.savePathIndex(pathIndex);
  }

  // ── supersede (Addendum A.5/A.6) ──────────────────────────────────────

  async supersede(
    newId: string,
    supersededIds: string[],
    evidence: SupersedeEvidence,
  ): Promise<void> {
    return this.mutate('supersede', () =>
      this.supersedeLocked(newId, supersededIds, evidence),
    );
  }

  private supersedeLocked(
    newId: string,
    supersededIds: string[],
    evidence: SupersedeEvidence,
  ): void {
    if (!evidence?.agent) {
      throw new MissingEvidenceError(
        'supersede: missing required evidence field: agent',
      );
    }
    if (!evidence?.rationale?.trim()) {
      throw new MissingEvidenceError(
        'supersede: missing required evidence field: rationale',
      );
    }
    if (!supersededIds || supersededIds.length === 0) {
      throw new MissingEvidenceError(
        'supersede: supersededIds must be a non-empty array',
      );
    }

    const pathIndex = this.loadPathIndex();
    const newRecord = this.readRecord(newId, pathIndex);
    if (!newRecord) throw new KnowledgeRecordNotFoundError(newId);
    assertNotPurged('supersede', newRecord);

    for (const sid of supersededIds) {
      const old = this.readRecord(sid, pathIndex);
      if (!old) throw new KnowledgeRecordNotFoundError(sid);
      assertNotPurged('supersede', old);
    }

    const now = new Date(this.services.clock()).toISOString();

    const supersededLinks: KitLink[] = supersededIds.map((sid) => ({
      target_id: sid,
      kind: 'supersedes',
    }));

    const newLinks = appendUniqueLinks(newRecord.links ?? [], supersededLinks);

    const updatedNew: KitRecord = {
      ...newRecord,
      links: newLinks,
      updated_at: now,
      mutation_log: [
        ...(newRecord.mutation_log ?? []),
        {
          op: 'supersede',
          at: now,
          agent: evidence.agent,
          rationale: evidence.rationale,
          ...(evidence.note ? { note: evidence.note } : {}),
          evidence: { superseded_count: supersededIds.length },
        },
      ],
    };

    const graph = this.loadGraph();
    removeLinksFromGraph(graph, newId);
    addLinksToGraph(graph, newId, newLinks);
    this.saveGraph(graph);

    this.writeRecord(updatedNew, pathIndex);

    // Records are NOT deleted — supersede-not-delete invariant (A.5). Each superseded
    // record gets its mutation-log entry written at its CURRENT (pre-archive) path,
    // then is moved to archive/.
    for (const sid of supersededIds) {
      const supersededRecord = this.readRecord(sid, pathIndex);
      if (!supersededRecord) continue; // already verified above; defensive.
      const updatedSuperseded: KitRecord = {
        ...supersededRecord,
        mutation_log: [
          ...(supersededRecord.mutation_log ?? []),
          {
            op: 'superseded-by',
            at: now,
            agent: evidence.agent,
            new_id: newId,
            rationale: evidence.rationale,
            ...(evidence.note ? { note: evidence.note } : {}),
            evidence: { superseded_by_id: newId },
          },
        ],
      };
      this.writeRecord(updatedSuperseded, pathIndex);
      this.archiveRecord(sid, pathIndex);
    }

    this.savePathIndex(pathIndex);
  }

  // ── retire (Addendum B.4/B.5) ─────────────────────────────────────────

  async retire(
    id: string,
    targetStatus: 'implemented' | 'retired',
    evidence: RetireEvidence,
  ): Promise<void> {
    return this.mutate('retire', () =>
      this.retireLocked(id, targetStatus, evidence),
    );
  }

  private retireLocked(
    id: string,
    targetStatus: 'implemented' | 'retired',
    evidence: RetireEvidence,
  ): void {
    if (!evidence?.agent) {
      throw new MissingEvidenceError(
        'retire: missing required evidence field: agent',
      );
    }
    if (!evidence?.rationale?.trim()) {
      throw new MissingEvidenceError(
        'retire: missing required evidence field: rationale',
      );
    }
    if (targetStatus !== 'implemented' && targetStatus !== 'retired') {
      throw new MissingEvidenceError(
        `retire: targetStatus must be "implemented" or "retired"; got: ${targetStatus}`,
      );
    }
    if (targetStatus === 'implemented' && !evidence.implementedByRef?.trim()) {
      throw new MissingEvidenceError(
        'retire: implementedByRef is required when targetStatus is "implemented"',
      );
    }

    const pathIndex = this.loadPathIndex();
    const record = this.readRecord(id, pathIndex);
    if (!record) throw new KnowledgeRecordNotFoundError(id);
    assertNotPurged('retire', record);

    const currentStatus = record.status ?? 'active';
    const allowed = VALID_STATUS_TRANSITIONS[currentStatus];
    if (!allowed?.has(targetStatus)) {
      throw new MissingEvidenceError(
        `retire: invalid transition from "${currentStatus}" to "${targetStatus}"`,
      );
    }

    const now = new Date(this.services.clock()).toISOString();
    const updated: KitRecord = {
      ...record,
      status: targetStatus,
      updated_at: now,
      mutation_log: [
        ...(record.mutation_log ?? []),
        {
          op: 'retire',
          at: now,
          agent: evidence.agent,
          ...(evidence.note ? { note: evidence.note } : {}),
          evidence: {
            targetStatus,
            rationale: evidence.rationale,
            ...(evidence.implementedByRef
              ? { implementedByRef: evidence.implementedByRef }
              : {}),
            ...(evidence.supersededByRef
              ? { supersededByRef: evidence.supersededByRef }
              : {}),
          },
        },
      ],
    };
    this.writeRecord(updated, pathIndex);
    this.savePathIndex(pathIndex);
  }

  // ── purge (owner decision, 2026-11-02) ─────────────────────────────────

  async purge(ids: string[], evidence: PurgeEvidence): Promise<PurgeResult> {
    if (this.services.allowPurge !== true) {
      throw new ReadOnlyStoreError('purge', 'purge is disabled for this store; the host enables it with allowPurge: true after its own authorization.');
    }
    const requested = validatePurgeInput(ids, evidence);
    return this.mutate('purge', () => this.purgeLocked(requested, evidence), { erasure: true });
  }

  /** An id-derived, title-free path for a tombstone; an occupied name gets a numeric suffix. */
  private tombstonePath(id: string, pathIndex: PathIndex): string {
    const base = /^[a-z0-9][a-z0-9_-]{0,99}$/.test(id)
      ? id
      : `id-${createHash('sha256').update(id).digest('hex').slice(0, 32)}`;
    for (let suffix = 1; ; suffix++) {
      const relPath = `${TOMBSTONE_DIR}/${suffix === 1 ? base : `${base}-${suffix}`}.md`;
      const owner = pathIndex.by_path[relPath];
      if (owner === undefined || owner === id) {
        if (owner === undefined && this.files.readText(this.resolveStorePath(relPath), VAULT_NOTE_MAX_BYTES) !== null) {
          throw new KnowledgeStoreCorruptionError('Obsidian tombstone destination is occupied by an unindexed file');
        }
        return relPath;
      }
    }
  }

  /**
   * The fullest tombstone whose note fits the vault note bound. A tombstone keeps provenance and
   * link ids that a note near the bound can be mostly made of, and nothing the host does to the
   * record changes that, so unlike a survivor it is shortened instead of refusing the erasure.
   */
  private fittingTombstone(
    record: KitRecord,
    at: string,
    evidence: PurgeEvidence,
    via: string[] | undefined,
    pathIndex: PathIndex,
  ): KitRecord {
    let stone = tombstoneOf(record, at, evidence, via);
    for (const shape of TOMBSTONE_SHAPES) {
      stone = tombstoneOf(record, at, evidence, via, shape);
      try {
        if (Buffer.byteLength(this.renderNote(stone, pathIndex)) <= VAULT_NOTE_MAX_BYTES) break;
      } catch (error) {
        // The YAML writer recurses on a multi-megabyte scalar and overflows the stack: that shape
        // cannot be written at all, which is the same as not fitting.
        if (!(error instanceof RangeError)) throw error;
      }
    }
    return stone;
  }

  private purgeLocked(requested: string[], evidence: PurgeEvidence): PurgeResult {
    // `corpus-store migrate` keeps the Kit index and a manifest of every file's hash and
    // path, so it would keep the erased titles. (The names are fixed by that command.)
    for (const kept of ['.corpus-store-migration/kit-v1-path-index.json', '.corpus-store-migration/manifest.json']) {
      if (this.files.readText(this.resolveStorePath(kept)) !== null) {
        throw new ReadOnlyStoreError('purge', 'this vault holds .corpus-store-migration/, which keeps the original index and file hashes; delete it once the migration is verified, then purge.');
      }
    }
    const pathIndex = this.loadPathIndex();
    const records = new Map<string, KitRecord>();
    for (const id of Object.keys(pathIndex.by_id)) {
      const record = this.readRecord(id, pathIndex);
      if (record) records.set(id, record);
    }
    for (const id of requested) {
      if (!records.has(id)) throw new KnowledgeRecordNotFoundError(id);
    }
    const plan = planPurge(requested, records);
    const now = new Date(this.services.clock()).toISOString();
    const graph = this.loadGraph();
    const aliasIndex = this.loadAliasIndex();

    // Every tombstone moves before anything renders, so no survivor's generated
    // link section can still name an erased title.
    for (const id of [...plan.purged, ...plan.cascaded]) {
      const stone = this.fittingTombstone(records.get(id)!, now, evidence, plan.via.get(id), pathIndex);
      const entry = pathIndex.by_id[id];
      const target = this.tombstonePath(id, pathIndex);
      this.files.remove(this.resolveStorePath(entry.path));
      delete pathIndex.by_path[entry.path];
      pathIndex.by_id[id] = { path: target, archived: true };
      pathIndex.by_path[target] = id;
      this.writeRecord(stone, pathIndex, { enforceNoteBound: 'purge' });
      removeLinksFromGraph(graph, id);
      addLinksToGraph(graph, id, stone.links ?? []);
      unregisterAliases(aliasIndex, id);
    }
    for (const [op, ids] of [['support-purged', plan.survivors], ['reference-purged', plan.referrers]] as const) {
      for (const id of ids) {
        const survivor = (compact: boolean) =>
          survivorOf(op, records.get(id)!, now, evidence, plan.erased, plan.lost.get(id)!, compact);
        let kept = survivor(false);
        // The log entry and the re-render can grow a near-limit note past the bound that every
        // identity scan reads with. Try the entry without its prose first. A survivor is the
        // host's content, so beyond that the purge is refused rather than shortening it, and
        // everything purge writes is staged, so a refusal writes nothing.
        try {
          this.writeRecord(kept, pathIndex, { enforceNoteBound: 'purge' });
        } catch (error) {
          if (!(error instanceof MissingEvidenceError)) throw error;
          kept = survivor(true);
          this.writeRecord(kept, pathIndex, { enforceNoteBound: `purge (record ${id}; shrink it, then purge again)` });
        }
        // The graph mirrors link labels, so it follows the stripped labels.
        removeLinksFromGraph(graph, id);
        addLinksToGraph(graph, id, kept.links ?? []);
      }
    }

    this.savePathIndex(pathIndex);
    this.saveGraph(graph);
    this.saveAliasIndex(aliasIndex);
    const proposals = this.proposals.erase(plan.erased, plan.allErased, evidence, now);
    return {
      purged: plan.purged,
      cascaded: plan.cascaded,
      survivors: plan.survivors,
      referrers: plan.referrers,
      alreadyPurged: plan.alreadyPurged,
      proposalsRejected: proposals.rejected,
      proposalsScrubbed: proposals.scrubbed,
      proposalsBlocked: proposals.blocked,
    };
  }

  // ── get / getLinks (§7, Addendum H) ───────────────────────────────────

  async get(idOrHandle: string): Promise<KitRecord | null> {
    return this.files.read(() => {
      const pathIndex = this.loadPathIndex();
      const resolvedId = this.resolveId(idOrHandle, pathIndex);
      if (!resolvedId) return null;
      return this.readRecord(resolvedId, pathIndex);
    });
  }

  async getLinks(
    idOrHandle: string,
  ): Promise<{ forward: KitLink[]; reverse: KitReverseLink[] }> {
    return this.files.read(() => {
      const key = this.resolveId(idOrHandle) ?? idOrHandle;
      const graph = this.loadGraph();
      return {
        forward: (graph.forward[key] ?? []).map((l) => ({ ...l })),
        reverse: (graph.reverse[key] ?? []).map((l) => ({ ...l })),
      };
    });
  }

  // ── listByCategory / listByType (§7, B.3/B.5; working set by default) ──

  async listByCategory(
    category: string,
    options: CategoryListOptions = {},
  ): Promise<KitRecord[]> {
    return this.files.read(() =>
      this.listed(options).filter((r) =>
        options.prefix
          ? r.category === category || r.category.startsWith(`${category}.`)
          : r.category === category,
      ),
    );
  }

  async listByType(
    type: KitRecordType,
    options: ListOptions = {},
  ): Promise<KitRecord[]> {
    return this.files.read(() => this.listed(options).filter((r) => r.type === type));
  }

  /** History walks archived notes too; the working set excludes them. */
  private listed(options: ListOptions): KitRecord[] {
    const history = includesHistory(options);
    const expiry = expiryFilter(options, this.services.clock);
    const pathIndex = this.loadPathIndex();
    const records: KitRecord[] = [];
    for (const [id, entry] of Object.entries(pathIndex.by_id)) {
      if (!history && entry.archived) continue;
      const record = this.readRecord(id, pathIndex);
      if (
        record &&
        (history || !isHistorical(record, { archived: entry.archived })) &&
        (!expiry || expiry(record))
      ) {
        records.push(record);
      }
    }
    return records;
  }
}
