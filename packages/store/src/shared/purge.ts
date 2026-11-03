/**
 * Purge (owner decision, 2026-11-02): the explicit, audited, privileged exception to
 * supersede-not-delete. This module is the one place that decides what a tombstone
 * keeps and which records a purge reaches, so the default and vault adapters cannot
 * drift apart. It is pure: the adapters own all reads, writes and index updates.
 *
 * A tombstone keeps identity (`id`, `type`, `created_at`), provenance (`agent`,
 * `session_id`, `source_ids`), link targets and kinds, and the mutation history
 * reduced to who/what/when plus identity references. It drops every field that can
 * carry the erased content: title, body, tags, aliases, expiry, link labels,
 * provenance `note`, the free-text log fields, and any unknown field. Its category
 * becomes `purged`, because a category path can name the data subject. It keeps no
 * content hash: a short or guessable value would let anyone holding the tombstone
 * confirm a guess against it.
 */
import type {
  KitLink,
  KitMutationLogEntry,
  KitRecord,
  PurgeEvidence,
  PurgeResult,
} from '../contracts.js';
import { isRecord } from '../is-record.js';
import { MissingEvidenceError, RecordPurgedError } from '../errors.js';

/** Fixed title of every tombstone. `title` is a required field, and the original is content. */
export const PURGED_TITLE = '[purged]';
/** Fixed category of every tombstone. */
export const PURGED_CATEGORY = 'purged';

export function isPurged(record: Pick<KitRecord, 'status'>): boolean {
  return record.status === 'purged';
}

export function assertNotPurged(op: string, record: KitRecord): void {
  if (isPurged(record)) throw new RecordPurgedError(op, record.id);
}

/**
 * New support must not point at a tombstone: a `source` link or a source id naming
 * a purged record would give erased content a fresh dependent. Plain references
 * (`related`) stay allowed. `lookup` returns null for an id that is not a record.
 */
export function assertNoPurgedSupport(
  op: string,
  links: readonly KitLink[],
  sourceIds: readonly string[] | undefined,
  lookup: (id: string) => KitRecord | null,
): void {
  const named = [
    ...(sourceIds ?? []),
    ...links.filter((link) => link.kind === 'source').map((link) => link.target_id),
  ];
  for (const id of named) {
    const target = lookup(id);
    if (target) assertNotPurged(op, target);
  }
}

/**
 * The records a record rests on: `provenance.source_ids` plus the targets of its
 * `source` links. Other link kinds (`related`, `proposes`, `supersedes`) are
 * references, not support. Ids may name records outside the store; those are never
 * purged, so they count as remaining support.
 */
export function supportIds(record: {
  id?: string;
  provenance?: { source_ids?: readonly string[] };
  links?: readonly { target_id: string; kind: string }[];
}): string[] {
  const ids = new Set<string>();
  for (const id of record.provenance?.source_ids ?? []) ids.add(id);
  for (const link of record.links ?? []) {
    if (link.kind === 'source') ids.add(link.target_id);
  }
  if (record.id !== undefined) ids.delete(record.id);
  return [...ids].sort();
}

/** Every record a record points at: its support and all link targets. */
function referenceIds(record: KitRecord): string[] {
  const ids = new Set(supportIds(record));
  for (const link of record.links ?? []) ids.add(link.target_id);
  ids.delete(record.id);
  return [...ids].sort();
}

export type PurgePlan = Omit<PurgeResult, 'proposalsRejected' | 'proposalsScrubbed' | 'proposalsBlocked'> & {
  /** Every id this call tombstones: requested targets plus the cascade. */
  erased: ReadonlySet<string>;
  /** `erased` plus every earlier tombstone. */
  allErased: ReadonlySet<string>;
  /** For each cascaded record, the support that was entirely purged. */
  via: Map<string, string[]>;
  /** For each survivor, the purged ids it rests on. */
  lost: Map<string, string[]>;
};

