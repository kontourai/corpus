// ── Record envelope (store-contract.md §1, §4, Addendum A.2/A.3, B.1) ──────

export type KitRecordType =
  | 'raw'
  | 'compiled'
  | 'concept'
  | 'snapshot'
  | 'person';

/** Lifecycle status (Addendum B.1). Records without a `status` are treated as `active`. */
export type KitRecordStatus = 'active' | 'implemented' | 'retired';

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
  /** Set once the proposal is settled. */
  reviewer_id?: string;
  decided_at?: string; // ISO-8601
  /** `rejected` only: why the reviewer refused it. */
  rationale?: string;
  /** `applied` only: the record this proposal created. */
  record_id?: string;
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
  | 'ROOT_BINDING_MISMATCH'
  /**
   * station#1879: a Station extension BEYOND store-contract §8.1 — the published
   * Kit contract has no notion of a non-writing adapter, so this code is not part
   * of the upstream error vocabulary. Thrown by adapters that implement
   * `KnowledgeStoreAdapter` over a derived, read-only projection (e.g. Station's
   * conversation-history root) from every one of the eight mutation verbs
   * (`create`/`update`/`link`/`propose`/`apply`/`reject`/`supersede`/`retire`).
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
   * and at most 1024 UTF-8 bytes. Matching retries return the original ID in any
   * state; differing candidate, proposer or evidence refuses REQUEST_KEY_CONFLICT.
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
