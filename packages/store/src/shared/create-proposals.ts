/**
 * Create proposals (owner decision, 2026-11-03): a staged request to create a record.
 *
 * A proposal lives in `<storeRoot>/.corpus-proposals/<id>.json`, outside every place a
 * record lives, so no read, list, index or working-set path can see it. It holds the
 * whole candidate until `applyCreate` creates the record in the caller's transaction.
 * Both profiles share this module; each supplies its own `createLocked`.
 */
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  CreateInput,
  PurgeEvidence,
  CreateProposalListOptions,
  CreateProposalState,
  KitCreateProposal,
  KitMutationLogEntry,
  ProposeEvidence,
} from '../contracts.js';
import {
  KnowledgeRecordNotFoundError,
  KnowledgeStoreCorruptionError,
  MissingEvidenceError,
  SelfApprovalError,
  RequestKeyConflictError,
} from '../errors.js';
import { isRecord } from '../is-record.js';
import { isSafePathSegment } from '../path-safety.js';
import type { ResolvedServices } from '../services.js';
import { assertCreateFields } from './create-input.js';
import { freshnessPatch } from './freshness.js';
import type { KnowledgeFileTransactions } from './file-transactions.js';
import { PURGED_CATEGORY, PURGED_TITLE, supportIds } from './purge.js';

/**
 * Dot-named so it can never be a category directory (categories match `[a-z0-9_-]+`):
 * a vault may hold ordinary notes in a `proposals` category.
 */
export const PROPOSALS_DIRECTORY = '.corpus-proposals';
export const PROPOSAL_STATES: readonly CreateProposalState[] = ['pending', 'applied', 'rejected'];
/** The mutation-log op the created record carries (see `applyOrigin`). */
export const APPLY_CREATE_OP = 'apply-create';
const MAX_PROPOSAL_BYTES = 16 * 1024 * 1024;
/** Room left for the fields `applyCreate` and `rejectCreate` add, so a proposal that fits can always be settled. */
const SETTLEMENT_HEADROOM_BYTES = 64 * 1024;
/** Caps on what settlement adds (reviewer id, rationale, record id), so the headroom above always holds. */
const MAX_REVIEWER_BYTES = 1024;
/**
 * Stands in for the reviewer when a profile sizes the record before it is applied. DEL is one
 * JSON byte but four YAML bytes (`\x7F`), the largest expansion a reviewer id can have, and
 * 1022 of them are the most `MAX_REVIEWER_BYTES` of serialized JSON allows.
 */
const WORST_CASE_REVIEWER = '\u007f'.repeat(MAX_REVIEWER_BYTES - 2);
/** `stage` refuses a longer proposal id. */
const MAX_PROPOSAL_ID_LENGTH = 200;
/** All digits: YAML quotes a digit string, so this is the dearest 200-character id to write. */
const PROPOSAL_ID_STAND_IN = '1'.repeat(MAX_PROPOSAL_ID_LENGTH);
/** Every ISO timestamp has this length; sizing must not read the clock. */
const SIZING_TIMESTAMP = '1970-01-01T00:00:00.000Z';
/** An explicit candidate id lands in the settled proposal as `record_id`. */
const MAX_CANDIDATE_ID_BYTES = 1024;
const MAX_RATIONALE_BYTES = 16 * 1024;
const serializedBytes = (value: string) => Buffer.byteLength(JSON.stringify(value));
const CANDIDATE_KEYS = [
  'id', 'type', 'title', 'body', 'category', 'tags', 'aliases', 'links',
  'provenance', 'expires_at', 'ttl_seconds',
] as const;

const isNonemptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

export class CreateProposals {
  private readonly directory: string;

  constructor(
    private readonly files: KnowledgeFileTransactions,
    root: string,
    private readonly services: ResolvedServices,
  ) {
    this.directory = join(root, PROPOSALS_DIRECTORY);
  }

  private pathOf(id: string): string {
    return join(this.directory, `${id}.json`);
  }

  // ── reads (call inside a read or mutation) ───────────────────────────────

  get(id: string): KitCreateProposal | null {
    if (!isSafePathSegment(id)) return null;
    const path = this.pathOf(id);
    const text = this.files.readText(path, MAX_PROPOSAL_BYTES);
    return text === null ? null : parseProposal(text, path, id);
  }