/**
 * Decide the cascade. `records` holds every record in the store, tombstones included,
 * and every requested id must be in it.
 *
 * A record is *affected* when a chain of support reaches a requested id. An affected
 * record survives only if it has support that is real: an id outside the store, a
 * record the purge does not reach, or an affected record that itself survives. That
 * is a least fixed point over the affected records, so two affected records that only
 * support each other fall together, while a record with a live supporter outside the
 * purge's reach (even one that is part of an older cycle) keeps it. Tombstones and
 * requested ids are never real support. A record the purge does not reach is left
 * alone, whatever its own support looks like.
 */
export function planPurge(
  requested: readonly string[],
  records: ReadonlyMap<string, KitRecord>,
): PurgePlan {
  const targets = [...new Set(requested)];
  const alreadyPurged = targets.filter((id) => isPurged(records.get(id)!));
  const purged = targets.filter((id) => !alreadyPurged.includes(id));
  const ordered = [...records.values()].sort((a, b) => a.id.localeCompare(b.id));
  const gone = new Set<string>(ordered.filter(isPurged).map((record) => record.id));
  for (const id of purged) gone.add(id);

  const affected = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const record of ordered) {
      if (gone.has(record.id) || affected.has(record.id)) continue;
      if (supportIds(record).some((id) => purged.includes(id) || affected.has(id))) {
        affected.add(record.id);
        changed = true;
      }
    }
  }

  const alive = new Set<string>();
  const real = (id: string) => !gone.has(id) && (!records.has(id) || !affected.has(id) || alive.has(id));
  for (let changed = true; changed; ) {
    changed = false;
    for (const record of ordered) {
      if (!affected.has(record.id) || alive.has(record.id)) continue;
      if (supportIds(record).some(real)) {
        alive.add(record.id);
        changed = true;
      }
    }
  }
  const cascaded = ordered.filter((r) => affected.has(r.id) && !alive.has(r.id)).map((r) => r.id);
  const via = new Map(cascaded.map((id) => [id, supportIds(records.get(id)!)]));

  const newlyGone = new Set([...purged, ...cascaded]);
  const survivors: string[] = [];
  const referrers: string[] = [];
  const lost = new Map<string, string[]>();
  for (const record of ordered) {
    if (gone.has(record.id) || newlyGone.has(record.id)) continue;
    const support = supportIds(record).filter((id) => newlyGone.has(id));
    const referenced = referenceIds(record).filter((id) => newlyGone.has(id));
    if (support.length > 0) survivors.push(record.id);
    else if (referenced.length > 0) referrers.push(record.id);
    if (referenced.length > 0) lost.set(record.id, referenced);
  }
  const allErased = new Set([...gone, ...newlyGone]);
  return { purged, cascaded, survivors, referrers, alreadyPurged, erased: newlyGone, allErased, via, lost };
}

// Evidence keys that hold identities or fixed vocabulary, never caller prose.
const KEPT_EVIDENCE = new Set([
  'superseded_by_id', 'proposer_id', 'concept_id', 'superseded_count',
  'targetStatus', 'fields', 'cause', 'via', 'purged_ids', 'proposal_id',
]);
// Ops whose rationale and note are the audit record itself.
const AUDIT_OPS = new Set(['purged', 'support-purged', 'reference-purged']);

function scrubEntry(entry: KitMutationLogEntry): KitMutationLogEntry {
  const kept: KitMutationLogEntry = { op: entry.op, at: entry.at, agent: entry.agent };
  if (typeof entry.new_id === 'string') kept.new_id = entry.new_id;
  if (AUDIT_OPS.has(entry.op)) {
    if (typeof entry.rationale === 'string') kept.rationale = entry.rationale;
    if (typeof entry.note === 'string') kept.note = entry.note;
  }
  if (isRecord(entry.evidence)) {
    const evidence = Object.fromEntries(
      Object.entries(entry.evidence).filter(([key]) => KEPT_EVIDENCE.has(key)),
    );
    if (Object.keys(evidence).length > 0) kept.evidence = evidence;
  }
  return kept;
}

function auditEntry(
  op: 'purged' | 'support-purged' | 'reference-purged',
  at: string,
  evidence: PurgeEvidence,
  detail: Record<string, unknown>,
): KitMutationLogEntry {
  return {
    op,
    at,
    agent: evidence.agent,
    rationale: evidence.rationale,
    ...(evidence.note ? { note: evidence.note } : {}),
    evidence: detail,
  };
}

