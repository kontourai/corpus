// ── Record envelope (store-contract.md §1, §4, Addendum A.2/A.3, B.1) ──────

export type KitRecordType =
  | 'raw'
  | 'compiled'
  | 'concept'
  | 'snapshot'
  | 'person';

/**
 * Lifecycle status (Addendum B.1). Records without a `status` are treated as `active`.
 * `purged` marks a tombstone written by `purge` (owner decision, 2026-11-02). It is
 * terminal and is never set by `retire`.
 */
export type KitRecordStatus = 'active' | 'implemented' | 'retired' | 'purged';

/** A directed link from a source record to a target record (store-contract.md §2.1). */
export interface KitLink {
  target_id: string;
  kind: string;
  label?: string;
}

/**
 * An inbound (reverse) edge as returned by `getLinks(id).reverse` and persisted in
 * `graph-index.json`'s `reverse` map (store-contract.md §5.1: `{ source_id, kind }`,
 * with no `label` — the label lives only on the *forward* entry). Deliberately
 * distinct from `KitLink`: a reverse entry names the *source* that points at the
 * queried record, not a `target_id` — the design doc's simplified K2 excerpt
 * collapses this to `KitLink[]`, but §5.1's schema and the Kit's own reference
 * adapter both return `source_id`-shaped objects (no `label`) for `reverse`, which
 * this type follows precisely (see s200-knowledge-store plan notes for the record).
 */
export interface KitReverseLink {
  source_id: string;
  kind: string;
}

/** Known source-reference kinds. Other kinds require a future validated registry entry. */
export type KitSourceRefRegistry = {
  'session-transcript': {
    kind: 'session-transcript';
    harness: string;
    session_id: string;
    transcript_ref: string;
    sitting_id?: string;
    /** Inclusive, one-based line range in the referenced transcript. */
    range?: { start: number; end: number };
  };
}
export type KitSourceRef = KitSourceRefRegistry[keyof KitSourceRefRegistry];

/** Immutable creation provenance (store-contract.md §4.1). */
export interface KitProvenance {
  source_ids?: string[];
  source_refs?: KitSourceRef[];
  agent: string;
  session_id?: string;
  note?: string;
}

/** One append-only mutation log entry (store-contract.md §4.2). */
export interface KitMutationLogEntry {
  op: string;
  at: string; // ISO-8601
  agent: string;
  note?: string;
  evidence?: Record<string, unknown>;
  // supersede/retire log entries carry additional op-specific top-level fields
  // (e.g. `rationale`, `new_id`, `targetStatus`) alongside `evidence`.
  [key: string]: unknown;
}

/** The common record envelope (store-contract.md §1.1) as returned by `get`/list ops. */
export interface KitRecord {
  id: string;
  type: KitRecordType;
  title: string;
  body: string;
  category: string;
  tags?: string[];
  aliases?: string[]; // Addendum H — human-readable, category-scoped slug aliases
  links?: KitLink[];
  provenance: KitProvenance;
  created_at: string; // ISO-8601
  updated_at: string; // ISO-8601
  expires_at?: string; // ISO-8601 (Addendum J — optional record-carried expiry)
  ttl_seconds?: number; // Addendum J — relative expiry in seconds from created_at
  /** The writer's confidence in the record, from 0 to 1 inclusive. Any record type may carry it. Purge drops it. */
  confidence?: number;
  status?: KitRecordStatus;
  mutation_log?: KitMutationLogEntry[];
}

// ── Mutation input/evidence types (store-contract.md §6, A.5, B.4) ─────────

export interface CreateInput {
  /** Optional new identity. Create refuses an existing record, including a retired one; it is not an upsert. */
  id?: string; // adapter generates when omitted
  type: KitRecordType;
  title: string;
  body: string;
  category: string;
  tags?: string[];
  aliases?: string[];
  links?: KitLink[];
  provenance: KitProvenance;
  expires_at?: string;
  ttl_seconds?: number;
  /**
   * From 0 to 1 inclusive. A value outside the range, NaN, an infinity or a non-number is
   * refused with `MISSING_EVIDENCE`, never clamped. In a proposal candidate it is part of
   * the request-key digest, so a retry under the same request key that changes, adds or drops it is
   * `REQUEST_KEY_CONFLICT`.
   */
  confidence?: number;
}

export interface UpdateFields {
  title?: string;
  body?: string;
  category?: string;
  tags?: string[];
  links?: KitLink[];
  aliases?: string[]; // append-only union with existing aliases (Addendum H.4)
  /** `null`/`""` clears the field (Addendum J.2). */
  expires_at?: string | null;
  ttl_seconds?: number | null;
  /** From 0 to 1 inclusive, validated as on create. `null` clears it. */
  confidence?: number | null;
}