  list(options: CreateProposalListOptions = {}): KitCreateProposal[] {
    const wanted = parseStates(options);
    const proposals: KitCreateProposal[] = [];
    for (const name of this.files.listFileNames(this.directory)) {
      if (!name.endsWith('.json')) continue;
      const proposal = this.get(name.slice(0, -'.json'.length));
      if (proposal && (!wanted || wanted.includes(proposal.state))) proposals.push(proposal);
    }
    return proposals.sort(
      (a, b) => a.proposed_at.localeCompare(b.proposed_at) || a.id.localeCompare(b.id),
    );
  }

  // ── writes (call inside a mutation) ──────────────────────────────────────

  /** Validate and store a pending proposal. Returns its id. */
  stage(
    candidate: CreateInput,
    proposerId: string,
    evidence: ProposeEvidence,
    recordExists: (id: string) => boolean,
    options?: { requestKey?: string },
    /**
     * A profile's own limit on the record the candidate would become; throws to refuse. It gets
     * the `apply-create` entry the record would start with, with stand-ins for the reviewer and
     * proposal ids that are only known at apply. It is a margin, not a guarantee: `applyCreate`
     * checks again.
     */
    assertFits?: (candidate: CreateInput, origin: KitMutationLogEntry) => void,
    /** Purge: a candidate may not cite an erased record as a source. Runs before the profile's own checks. */
    guard?: (candidate: CreateInput) => void,
  ): string {
    if (!isNonemptyString(proposerId)) {
      throw new MissingEvidenceError('proposeCreate: missing required field: proposerId');
    }
    // Read each field once: what is validated is what is stored, even for an accessor.
    const agent: unknown = evidence?.agent;
    const proposal: unknown = evidence?.proposal;
    if (!isNonemptyString(agent)) {
      throw new MissingEvidenceError('proposeCreate: missing required evidence field: agent');
    }
    if (!isNonemptyString(proposal)) {
      throw new MissingEvidenceError('proposeCreate: missing required evidence field: proposal');
    }
    if (!isRecord(candidate)) {
      throw new MissingEvidenceError('proposeCreate: candidate must be an object');
    }
    // Validate the candidate as read, then again as stored: JSON turns NaN into null, and
    // apply must see exactly the candidate that was checked.
    const projected = projectCandidate(candidate as unknown as CreateInput);
    const sourceRefs = assertCreateFields(projected, 'proposeCreate');
    if (sourceRefs !== undefined) projected.provenance = { ...projected.provenance, source_refs: sourceRefs };
    freshnessPatch(projected);
    const stored = jsonClone(projected);
    assertCreateFields(stored, 'proposeCreate');
    if (JSON.stringify(stored.provenance.source_refs) !== JSON.stringify(sourceRefs)) {
      throw new MissingEvidenceError('proposeCreate: provenance serialization changed source_refs');
    }
    freshnessPatch(stored);
    // Purge reads a candidate's provenance and links to decide what rests on what, and
    // `create` would quietly turn a number into text. A proposal states them as text.
    const problem = candidateShapeProblem(stored);
    if (problem) throw new MissingEvidenceError(`proposeCreate: ${problem}`);
    // The reader refuses a link with an empty target or kind, so `create` would write a record
    // nothing can read back (kontourai/corpus#56). Staging does not hand that to apply.
    if ((stored.links ?? []).some((link) => link.target_id === '' || link.kind === '')) {
      throw new MissingEvidenceError('proposeCreate: candidate links need a non-empty target_id and kind');
    }
    const key = options?.requestKey;
    if (key !== undefined && (typeof key !== 'string' || !key.trim() || Buffer.byteLength(key) > 1024 || Buffer.from(key, 'utf8').toString('utf8') !== key)) {
      throw new MissingEvidenceError('proposeCreate: requestKey must be a well-formed string, not empty or whitespace-only, and at most 1024 UTF-8 bytes');
    }
    const requestKeyHash = key === undefined ? undefined : hash(key);
    const existing = requestKeyHash ? this.list().find((proposal) => proposal.request_key_hash === requestKeyHash) : undefined;
    // Erased proposals retain only the key identity; do not compute or compare a
    // digest of the caller's content for a key whose proposal was erased.
    if (existing && (Object.hasOwn(existing, 'erasure') || existing.request_key_retired === true)) throw new RequestKeyConflictError(true);
    const requestDigest = key === undefined ? undefined : hash(canonical({ candidate: stored, proposerId, evidence: { agent, proposal } }));
    if (existing) {
      if (existing.request_digest !== requestDigest) throw new RequestKeyConflictError();
      return existing.id;
    }
    // A candidate may not cite an erased record as a source (purge, 2026-11-03).
    guard?.(stored);
    // Id rules belong to each profile's create, which runs at apply. Here only a
    // type error and an id already taken are caught early.
    if (stored.id !== undefined) {
      if (typeof stored.id !== 'string' || stored.id === '') {
        throw new MissingEvidenceError('proposeCreate: candidate id must be a non-empty string');
      }
      if (serializedBytes(stored.id) > MAX_CANDIDATE_ID_BYTES) {
        throw new MissingEvidenceError(`proposeCreate: candidate id exceeds ${MAX_CANDIDATE_ID_BYTES} bytes`);
      }
      if (recordExists(stored.id)) {
        throw new MissingEvidenceError('proposeCreate: record id already exists');
      }
    }
    assertFits?.(
      stored,
      this.applyOrigin(
        { id: PROPOSAL_ID_STAND_IN, proposer_id: proposerId, evidence: { agent, proposal } },
        WORST_CASE_REVIEWER,
        SIZING_TIMESTAMP,
      ),
    );

    const id = this.services.ids();
    if (!isSafePathSegment(id) || id.length > MAX_PROPOSAL_ID_LENGTH) {
      throw new MissingEvidenceError('proposeCreate: proposal id must be a safe single path segment');
    }
    if (this.get(id)) throw new MissingEvidenceError('proposeCreate: proposal id already exists');

    this.write(
      {
        id,
        state: 'pending',
        candidate: stored,
        proposer_id: proposerId,
        evidence: { agent, proposal },
        proposed_at: new Date(this.services.clock()).toISOString(),
        ...(requestKeyHash ? { request_key_hash: requestKeyHash, request_digest: requestDigest, request_digest_version: 1 as const } : {}),
      },
      MAX_PROPOSAL_BYTES - SETTLEMENT_HEADROOM_BYTES,
    );
    return id;
  }

