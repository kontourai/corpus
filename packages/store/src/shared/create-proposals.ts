/**
 * Create proposals (owner decision, 2026-11-03): a staged request to create a record.
 *
 * A proposal lives in `<storeRoot>/.corpus-proposals/<id>.json`, outside every place a
 * record lives, so no read, list, index or working-set path can see it. It holds the
 * whole candidate until `applyCreate` creates the record in the caller's transaction.
 * Both profiles share this module; each supplies its own `createLocked`.
 */
import { join } from 'node:path';
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
    assertCreateFields(projected, 'proposeCreate');
    freshnessPatch(projected);
    const stored = jsonClone(projected);
    assertCreateFields(stored, 'proposeCreate');
    freshnessPatch(stored);
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

    const id = this.services.ids();
    if (!isSafePathSegment(id) || id.length > 200) {
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
  applyOrigin(proposal: KitCreateProposal, reviewerId: string, at: string): KitMutationLogEntry {
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
      if (proposal.erasure) continue; // already erased by an earlier purge
      const support = supportIds(proposal.candidate);
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
    const text = `${JSON.stringify(proposal, null, 2)}\n`;
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
  if (!PROPOSAL_STATES.includes(value.state as CreateProposalState)) throw corrupt('invalid state');
  if (!isRecord(value.candidate)) throw corrupt('candidate is not an object');
  if (!isNonemptyString(value.proposer_id)) throw corrupt('proposer_id is missing');
  if (!isRecord(value.evidence) || !isNonemptyString(value.evidence.agent) || !isNonemptyString(value.evidence.proposal)) {
    throw corrupt('evidence is invalid');
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
  if (value.erasure !== undefined) {
    const erasure = value.erasure;
    if (!isRecord(erasure) || !isNonemptyString(erasure.agent) || !isNonemptyString(erasure.rationale)
      || !isNonemptyString(erasure.at) || !Number.isFinite(Date.parse(erasure.at))
      || (erasure.note !== undefined && typeof erasure.note !== 'string')) {
      throw corrupt('erasure is invalid');
    }
  }
  if (value.state === 'applied' && !isNonemptyString(value.record_id)) throw corrupt('record_id is missing');
  if (value.state === 'rejected' && !isNonemptyString(value.rationale)) throw corrupt('rationale is missing');
  return value as unknown as KitCreateProposal;
}