export interface UpdateEvidence {
  agent: string;
  note?: string;
}

export interface LinkEvidence {
  agent: string;
  note?: string;
}

export interface ProposeEvidence {
  agent: string;
  proposal: string;
}

export interface ApplyEvidence {
  agent: string;
  new_body: string;
  rationale: string;
}

export interface RejectEvidence {
  agent: string;
  reason: string;
}

/** Addendum A.6 — `supersede` evidence. */
export interface SupersedeEvidence {
  agent: string;
  rationale: string;
  note?: string;
}

/** Addendum B.5 — `retire` evidence. `implementedByRef` required iff targetStatus === 'implemented'. */
export interface RetireEvidence {
  agent: string;
  rationale: string;
  implementedByRef?: string;
  supersededByRef?: string;
  note?: string;
}

/**
 * `purge` evidence (owner decision, 2026-11-02). `agent` and `rationale` are kept in
 * the tombstone's `purged` mutation-log entry, so neither may carry the erased
 * content itself. `note` is kept too.
 */
export interface PurgeEvidence {
  agent: string;
  /** Retained in audit evidence. Never put erased text here. */
  rationale: string;
  /** Retained in audit evidence. Never put erased text here. */
  note?: string;
}

/** What one `purge` call changed. Lists hold record or proposal ids, never content. */
export interface PurgeResult {
  /** The requested ids that this call tombstoned. */
  purged: string[];
  /** Records tombstoned because every record they rest on is purged. */
  cascaded: string[];
  /**
   * Records that rest on a purged record and on something else. They keep their
   * support and their log records the purge. A host should review these: the
   * store does not scrub survivor content that may reproduce erased content.
   */
  survivors: string[];
  /**
   * Records that link to a purged record without resting on it. Their log records
   * the purge too. Review them like survivors.
   */
  referrers: string[];
  /** Requested ids that were already tombstones; they are left unchanged. */
  alreadyPurged: string[];
  /**
   * Pending create proposals that rested only on erased records. Each is rejected with
   * the purge's rationale and its candidate is erased, so it can never be applied.
   */
  proposalsRejected: string[];
  /**
   * Create proposals, pending or settled, whose candidate was erased because it rested
   * only on erased records or created one. Includes `proposalsRejected`.
   */
  proposalsScrubbed: string[];
  /**
   * Pending create proposals with some erased support and some left. They stay pending
   * but `applyCreate` refuses them with `PURGED`. Rejecting leaves their text stored;
   * use `purgeProposal` if that text must be erased.
   */
  proposalsBlocked: string[];
}

/** What one `purgeProposal` call changed. Holds ids, never content. */
export interface ProposalPurgeResult {
  proposalId: string;
  /**
   * The proposal already carried an `erasure` marker (an earlier `purgeProposal` or
   * `purge` wrote it). Nothing was written, and the first marker is kept.
   */
  alreadyErased: boolean;
  /**
   * Set when this call purged the record an `applied` proposal created, as `purge([record_id])`
   * would: its cascade, survivors and referrers are for the host to review. Absent otherwise,
   * including when the created record was already a tombstone.
   */
  record?: PurgeResult;
}

/**
 * What `purge` would do, from `previewPurge`: the lists of a `PurgeResult` (ids only, never
 * content), computed by the code `purge` runs, and the `revision` to confirm it with.
 */
export interface PurgePreview extends PurgeResult {
  /**
   * An opaque token for the store as previewed. Pass it as `expectedRevision` to `purge`, which
   * refuses with `STALE_REVISION` if any record, proposal or request key has changed since.
   */
  revision: string;
}

/**
 * What `purgeProposal` would do, from `previewPurgeProposal`: the fields of a
 * `ProposalPurgeResult` (`record` is the plan for the record an applied proposal created), plus
 * what a host needs to show it.
 */
export interface ProposalPurgePreview extends ProposalPurgeResult {
  /** As for `PurgePreview.revision`; pass it as `expectedRevision` to `purgeProposal`. */
  revision: string;
  /** The proposal's state now. A `pending` one is settled `rejected` by the erasure. */
  state: CreateProposalState;
  /** The record an `applied` proposal created, whether or not erasing it has anything to purge. */
  recordId?: string;
}

/** Options of the two erasure verbs. */
export interface PurgeOptions {
  /** A `revision` from `previewPurge` or `previewPurgeProposal`. If the store has changed since that preview, nothing is written and `STALE_REVISION` is thrown. */
  expectedRevision?: string;
}