  /**
   * The proposal `applyCreate` or `rejectCreate` may settle: it exists, is pending, and, for
   * `applyCreate`, was not proposed by `reviewerId`.
   */
  pendingFor(op: 'applyCreate' | 'rejectCreate', proposalId: string, reviewerId: string): KitCreateProposal {
    if (!isNonemptyString(reviewerId)) {
      throw new MissingEvidenceError(`${op}: missing required field: reviewerId`);
    }
    if (serializedBytes(reviewerId) > MAX_REVIEWER_BYTES) {
      throw new MissingEvidenceError(`${op}: reviewerId exceeds ${MAX_REVIEWER_BYTES} bytes`);
    }
    const proposal = this.get(proposalId);
    if (!proposal) throw new KnowledgeRecordNotFoundError(proposalId);
    if (proposal.state !== 'pending') {
      throw new MissingEvidenceError(`${op}: proposal ${proposalId} is ${proposal.state}, not pending`);
    }
    if (op === 'applyCreate' && proposal.proposer_id === reviewerId) {
      throw new SelfApprovalError(proposalId);
    }
    return proposal;
  }

  /** The `apply-create` log entry the created record starts with: its link back to the proposal. */
  applyOrigin(
    proposal: Pick<KitCreateProposal, 'id' | 'proposer_id' | 'evidence'>,
    reviewerId: string,
    at: string,
  ): KitMutationLogEntry {
    return {
      op: APPLY_CREATE_OP,
      at,
      agent: reviewerId,
      evidence: {
        proposal_id: proposal.id,
        proposer_id: proposal.proposer_id,
        proposal_evidence: { ...proposal.evidence },
      },
    };
  }

  settle(
    proposal: KitCreateProposal,
    outcome:
      | { state: 'applied'; reviewerId: string; at: string; recordId: string }
      | { state: 'rejected'; reviewerId: string; at: string; rationale: string },
  ): void {
    this.write({
      ...proposal,
      state: outcome.state,
      reviewer_id: outcome.reviewerId,
      decided_at: outcome.at,
      ...(outcome.state === 'applied'
        ? { record_id: outcome.recordId }
        : { rationale: outcome.rationale }),
    });
  }

