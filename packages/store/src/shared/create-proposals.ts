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
import type {
  CreateInput,
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
    if (sourceRefs !== undefined && JSON.stringify(stored.provenance.source_refs) !== JSON.stringify(sourceRefs)) {
      throw new MissingEvidenceError('proposeCreate: provenance serialization changed source_refs');
    }
    freshnessPatch(stored);
    const key = options?.requestKey;
    if (key !== undefined && (typeof key !== 'string' || !key.trim() || Buffer.byteLength(key) > 1024)) {
      throw new MissingEvidenceError('proposeCreate: requestKey must be a non-empty string of at most 1024 bytes');
    }
    const requestKeyHash = key === undefined ? undefined : hash(key);
    const requestDigest = key === undefined ? undefined : hash(canonical({ candidate: stored, proposerId, evidence: { agent, proposal } }));
    if (requestKeyHash) {
      for (const existing of this.list()) {
        const metadata = existing;
        if (metadata.request_key_hash === requestKeyHash) {
          if (metadata.request_digest !== requestDigest) throw new RequestKeyConflictError();
          return existing.id;
        }
      }
    }
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
  if ((value.request_key_hash !== undefined || value.request_digest !== undefined) &&
      (typeof value.request_key_hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.request_key_hash) ||
       typeof value.request_digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.request_digest))) throw corrupt('invalid request key metadata');
  if (value.request_key_hash !== undefined && value.request_digest_version !== 1) throw corrupt('missing or unsupported request digest version');
  if (value.request_digest_version !== undefined && value.request_digest_version !== 1) throw corrupt('unsupported request digest version');
  if (value.request_digest_version !== undefined && value.request_key_hash === undefined) throw corrupt('request digest version without key');
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
