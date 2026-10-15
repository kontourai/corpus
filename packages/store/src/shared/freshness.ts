/**
 * Record-carried freshness fields (store-contract.md Addendum J.2): optional
 * `expires_at` (ISO-8601) / `ttl_seconds` (positive number). Validated at the
 * mutation boundary so a malformed value never reaches disk.
 *
 * One expiry rule (owner decision, 2026-10-13): an explicit `expires_at` wins;
 * otherwise a record expires `ttl_seconds` after `created_at`; a record with
 * neither never expires. The TTL anchor is creation, so an update never extends
 * it. A record is expired from its expiry instant onward (`now >= expiry`). This is
 * record expiry only. Maintenance age and trust freshness are other signals, and
 * no `stale` status is ever stored.
 */
import type { KitRecord, ListOptions } from '../contracts.js';
import { MissingEvidenceError } from '../errors.js';

/** Epoch milliseconds at which the record expires, or `undefined` if it never does. */
export function expiresAtMs(record: KitRecord): number | undefined {
  if (record.expires_at !== undefined) return Date.parse(record.expires_at);
  if (record.ttl_seconds !== undefined) {
    return Date.parse(record.created_at) + record.ttl_seconds * 1000;
  }
  return undefined;
}

export function isExpired(record: KitRecord, now: number): boolean {
  const expiry = expiresAtMs(record);
  return expiry !== undefined && now >= expiry;
}

/**
 * The list expiry filter. `stale: true` keeps only expired records and
 * `stale: false` only unexpired ones; without `stale` there is no expiry filter.
 * `now` (epoch milliseconds) defaults to the injected clock. Malformed options
 * are refused rather than ignored.
 */
export function expiryFilter(
  options: ListOptions,
  clock: () => number,
): ((record: KitRecord) => boolean) | undefined {
  if (options.stale !== undefined && typeof options.stale !== 'boolean') {
    throw new MissingEvidenceError(`list: stale must be a boolean; got: ${JSON.stringify(options.stale)}`);
  }
  if (options.now !== undefined && (typeof options.now !== 'number' || !Number.isFinite(options.now))) {
    throw new MissingEvidenceError(`list: now must be finite epoch milliseconds; got: ${JSON.stringify(options.now)}`);
  }
  if (options.stale === undefined) return undefined;
  const now = options.now ?? clock();
  const stale = options.stale;
  return (record) => isExpired(record, now) === stale;
}

interface FreshnessInput {
  expires_at?: string | null;
  ttl_seconds?: number | null;
}

interface FreshnessPatch {
  expires_at?: string;
  ttl_seconds?: number;
}

function validateExpiresAt(value: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new MissingEvidenceError(
      `expires_at must be a non-empty ISO-8601 string; got: ${JSON.stringify(value)}`,
    );
  }
  if (Number.isNaN(Date.parse(value))) {
    throw new MissingEvidenceError(
      `expires_at must be a valid ISO-8601 timestamp; got: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function validateTtlSeconds(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new MissingEvidenceError(
      `ttl_seconds must be a positive number of seconds; got: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * Extract + validate freshness fields from a create/update input, returning a patch
 * containing only supplied keys. A key explicitly set to `null`/`""` maps to
 * `undefined` in the patch — the signal to CLEAR it on update. Absent keys are
 * omitted entirely, so an input with no freshness fields yields `{}`.
 */
export function freshnessPatch(input: FreshnessInput): FreshnessPatch {
  const patch: FreshnessPatch = {};
  // When the key is present at all (even as null/"" — the clear signal), the patch
  // gets an explicit own property (possibly `undefined`), so a later
  // `{ ...record, ...patch }` spread overrides — and clears — the prior value. A key
  // absent from `input` leaves `patch` without that own property, so the prior
  // value survives the spread untouched. This distinction is load-bearing.
  if (Object.hasOwn(input, 'expires_at')) {
    const raw = input.expires_at;
    patch.expires_at =
      raw === null || raw === '' || raw === undefined
        ? undefined
        : validateExpiresAt(raw);
  }
  if (Object.hasOwn(input, 'ttl_seconds')) {
    const raw = input.ttl_seconds;
    patch.ttl_seconds =
      raw === null || raw === undefined ? undefined : validateTtlSeconds(raw);
  }
  return patch;
}