  /**
   * Purge (owner decision, 2026-11-03): erase every proposal that carries erased content.
   *
   * A proposal carries its whole candidate in every state, so the candidate is erased when
   * it rests only on erased records (its support, as for a record, is `provenance.source_ids`
   * plus `source` links, with at least one newly erased) or when `applyCreate` created a
   * record that is now erased. The candidate becomes a content-free stub that keeps its type,
   * provenance and link targets, `evidence.proposal` becomes `[purged]`, and `erasure` records
   * who erased it and why. A pending one is also settled as `rejected` by the purging agent
   * with the purge's rationale, so it can never apply. A proposal with other support left stays
   * as it is, except that link labels aimed at erased records are dropped; a pending one of
   * those is reported as blocked, because `applyCreate` will refuse the erased support.
   * `newlyErased` holds the records this purge erases; `allErased` also holds earlier tombstones.
   */
  erase(
    newlyErased: ReadonlySet<string>,
    allErased: ReadonlySet<string>,
    evidence: PurgeEvidence,
    at: string,
  ): { rejected: string[]; scrubbed: string[]; blocked: string[] } {
    const rejected: string[] = [];
    const scrubbed: string[] = [];
    const blocked: string[] = [];
    for (const proposal of this.list()) {
      assertErasable(proposal);
      if (proposal.erasure) continue; // already erased by an earlier purge
      // A candidate's id is not a record yet, so it is not removed from its own support.
      const support = supportIds({ provenance: proposal.candidate.provenance, links: proposal.candidate.links });
      const createdErased = proposal.state === 'applied' && proposal.record_id !== undefined && newlyErased.has(proposal.record_id);
      const restsOnErased =
        support.some((id) => newlyErased.has(id)) && support.every((id) => allErased.has(id));
      if (createdErased || restsOnErased) {
        const pending = proposal.state === 'pending';
        this.write({
          ...proposal,
          candidate: stubCandidate(proposal.candidate),
          evidence: { agent: proposal.evidence.agent, proposal: PURGED_TITLE },
          erasure: { at, agent: evidence.agent, rationale: evidence.rationale, ...(evidence.note ? { note: evidence.note } : {}) },
          ...(pending
            ? { state: 'rejected' as const, reviewer_id: evidence.agent, decided_at: at, rationale: evidence.rationale }
            : proposal.state === 'rejected'
              ? { rationale: PURGED_TITLE }
              : {}),
        });
        (pending ? rejected : scrubbed).push(proposal.id);
        if (pending) scrubbed.push(proposal.id);
        continue;
      }
      const links = proposal.candidate.links;
      if (links?.some((link) => newlyErased.has(link.target_id) && link.label !== undefined)) {
        this.write({
          ...proposal,
          candidate: {
            ...proposal.candidate,
            links: links.map((link) => {
              if (!newlyErased.has(link.target_id) || link.label === undefined) return link;
              const { label: _label, ...unlabeled } = link;
              return unlabeled;
            }),
          },
        });
      }
      if (proposal.state === 'pending' && support.some((id) => newlyErased.has(id))) blocked.push(proposal.id);
    }
    return { rejected, scrubbed, blocked };
  }

  /** The rationale `rejectCreate` stores, validated. */
  static rationale(value: unknown): string {
    if (!isNonemptyString(value)) {
      throw new MissingEvidenceError('rejectCreate: missing required field: rationale');
    }
    if (serializedBytes(value) > MAX_RATIONALE_BYTES) {
      throw new MissingEvidenceError(`rejectCreate: rationale exceeds ${MAX_RATIONALE_BYTES} bytes`);
    }
    return value;
  }

  /** Refuses a proposal the reader would not load, so one accepted proposal cannot break the queries. */
  private write(proposal: KitCreateProposal, maxBytes = MAX_PROPOSAL_BYTES): void {
    // Purge (#41) writes an erasure marker through this shared seam. Never
    // persist a content-derived request digest alongside an erased proposal.
    const erased = Object.hasOwn(proposal, 'erasure');
    // A partial purge can remove a link label without setting full erasure. If
    // the hashed content changed, retire the key and drop the old digest too.
    const contentChanged = proposal.request_digest !== undefined &&
      proposal.request_digest !== hash(canonical({ candidate: proposal.candidate, proposerId: proposal.proposer_id, evidence: proposal.evidence }));
    const retireKey = erased || proposal.request_key_retired === true || contentChanged;
    const serialized = retireKey ? { ...proposal, request_digest: undefined, request_digest_version: undefined, ...(proposal.request_key_hash ? { request_key_retired: true as const } : {}) } : proposal;
    const text = `${JSON.stringify(serialized, null, 2)}\n`;
    if (Buffer.byteLength(text) > maxBytes) {
      throw new MissingEvidenceError(`create proposal exceeds ${maxBytes} bytes`);
    }
    this.files.writeText(this.pathOf(proposal.id), text);
  }
}

