import { createHash, createHmac } from 'node:crypto';
import { join } from 'node:path';
import type { KitRecord, ReviewedConfidenceReceipt, ReviewedConfidenceRequest, ReviewedConfidenceSnapshot } from '../contracts.js';
import { KnowledgeStoreCorruptionError, MissingEvidenceError, RequestKeyConflictError, RootBindingMismatchError, StaleRevisionError } from '../errors.js';
import { isSafePathSegment } from '../path-safety.js';
import type { KnowledgeFileTransactions } from './file-transactions.js';

const HEX = /^[a-f0-9]{64}$/;
const REVISION = /^record-rev1:[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_RECEIPT = 64 * 1024;
export const REVIEWED_CONFIDENCE_DIRECTORY = '.corpus-reviewed-confidence';
type ActiveReceipt = { version: 1; key: string; target: string; evidence: string[]; input: string; appliedAt: string };
type RetiredReceipt = { version: 1; key: string; retired: true };
type StoredReceipt = ActiveReceipt | RetiredReceipt;

/** Digest the exact score change and evidence the host presents for review. */
export function reviewedConfidenceCandidateDigest(value: Pick<ReviewedConfidenceRequest, 'rootBinding' | 'recordId' | 'revision' | 'oldConfidence' | 'newConfidence' | 'evidence'>): string {
  const tuple = ['corpus-reviewed-confidence-candidate-v1', value.rootBinding, value.recordId, value.revision, value.oldConfidence, value.newConfidence, value.evidence.map(({ id, revision }) => [id, revision])];
  return `sha256:${createHash('sha256').update(JSON.stringify(tuple)).digest('hex')}`;
}

/** Copy and validate caller-owned values before taking the lock. */
export function reviewedRequest(value: ReviewedConfidenceRequest): ReviewedConfidenceRequest {
  try { return copyReviewedRequest(value); }
  catch (error) {
    if (error instanceof MissingEvidenceError) throw error;
    throw new MissingEvidenceError('reviewed confidence: invalid request');
  }
}

function copyReviewedRequest(value: ReviewedConfidenceRequest): ReviewedConfidenceRequest {
  if (!value || typeof value !== 'object') throw new MissingEvidenceError('reviewed confidence: request is required');
  const { rootBinding, recordId, revision, oldConfidence, newConfidence, candidateDigest, authorizationDigest, requestKey, agent } = value;
  const evidence = value.evidence;
  const evidenceLength = Array.isArray(evidence) ? evidence.length : -1;
  const score = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;
  const text = (x: unknown, max: number): x is string => typeof x === 'string' && x.trim().length > 0 && Buffer.byteLength(x) <= max && Buffer.from(x, 'utf8').toString('utf8') === x;
  if (typeof rootBinding !== 'string' || !HEX.test(rootBinding) || !isSafePathSegment(recordId) || recordId.length > 200 ||
      typeof revision !== 'string' || !REVISION.test(revision) || !(oldConfidence === null || score(oldConfidence)) || !score(newConfidence) ||
      typeof candidateDigest !== 'string' || !DIGEST.test(candidateDigest) || typeof authorizationDigest !== 'string' || !DIGEST.test(authorizationDigest) ||
      !text(requestKey, 1024) || !text(agent, 1024) || !Array.isArray(evidence) || !Number.isSafeInteger(evidenceLength) || evidenceLength <= 0 || evidenceLength > 256) {
    throw new MissingEvidenceError('reviewed confidence: invalid request');
  }
  const copied: { id: string; revision: string }[] = [];
  for (let i = 0; i < evidenceLength; i++) {
    const entry = evidence[i];
    if (!entry || typeof entry !== 'object') throw new MissingEvidenceError('reviewed confidence: invalid evidence');
    copied.push({ id: entry.id, revision: entry.revision });
  }
  for (let i = 0; i < copied.length; i++) {
    const entry = copied[i];
    if (!isSafePathSegment(entry.id) || entry.id.length > 200 || entry.id === recordId || typeof entry.revision !== 'string' || !REVISION.test(entry.revision) ||
        (i > 0 && copied[i - 1].id >= entry.id)) throw new MissingEvidenceError('reviewed confidence: evidence must have unique sorted exact ids and revisions');
  }
  const request = { rootBinding, recordId, revision, oldConfidence: oldConfidence === 0 ? 0 : oldConfidence, newConfidence: newConfidence === 0 ? 0 : newConfidence, evidence: copied, candidateDigest, authorizationDigest, requestKey, agent };
  if (reviewedConfidenceCandidateDigest(request) !== candidateDigest) throw new MissingEvidenceError('reviewed confidence: candidate digest does not match the change');
  return request;
}

/** Called only inside the adapter's existing coordinated mutation. */
export function applyReviewedLocked(
  request: ReviewedConfidenceRequest,
  receipts: ReviewedConfidenceReceipts,
  snapshot: (id: string) => ReviewedConfidenceSnapshot & { historical: boolean },
  update: (id: string, score: number, agent: string, captured: KitRecord) => void,
  now: () => string,
): ReviewedConfidenceReceipt {
  const target = snapshot(request.recordId);
  if (target.rootBinding !== request.rootBinding) throw new RootBindingMismatchError();
  if (target.historical) throw new MissingEvidenceError('reviewed confidence: target is not active');
  // Detect a changed request key before evaluating the new request's evidence.
  const previous = receipts.lookup(request);
  for (const source of request.evidence) {
    const current = snapshot(source.id);
    if (current.rootBinding !== request.rootBinding) throw new RootBindingMismatchError();
    if (current.historical || current.revision !== source.revision) throw new StaleRevisionError('reviewed confidence evidence', 'the evidence changed; review a new candidate');
  }
  // A successful first application necessarily changed the target revision.
  if (previous) return previous;
  if (target.revision !== request.revision || (target.record.confidence ?? null) !== request.oldConfidence) throw new StaleRevisionError('reviewed confidence', 'the record changed; review a new candidate');
  update(request.recordId, request.newConfidence, request.agent, target.record);
  return receipts.save(request, now());
}

/** Receipts use the existing transaction journal; they are not a second journal. */
export class ReviewedConfidenceReceipts {
  private readonly directory: string;
  constructor(private readonly files: KnowledgeFileTransactions, root: string) { this.directory = join(root, REVIEWED_CONFIDENCE_DIRECTORY); }
  key(request: ReviewedConfidenceRequest): string {
    return createHmac('sha256', request.rootBinding).update(JSON.stringify(['reviewed-confidence-key-v1', request.recordId, request.requestKey])).digest('hex');
  }
  input(request: ReviewedConfidenceRequest): string {
    return createHash('sha256').update(JSON.stringify(['reviewed-confidence-input-v1', request.rootBinding, request.recordId, request.revision, request.oldConfidence, request.newConfidence, request.evidence, request.candidateDigest, request.authorizationDigest, request.agent])).digest('hex');
  }
  private path(key: string): string { return join(this.directory, `${key}.json`); }
  private read(key: string): StoredReceipt | null {
    const text = this.files.readText(this.path(key), MAX_RECEIPT);
    if (text === null) return null;
    try {
      const value = JSON.parse(text) as StoredReceipt;
      if (!value || value.version !== 1 || value.key !== key || JSON.stringify(value) + '\n' !== text) throw new Error();
      if ('retired' in value) {
        if (value.retired !== true || Object.keys(value).join(',') !== 'version,key,retired') throw new Error();
      } else if (Object.keys(value).join(',') !== 'version,key,target,evidence,input,appliedAt' || !isSafePathSegment(value.target) ||
        !Array.isArray(value.evidence) || value.evidence.length === 0 || value.evidence.length > 256 ||
        value.evidence.some((id, i) => !isSafePathSegment(id) || (i > 0 && value.evidence[i - 1] >= id)) ||
        typeof value.input !== 'string' || !HEX.test(value.input) || typeof value.appliedAt !== 'string' || !Number.isFinite(Date.parse(value.appliedAt))) throw new Error();
      return value;
    } catch { throw new KnowledgeStoreCorruptionError('reviewed confidence receipt is corrupt'); }
  }
  lookup(request: ReviewedConfidenceRequest): ReviewedConfidenceReceipt | null {
    const key = this.key(request); const receipt = this.read(key);
    if (!receipt) return null;
    if ('retired' in receipt) throw new RequestKeyConflictError(true, 'applyReviewedConfidence');
    if (receipt.target !== request.recordId || receipt.input !== this.input(request)) throw new RequestKeyConflictError(false, 'applyReviewedConfidence');
    return { receiptId: key, appliedAt: receipt.appliedAt };
  }
  save(request: ReviewedConfidenceRequest, appliedAt: string): ReviewedConfidenceReceipt {
    const key = this.key(request);
    const receipt: ActiveReceipt = { version: 1, key, target: request.recordId, evidence: request.evidence.map((e) => e.id), input: this.input(request), appliedAt };
    this.files.writeText(this.path(key), JSON.stringify(receipt) + '\n');
    return { receiptId: key, appliedAt };
  }
  /** Scan under the purge lock so erasing any participant retires the input digest. */
  planRetire(erased: ReadonlySet<string>): string[] {
    const keys: string[] = [];
    for (const name of this.files.listFileNames(this.directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new KnowledgeStoreCorruptionError('reviewed confidence receipt directory is corrupt');
      const key = name.slice(0, -5); const receipt = this.read(key);
      if (!receipt) throw new KnowledgeStoreCorruptionError('reviewed confidence receipt disappeared');
      if (!('retired' in receipt) && (erased.has(receipt.target) || receipt.evidence.some((id) => erased.has(id)))) keys.push(key);
    }
    return keys;
  }
  retire(keys: string[]): void {
    for (const key of keys) this.files.writeText(this.path(key), JSON.stringify({ version: 1, key, retired: true } satisfies RetiredReceipt) + '\n');
  }
  revisionParts(): { name: string; text: string }[] {
    return this.files.listFileNames(this.directory).map((name) => {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new KnowledgeStoreCorruptionError('reviewed confidence receipt directory is corrupt');
      const key = name.slice(0, -5); const receipt = this.read(key);
      if (!receipt) throw new KnowledgeStoreCorruptionError('reviewed confidence receipt disappeared');
      return { name, text: JSON.stringify(receipt) + '\n' };
    });
  }
}
