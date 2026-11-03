/**
 * Create proposals (owner decision, 2026-11-03): a staged request to create a record.
 *
 * A proposal lives in `<storeRoot>/.corpus-proposals/<id>.json`, outside every place a
 * record lives, so no read, list, index or working-set path can see it. It holds the
 * whole candidate until `apply` creates the record in the caller's transaction.
 * Both profiles share this module; each supplies its own `createLocked`.
 */
import { join } from 'node:path';
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
/** Room left for the fields `apply` and `reject` add, so a proposal that fits can always be settled. */
const SETTLEMENT_HEADROOM_BYTES = 64 * 1024;
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
  ): string {
    if (!isNonemptyString(proposerId)) {
      throw new MissingEvidenceError('proposeCreate: missing required field: proposerId');
    }
    if (!isNonemptyString(evidence?.agent)) {
      throw new MissingEvidenceError('proposeCreate: missing required evidence field: agent');
    }
    if (!isNonemptyString(evidence?.proposal)) {
      throw new MissingEvidenceError('proposeCreate: missing required evidence field: proposal');
    }
    if (!isRecord(candidate)) {
      throw new MissingEvidenceError('proposeCreate: candidate must be an object');
    }
    // Validate what is stored, so apply sees exactly the candidate that was checked.
    const stored = cloneCandidate(candidate as unknown as CreateInput);
    assertCreateFields(stored, 'proposeCreate');
    freshnessPatch(stored);
    // Id rules belong to each profile's create, which runs at apply. Here only a
    // type error and an id already taken are caught early.
    if (stored.id !== undefined) {
      if (typeof stored.id !== 'string' || stored.id === '') {
        throw new MissingEvidenceError('proposeCreate: candidate id must be a non-empty string');
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
        evidence: { agent: evidence.agent, proposal: evidence.proposal },
        proposed_at: new Date(this.services.clock()).toISOString(),
      },
      MAX_PROPOSAL_BYTES - SETTLEMENT_HEADROOM_BYTES,
    );
    return id;
  }

  /**
   * The proposal `apply` or `reject` may settle: it exists, is pending, and, for
   * `apply`, was not proposed by `reviewerId`.
   */
  pendingFor(op: 'apply' | 'reject', proposalId: string, reviewerId: string): KitCreateProposal {
    if (!isNonemptyString(reviewerId)) {
      throw new MissingEvidenceError(`${op}: missing required field: reviewerId`);
    }
    const proposal = this.get(proposalId);
    if (!proposal) throw new KnowledgeRecordNotFoundError(proposalId);
    if (proposal.state !== 'pending') {
      throw new MissingEvidenceError(`${op}: proposal ${proposalId} is ${proposal.state}, not pending`);
    }
    if (op === 'apply' && proposal.proposer_id === reviewerId) {
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

  /** The rationale `reject` stores, validated. */
  static rationale(value: unknown): string {
    if (!isNonemptyString(value)) {
      throw new MissingEvidenceError('reject: missing required field: rationale');
    }
    return value;
  }

  /** Refuses a proposal the reader would not load, so one accepted proposal cannot break the queries. */
  private write(proposal: KitCreateProposal, maxBytes = MAX_PROPOSAL_BYTES): void {
    const text = `${JSON.stringify(proposal, null, 2)}\n`;
    if (Buffer.byteLength(text) > maxBytes) {
      throw new MissingEvidenceError(`proposeCreate: proposal exceeds ${maxBytes} bytes`);
    }
    this.files.writeText(this.pathOf(proposal.id), text);
  }
}

function cloneCandidate(candidate: CreateInput): CreateInput {
  const source = candidate as unknown as Record<string, unknown>;
  // Own properties only, as `create` reads them: an inherited field is not part of the candidate.
  const projected = Object.fromEntries(
    CANDIDATE_KEYS.filter((key) => Object.hasOwn(source, key) && source[key] !== undefined).map((key) => [key, source[key]]),
  );
  try {
    return JSON.parse(JSON.stringify(projected)) as CreateInput;
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
  if (value.state === 'applied' && !isNonemptyString(value.record_id)) throw corrupt('record_id is missing');
  if (value.state === 'rejected' && !isNonemptyString(value.rationale)) throw corrupt('rationale is missing');
  return value as unknown as KitCreateProposal;
}