/**
 * The candidate's `CreateInput` fields, each read once. `create` reads fields normally but
 * reads the freshness fields as own properties only (`freshnessPatch`), so this does too.
 */
function projectCandidate(candidate: CreateInput): CreateInput {
  const source = candidate as unknown as Record<string, unknown>;
  const ownOnly = new Set(['expires_at', 'ttl_seconds']);
  const projected: Record<string, unknown> = {};
  for (const key of CANDIDATE_KEYS) {
    if (ownOnly.has(key) && !Object.hasOwn(source, key)) continue;
    const value = source[key];
    if (value !== undefined) projected[key] = value;
  }
  return projected as unknown as CreateInput;
}

/**
 * What purge needs of a candidate, stated once for staging and for purge: an agent that is
 * a non-empty string, optional text `session_id` and `note`, `source_ids` and `links` that are
 * null, missing or well-formed. Returns what is wrong, or null.
 */
function candidateShapeProblem(candidate: CreateInput): string | null {
  const provenance = candidate.provenance as unknown;
  if (!isRecord(provenance) || typeof provenance.agent !== 'string' || provenance.agent === '') {
    return 'candidate provenance.agent must be a non-empty string';
  }
  for (const key of ['session_id', 'note'] as const) {
    if (provenance[key] != null && typeof provenance[key] !== 'string') return `candidate provenance.${key} must be a string`;
  }
  const sourceIds = provenance.source_ids;
  if (sourceIds != null && (!Array.isArray(sourceIds) || sourceIds.some((id) => typeof id !== 'string'))) {
    return 'candidate provenance.source_ids must be an array of strings';
  }
  const links = candidate.links as unknown;
  if (
    links != null &&
    (!Array.isArray(links) ||
      links.some((link) => !isRecord(link) || typeof link.target_id !== 'string' || typeof link.kind !== 'string' || (link.label != null && typeof link.label !== 'string')))
  ) {
    return 'candidate links must be an array of links with text target_id and kind';
  }
  if (typeof candidate.type !== 'string') return 'candidate type must be a string';
  return null;
}

/**
 * Purge decides from the candidate's provenance and links and trusts a stored `erasure`
 * marker, so a proposal that does not have the shape those decisions need stops the purge
 * instead of being skipped: a skipped proposal would keep erased content readable.
 *
 * The shape is what `proposeCreate` and `create` accept, not more: an agent is any non-empty
 * string, and a null or missing `links` or `source_ids` is empty. An erased proposal must be
 * exactly what `erase` writes, field for field, so a marker laid over retained content is
 * corrupt rather than trusted.
 */
function assertErasable(proposal: KitCreateProposal): void {
  const corrupt = (reason: string) =>
    new KnowledgeStoreCorruptionError(`create proposal ${proposal.id} is corrupt: ${reason}`);
  const { candidate } = proposal;
  const problem = candidateShapeProblem(candidate);
  if (problem) throw corrupt(problem);
  if (!proposal.erasure) return;
  const { erasure } = proposal;
  const settled =
    proposal.state !== 'pending' &&
    isDeepStrictEqual(candidate, stubCandidate(candidate)) &&
    isDeepStrictEqual(proposal.evidence, { agent: proposal.evidence.agent, proposal: PURGED_TITLE }) &&
    (proposal.state === 'applied'
      ? proposal.rationale === undefined
      : proposal.rationale === PURGED_TITLE || proposal.rationale === erasure.rationale);
  if (!settled) throw corrupt('an erased proposal is not what a purge writes');
}

/** What is left of a candidate once it is erased: identity, provenance and link targets, no content. */
function stubCandidate(candidate: CreateInput): CreateInput {
  const { provenance } = candidate;
  return {
    ...(candidate.id !== undefined ? { id: candidate.id } : {}),
    type: candidate.type,
    title: PURGED_TITLE,
    body: '',
    category: PURGED_CATEGORY,
    provenance: {
      agent: provenance.agent,
      ...(provenance.session_id ? { session_id: provenance.session_id } : {}),
      ...(provenance.source_ids?.length ? { source_ids: [...provenance.source_ids] } : {}),
    },
    links: (candidate.links ?? []).map(({ target_id, kind }) => ({ target_id, kind })),
  };
}

function jsonClone(candidate: CreateInput): CreateInput {
  try {
    return JSON.parse(JSON.stringify(candidate)) as CreateInput;
  } catch (error) {
    throw new MissingEvidenceError(
      `proposeCreate: candidate must be JSON-serializable (${(error as Error).message})`,
    );
  }
}