// ── Create proposals (owner decision, 2026-11-03) ──────────────────────────

/** A create proposal is `pending` until a reviewer settles it as `applied` or `rejected`. */
export type CreateProposalState = 'pending' | 'applied' | 'rejected';

/**
 * A staged request to create a record. It is not a record: the candidate is held
 * here whole, and no record exists under its id until the proposal is `applied`.
 * Proposals are never in `get`, lists or the working set; read them through
 * `getProposal` and `listProposals`.
 */
export interface KitCreateProposal {
  /** The proposal's own identity, distinct from the record it may create. */
  id: string;
  state: CreateProposalState;
  /** The complete `CreateInput`, including its provenance, as `create` will receive it. */
  candidate: CreateInput;
  proposer_id: string;
  evidence: ProposeEvidence;
  proposed_at: string; // ISO-8601
  /** SHA-256 key and input digests for keyed proposals; not the caller's key. */
  request_key_hash?: string;
  request_digest?: string;
  /** Digest algorithm and canonicalization version. */
  request_digest_version?: 1;
  /** Content was scrubbed; the retained key cannot be reused. */
  request_key_retired?: true;
  /** Set once the proposal is settled. */
  reviewer_id?: string;
  decided_at?: string; // ISO-8601
  /** `rejected` only: why the reviewer refused it. */
  rationale?: string;
  /** `applied` only: the record this proposal created. */
  record_id?: string;
  /**
   * Set when a `purge` erased this proposal's candidate (owner decision, 2026-11-03):
   * the proposal rested only on erased records, or created one. Also set by
   * `purgeProposal`, which erases one named proposal whatever it rests on. `candidate` is
   * then a content-free stub and `evidence.proposal` is `[purged]`. A `pending` proposal is
   * also settled as `rejected` by the purging agent, with the purge's rationale.
   */
  erasure?: { at: string; agent: string; rationale: string; note?: string };
}

export interface CreateProposalListOptions {
  /** One state or several. Omitted means every state. */
  state?: CreateProposalState | CreateProposalState[];
}

// ── Error contract (store-contract.md §8.1) ────────────────────────────────

export type KnowledgeStoreErrorCode =
  | 'MISSING_EVIDENCE'
  | 'NOT_FOUND'
  | 'AMBIGUOUS_ID'
  | 'SLUG_CONFLICT'
  /** `applyCreate` by the identity that proposed the proposal (owner decision, 2026-11-03). */
  | 'SELF_APPROVAL'
  | 'REQUEST_KEY_CONFLICT'
  /**
   * `purge` or `purgeProposal` was given an `expectedRevision` that no longer matches the store:
   * a record, a proposal or a request key changed after the preview. Nothing was written.
   * Preview again and confirm the new effects.
   */
  | 'STALE_REVISION'
  | 'ROOT_BINDING_MISMATCH'
  /**
   * The operation names a purged record (owner decision, 2026-11-02): a tombstone
   * can be read but never updated, linked to or from, proposed against, superseded
   * or cited as a source, so erased content cannot come back under its identity.
   */
  | 'PURGED'
  /**
   * station#1879: a Station extension BEYOND store-contract §8.1 — the published
   * Kit contract has no notion of a non-writing adapter, so this code is not part
   * of the upstream error vocabulary. Thrown by adapters that implement
   * `KnowledgeStoreAdapter` over a derived, read-only projection (e.g. Station's
   * conversation-history root) from every one of the eight mutation verbs
   * (`create`/`update`/`link`/`propose`/`apply`/`reject`/`supersede`/`retire`/`purge`).
   * `purge` also throws it from an adapter built without `allowPurge: true`.
   * A conformant, non-Station reader of the same contract will not encounter this
   * code, because a non-Station adapter never returns it.
   */
  | 'READ_ONLY';

export interface KnowledgeStoreError extends Error {
  code: KnowledgeStoreErrorCode;
  /** Populated on AMBIGUOUS_ID — the colliding full ids (Addendum H.3). */
  matches?: string[];
}

/** A store that exposes an opaque binding for host composition. */
export interface RootBoundAdapter extends KnowledgeStoreAdapter {
  rootBinding(): string;
}

// ── Adapter contract (store-contract.md §8 + Addendum A.6/B.5, Addendum H) ─

/**
 * The Kit's adapter contract, §8 verbatim (+ A.6 supersede, B.5 retire).
 * Station TYPES this seam but the implementations are Station-owned adapters
 * (`kit-default-store`, `kit-obsidian-store`) that read/write the Kit's published
 * on-disk file format directly — never a deep/internal import of the Kit package
 * (ADR-0001; the Kit's own `exports` map does not expose these modules for import).
 */
