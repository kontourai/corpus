/**
 * Error contract for `KnowledgeStoreAdapter` implementations (store-contract.md §8.1).
 * Every mutation method MUST throw one of these (never a plain `Error`) so callers can
 * distinguish enforcement failures (`.code`) from unexpected bugs.
 */
import type { KnowledgeStoreErrorCode } from './contracts.js';

export class MissingEvidenceError extends Error {
  readonly code: KnowledgeStoreErrorCode = 'MISSING_EVIDENCE';

  constructor(message: string) {
    super(message);
    this.name = 'MissingEvidenceError';
  }
}

export class KnowledgeRecordNotFoundError extends Error {
  readonly code: KnowledgeStoreErrorCode = 'NOT_FOUND';

  constructor(id: string, isProposal = false) {
    super(isProposal ? `Record not found: ${id}; this id names a proposal. Use purgeProposal to erase it.` : `Record not found: ${id}`);
    this.name = 'KnowledgeRecordNotFoundError';
  }
}

/** A mutation named a tombstone. The message carries the verb and id, never content. */
export class RecordPurgedError extends Error {
  readonly code: KnowledgeStoreErrorCode = 'PURGED';

  constructor(op: string, id: string) {
    super(`${op}: record ${id} was purged`);
    this.name = 'RecordPurgedError';
  }
}

/** The reviewer of a create proposal is its proposer. Carries the verb and ids, never content. */
export class SelfApprovalError extends Error {
  readonly code: KnowledgeStoreErrorCode = 'SELF_APPROVAL';

  constructor(proposalId: string) {
    super(`applyCreate: proposal ${proposalId} cannot be applied by its proposer`);
    this.name = 'SelfApprovalError';
  }
}

export class RequestKeyConflictError extends Error {
  readonly code: KnowledgeStoreErrorCode = 'REQUEST_KEY_CONFLICT';
  constructor(retired = false) { super(retired ? 'proposeCreate: request key is retired after content scrub' : 'proposeCreate: request key already used with different input'); this.name = 'RequestKeyConflictError'; }
}

/**
 * `purge` or `purgeProposal` was given an `expectedRevision` and the store has changed since the
 * preview that returned it. Nothing was written. Preview again, show the new effects, and confirm.
 * The message names no record, proposal or content.
 */
export class StaleRevisionError extends Error {
  readonly code: KnowledgeStoreErrorCode = 'STALE_REVISION';
  constructor(op: string) {
    super(`${op}: the store changed since the preview; preview again and confirm the new effects`);
    this.name = 'StaleRevisionError';
  }
}

export class RootBindingMismatchError extends Error {
  readonly code = 'ROOT_BINDING_MISMATCH' as const;
  constructor() { super('adapter is not bound to the authorized root'); this.name = 'RootBindingMismatchError'; }
}

export class AmbiguousIdError extends Error {
  readonly code: KnowledgeStoreErrorCode = 'AMBIGUOUS_ID';
  readonly matches: string[];

  constructor(input: string, matches: string[]) {
    const shown = matches.slice(0, 5).join(', ');
    super(
      `Ambiguous id prefix "${input}" matches ${matches.length} records: ${shown}${
        matches.length > 5 ? ', …' : ''
      }`,
    );
    this.name = 'AmbiguousIdError';
    this.matches = matches.slice();
  }
}

export class SlugConflictError extends Error {
  readonly code: KnowledgeStoreErrorCode = 'SLUG_CONFLICT';

  constructor(slug: string, owner: string) {
    super(`Slug alias "${slug}" already assigned to record ${owner}`);
    this.name = 'SlugConflictError';
  }
}

/**
 * Thrown by every mutation verb on a read-only projection adapter (archive#1879,
 * e.g. the conversation-history root) — a Station extension beyond
 * store-contract.md §8.1 (see `KnowledgeStoreErrorCode`'s `READ_ONLY` doc comment).
 * `op` is the verb the caller attempted (`create`, `update`, `link`, `propose`,
 * `apply`, `reject`, `supersede`, `retire`), so the message and any caller
 * (`knowledge-record-routes.ts`'s 405 mapping) always name what was rejected.
 */
export class ReadOnlyStoreError extends Error {
  readonly code: KnowledgeStoreErrorCode = 'READ_ONLY';

  constructor(op: string, reason = 'this store is a read-only projection.') {
    super(`${op} rejected: ${reason}`);
    this.name = 'ReadOnlyStoreError';
  }
}

/** Station-local file authority changed outside the serialized mutation. */
export class KnowledgeStoreConflictError extends Error {
  constructor(path: string) {
    super(`Knowledge store changed concurrently: ${path}`);
    this.name = 'KnowledgeStoreConflictError';
  }
}

/** Authoritative bytes or the retained transaction journal cannot be trusted. */
export class KnowledgeStoreCorruptionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'KnowledgeStoreCorruptionError';
  }
}

/** The file authority could not be read, locked, published, or recovered. */
export class KnowledgeStoreUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super('Knowledge store storage is unavailable', options);
    this.name = 'KnowledgeStoreUnavailableError';
  }
}

/** Distinguishes intentional store-contract outcomes from ambient I/O codes. */
export function isKnowledgeStoreError(error: unknown): error is Error {
  return (
    error instanceof MissingEvidenceError ||
    error instanceof KnowledgeRecordNotFoundError ||
    error instanceof AmbiguousIdError ||
    error instanceof SlugConflictError ||
    error instanceof RecordPurgedError ||
    error instanceof SelfApprovalError ||
    error instanceof RequestKeyConflictError ||
    error instanceof StaleRevisionError ||
    error instanceof RootBindingMismatchError ||
    error instanceof ReadOnlyStoreError ||
    error instanceof KnowledgeStoreConflictError ||
    error instanceof KnowledgeStoreCorruptionError ||
    error instanceof KnowledgeStoreUnavailableError
  );
}