function parseStates(options: CreateProposalListOptions): CreateProposalState[] | undefined {
  if (options === null || typeof options !== 'object') {
    throw new MissingEvidenceError('listProposals: options must be an object');
  }
  if (options.state === undefined) return undefined;
  const states = Array.isArray(options.state) ? options.state : [options.state];
  for (const state of states) {
    if (!PROPOSAL_STATES.includes(state)) {
      throw new MissingEvidenceError(
        `listProposals: state must be one of ${PROPOSAL_STATES.join(', ')}; got: ${JSON.stringify(state)}`,
      );
    }
  }
  return states;
}

function parseProposal(text: string, path: string, id: string): KitCreateProposal {
  const corrupt = (reason: string, cause?: unknown) =>
    new KnowledgeStoreCorruptionError(`${path}: create proposal is corrupt: ${reason}`, cause ? { cause } : undefined);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw corrupt('not valid JSON', error);
  }
  if (!isRecord(value)) throw corrupt('not an object');
  if (value.id !== id) throw corrupt('id does not match its filename');
  const erased = Object.hasOwn(value, 'erasure');
  if (value.request_key_retired !== undefined && value.request_key_retired !== true) throw corrupt('invalid retired request key');
  if (value.request_key_retired === true && value.request_key_hash === undefined) throw corrupt('retired request key has no identity');
  if (erased) {
    const erasure = value.erasure;
    if (!isRecord(erasure) || !isNonemptyString(erasure.agent) || !isNonemptyString(erasure.rationale) ||
        !isNonemptyString(erasure.at) || !Number.isFinite(Date.parse(erasure.at)) ||
        (erasure.note !== undefined && typeof erasure.note !== 'string')) throw corrupt('erasure is invalid');
  }
  if (erased || value.request_key_retired === true) {
    if (value.request_digest !== undefined || value.request_digest_version !== undefined) throw corrupt('erased proposal retains request digest');
    if (value.request_key_hash !== undefined && (typeof value.request_key_hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.request_key_hash))) throw corrupt('invalid request key metadata');
  } else {
    if ((value.request_key_hash !== undefined || value.request_digest !== undefined) &&
        (typeof value.request_key_hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.request_key_hash) ||
         typeof value.request_digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.request_digest))) throw corrupt('invalid request key metadata');
    if (value.request_key_hash !== undefined && value.request_digest_version !== 1) throw corrupt('missing or unsupported request digest version');
    if (value.request_digest_version !== undefined && value.request_digest_version !== 1) throw corrupt('unsupported request digest version');
    if (value.request_digest_version !== undefined && value.request_key_hash === undefined) throw corrupt('request digest version without key');
  }
  if (!PROPOSAL_STATES.includes(value.state as CreateProposalState)) throw corrupt('invalid state');
  if (!isRecord(value.candidate)) throw corrupt('candidate is not an object');
  if (!isNonemptyString(value.proposer_id)) throw corrupt('proposer_id is missing');
  if (!isRecord(value.evidence) || !isNonemptyString(value.evidence.agent) || !isNonemptyString(value.evidence.proposal)) {
    throw corrupt('evidence is invalid');
  }
  if (!erased && value.request_key_retired !== true && typeof value.request_digest === 'string') {
    const evidence = value.evidence as Record<string, unknown>;
    const actual = hash(canonical({ candidate: value.candidate, proposerId: value.proposer_id, evidence: { agent: evidence.agent, proposal: evidence.proposal } }));
    if (actual !== value.request_digest) throw corrupt('request digest does not match proposal content');
  }
  if (!isNonemptyString(value.proposed_at) || !Number.isFinite(Date.parse(value.proposed_at))) {
    throw corrupt('proposed_at is invalid');
  }
  const settled = value.state !== 'pending';
  if (settled) {
    if (!isNonemptyString(value.reviewer_id)) throw corrupt('reviewer_id is missing');
    if (!isNonemptyString(value.decided_at) || !Number.isFinite(Date.parse(value.decided_at))) {
      throw corrupt('decided_at is invalid');
    }
  }
  if (value.state === 'applied' && !isNonemptyString(value.record_id)) throw corrupt('record_id is missing');
  if (value.state === 'rejected' && !isNonemptyString(value.rationale)) throw corrupt('rationale is missing');
  return value as unknown as KitCreateProposal;
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