export interface KnowledgeStoreAdapter {
  create(record: CreateInput): Promise<string>;
  update(
    id: string,
    fields: UpdateFields,
    evidence: UpdateEvidence,
  ): Promise<void>;
  link(
    sourceId: string,
    links: KitLink[],
    evidence: LinkEvidence,
  ): Promise<void>;
  /**
   * Proposals, application and rejection may target a record of any type
   * (owner decision, 2026-10-13). The target must exist, the proposer must
   * exist, and apply/reject require the proposer's `proposes` link to the
   * target. Mutation-log evidence keeps its stored `concept_id` key.
   */
  propose(
    targetId: string,
    proposerId: string,
    evidence: ProposeEvidence,
  ): Promise<void>;
  apply(
    targetId: string,
    proposerId: string,
    evidence: ApplyEvidence,
  ): Promise<void>;
  reject(
    targetId: string,
    proposerId: string,
    evidence: RejectEvidence,
  ): Promise<void>;
  supersede(
    newId: string,
    supersededIds: string[],
    evidence: SupersedeEvidence,
  ): Promise<void>; // A.6
  retire(
    id: string,
    targetStatus: 'implemented' | 'retired',
    evidence: RetireEvidence,
  ): Promise<void>; // B.5
  /** Addendum H: idOrHandle may be a full id, a slug alias, or an unambiguous ≥8-char id prefix. */
  get(idOrHandle: string): Promise<KitRecord | null>;
  getLinks(
    idOrHandle: string,
  ): Promise<{ forward: KitLink[]; reverse: KitReverseLink[] }>;
  /** Lists the working set by default; see `ListOptions`. */
  listByCategory(
    category: string,
    options?: CategoryListOptions,
  ): Promise<KitRecord[]>;
  listByType(
    type: KitRecordType,
    options?: ListOptions,
  ): Promise<KitRecord[]>;
}

/**
 * The privileged half of the contract, kept off `KnowledgeStoreAdapter` so a host
 * can hand callers the ordinary adapter type and keep this one for its own
 * authorization path. The type split is not enforcement: the adapter also refuses
 * `purge` unless it was built with `allowPurge: true`.
 */
export interface KnowledgeStorePurger {
  /**
   * Erase records and everything that rests only on them (owner decision,
   * 2026-11-02). Supersede stays the default for ordinary change; purge is the
   * explicit, audited, privileged exception, refused unless the host built the
   * adapter with `allowPurge: true`. Targets are exact ids, never handles. Each
   * target and each cascaded record becomes a tombstone that keeps its id, type,
   * created_at, provenance (without its note), link targets and kinds, and mutation
   * history reduced to who, what and when. It drops its title, body, tags, aliases,
   * expiry, link labels, free-text log fields and unknown fields, and its category
   * becomes `purged`. No content hash is kept. Support is `provenance.source_ids`
   * plus `source` links: a record whose support is entirely purged is tombstoned
   * too; one with other support survives and its log records the purge. Every id
   * must exist, or nothing is written. A tombstone is read-only and counts as
   * history in lists.
   */
  purge(ids: string[], evidence: PurgeEvidence, options?: PurgeOptions): Promise<PurgeResult>;
  /**
   * Erase one create proposal by its proposal id (owner decision, 2026-11-04), in any
   * state and whatever its sources rest on. Gated like `purge` (`READ_ONLY` without
   * `allowPurge: true`), with the same evidence. It writes what a purge writes to a
   * proposal: the candidate becomes a content-free stub (no title, body, tags, aliases,
   * link labels, `source_refs` or provenance note), `evidence.proposal` becomes
   * `[purged]`, a settled rationale becomes `[purged]`, and `erasure` records `at`,
   * `agent`, `rationale` and `note`. A `pending` proposal is also settled `rejected` by
   * the erasing agent, so it can never apply. The proposal keeps its id, proposer,
   * state, `record_id` and settlement identity, plus the key hash if it had a
   * `requestKey`; the key is retired, so every later use is refused with
   * `REQUEST_KEY_CONFLICT`. No content hash is kept.
   *
   * An `applied` proposal's content also lives in the record it created, so this purges
   * that record in the same transaction (cascade included, see `PurgeResult`) and
   * reports it in `record`. Unknown or unsafe ids are `NOT_FOUND`. A proposal that is
   * already erased is a no-op (`alreadyErased`). One transaction: an interrupted
   * erasure is rolled back whole or applied whole, never half done.
   */
  purgeProposal(proposalId: string, evidence: PurgeEvidence, options?: PurgeOptions): Promise<ProposalPurgeResult>;
  /**
   * What `purge(ids, …)` would do now, without doing it. Read-only: it writes nothing and needs
   * no `allowPurge`, so a host can show the effects before it confirms. It runs the plan `purge`
   * runs (same cascade, survivors, referrers and proposal handling), so the lists equal the
   * `PurgeResult` of a `purge` that follows with nothing changed between. Ids only, no content.
   * Unknown ids are `NOT_FOUND`, and a store `purge` would refuse (for example a vault with
   * migration artifacts) is refused here too. `revision` identifies the store as previewed; pass it to `purge` as
   * `expectedRevision`.
   */
  previewPurge(ids: string[]): Promise<PurgePreview>;
  /** What `purgeProposal(proposalId, …)` would do now, read-only and with the same guarantees as `previewPurge`. */
  previewPurgeProposal(proposalId: string): Promise<ProposalPurgePreview>;
}