/** The tombstone that replaces `record`. `via` is set for a cascaded record. */
export function tombstoneOf(
  record: KitRecord,
  at: string,
  evidence: PurgeEvidence,
  via?: string[],
): KitRecord {
  const links: KitLink[] = (record.links ?? []).map(({ target_id, kind }) => ({ target_id, kind }));
  const { provenance } = record;
  return {
    id: record.id,
    type: record.type,
    title: PURGED_TITLE,
    body: '',
    category: PURGED_CATEGORY,
    status: 'purged',
    created_at: record.created_at,
    updated_at: at,
    provenance: {
      agent: provenance.agent,
      ...(provenance.session_id ? { session_id: provenance.session_id } : {}),
      ...(provenance.source_ids?.length ? { source_ids: [...provenance.source_ids] } : {}),
    },
    links,
    mutation_log: [
      ...(record.mutation_log ?? []).map(scrubEntry),
      auditEntry('purged', at, evidence, via ? { cause: 'sole-support-purged', via } : { cause: 'requested' }),
    ],
  };
}

/**
 * A survivor (it still rests on other support) or a referrer (it only links to a
 * purged record) keeps everything except two things: the display labels of its
 * links to erased records, in its links and in the `link` log entries that added
 * them, which can repeat the erased title; and its log, which records the purge. `op` is `support-purged` for a survivor and `reference-purged`
 * for a referrer. Link targets and kinds stay, so a survivor keeps its support.
 */
export function survivorOf(
  op: 'support-purged' | 'reference-purged',
  record: KitRecord,
  at: string,
  evidence: PurgeEvidence,
  erased: ReadonlySet<string>,
  purgedIds: string[],
): KitRecord {
  return {
    ...record,
    links: (record.links ?? []).map((link) => {
      if (!erased.has(link.target_id) || link.label === undefined) return link;
      const { label: _label, ...unlabeled } = link;
      return unlabeled;
    }),
    mutation_log: [
      ...(record.mutation_log ?? []).map((entry) => unlabelErased(entry, erased)),
      auditEntry(op, at, evidence, { purged_ids: purgedIds }),
    ],
  };
}

/** A `link` entry repeats the labels it added; drop the ones aimed at erased records. */
function unlabelErased(entry: KitMutationLogEntry, erased: ReadonlySet<string>): KitMutationLogEntry {
  const added = isRecord(entry.evidence) ? entry.evidence.added : undefined;
  if (entry.op !== 'link' || !Array.isArray(added)) return entry;
  return {
    ...entry,
    evidence: {
      ...entry.evidence,
      added: added.map((link) => {
        if (!isRecord(link) || !erased.has(String(link.target_id)) || !('label' in link)) return link;
        const { label: _label, ...unlabeled } = link;
        return unlabeled;
      }),
    },
  };
}

/** Input checks shared by both adapters; they run before any read or write. */
export function validatePurgeInput(ids: unknown, evidence: PurgeEvidence): string[] {
  const text = (value: unknown) => typeof value === 'string' && value.trim() !== '';
  const bounded = (value: string, limit: number) => Buffer.byteLength(value) <= limit;
  if (!text(evidence?.agent)) {
    throw new MissingEvidenceError('purge: missing required evidence field: agent');
  }
  if (!text(evidence.rationale)) {
    throw new MissingEvidenceError('purge: missing required evidence field: rationale');
  }
  if (evidence.note !== undefined && typeof evidence.note !== 'string') {
    throw new MissingEvidenceError('purge: evidence note must be a string');
  }
  // These are copied into tombstones and proposals, which must stay loadable.
  if (!bounded(evidence.agent, 1024) || !bounded(evidence.rationale, 16 * 1024) || !bounded(evidence.note ?? '', 16 * 1024)) {
    throw new MissingEvidenceError('purge: agent must be at most 1 KiB, rationale and note at most 16 KiB');
  }
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string' || !id)) {
    throw new MissingEvidenceError('purge: ids must be a non-empty array of record ids');
  }
  return ids as string[];
}