/**
 * Transactional create proposals (owner decision, 2026-11-03). Kept off
 * `KnowledgeStoreAdapter` so existing implementers of that interface need no
 * change. Both bundled adapters implement it. `applyCreate` and `rejectCreate` are
 * distinct from the concept-proposal verbs `apply` and `reject`, which take
 * `(targetId, proposerId, evidence)` and are unchanged.
 */
export interface KnowledgeStoreCreateProposals {
  /**
   * Stage a request to create `candidate`. Returns the proposal id; the proposal is
   * `pending` and no record exists. The candidate is checked against the same
   * required fields as `create`, and `evidence` needs `agent` and `proposal`.
   * `proposerId` is an identity, not a record id. Put session, transcript and
   * source references in `candidate.provenance`: they become the created record's
   * provenance on `applyCreate`. An optional requestKey is store-wide, nonempty
   * and not whitespace-only, must be well-formed Unicode, with a 1024 UTF-8 byte limit. Matching retries return
   * the original ID unless the proposal is erased or its key retired after a scrub; differing input refuses
   * REQUEST_KEY_CONFLICT. After erasure or retirement, all uses of that key are refused with
   * REQUEST_KEY_CONFLICT and the content digest is removed. This holds for `purgeProposal`
   * too: a retry after it never returns the erased proposal's id and never stages again. Use opaque keys.
   * A corrupt retained proposal makes keyed lookup fail with KnowledgeStoreCorruptionError.
   */
  proposeCreate(
    candidate: CreateInput,
    proposerId: string,
    evidence: ProposeEvidence,
    options?: { requestKey?: string },
  ): Promise<string>;
  /**
   * Create the record in one transaction and settle the proposal as `applied`.
   * Returns the new record's id. The record's mutation log carries an
   * `apply-create` entry naming the proposal, its proposer and its evidence.
   * Refuses `SELF_APPROVAL` when `reviewerId` is the proposer, and `NOT_FOUND` for an
   * unknown proposal. A proposal that is not `pending` is refused with
   * `MISSING_EVIDENCE`. Every `create` requirement applies at this point; a failure
   * leaves the proposal `pending` and writes nothing.
   */
  applyCreate(proposalId: string, reviewerId: string): Promise<string>;
  /** Settle a pending proposal as `rejected`, keeping it with `rationale`. Creates no record. */
  rejectCreate(proposalId: string, reviewerId: string, rationale: string): Promise<void>;
  getProposal(proposalId: string): Promise<KitCreateProposal | null>;
  /** The explicit proposals query. Ordered by `proposed_at`, then id. */
  listProposals(options?: CreateProposalListOptions): Promise<KitCreateProposal[]>;
}

/**
 * List options (owner decision, 2026-10-13). Lists return the working set: records
 * that are neither retired nor superseded. `includeHistory: true` adds retired and
 * superseded records. `get` and `getLinks` always reach history. The expiry filter
 * composes with either.
 */
export interface ListOptions {
  includeHistory?: boolean;
  /**
   * Record-expiry filter. `true` keeps only expired records, `false` only
   * unexpired ones; omitted means no expiry filter. Expiry is `expires_at` when
   * set, otherwise `created_at + ttl_seconds`; a record with neither never
   * expires, and a record is expired at its expiry instant.
   */
  stale?: boolean;
  /** The instant to evaluate expiry at, in epoch milliseconds. Defaults to the store clock. */
  now?: number;
  /**
   * @deprecated Use `includeHistory`. Accepted as an alias and translated to
   * `includeHistory: true`, which also includes superseded records.
   */
  includeRetired?: boolean;
}

export interface CategoryListOptions extends ListOptions {
  /** Also match dot-separated subcategories of `category`. */
  prefix?: boolean;
}
