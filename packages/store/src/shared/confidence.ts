/**
 * Record confidence (kontourai/corpus#68): an optional number from 0 to 1 that a
 * writer attaches to a record, such as a compiled instinct. The store carries it
 * and bounds it; what the number means belongs to the writer.
 *
 * Validated at the mutation boundary so a malformed value never reaches disk, and
 * again when a record is read (`assertKitRecord`). A value outside the range is
 * refused, never clamped: clamping would store a number nobody supplied. NaN,
 * infinities, text and booleans are refused too. `null` clears the field on update
 * (as for `ttl_seconds`); on create and in a proposal it is not a number and is
 * refused.
 */
import { MissingEvidenceError } from '../errors.js';

export const CONFIDENCE_MIN = 0;
export const CONFIDENCE_MAX = 1;

/** True for a finite number from 0 to 1 inclusive. */
export function isConfidence(value: unknown): value is number {
  return typeof value === 'number' && value >= CONFIDENCE_MIN && value <= CONFIDENCE_MAX;
}

function describe(value: unknown): string {
  // `JSON.stringify(NaN)` is "null", which would hide what was refused.
  return typeof value === 'number' ? String(value) : `a ${value === null ? 'null' : typeof value}`;
}

function validate(value: unknown, op: string): number {
  if (!isConfidence(value)) {
    throw new MissingEvidenceError(
      `${op}: confidence must be a number from ${CONFIDENCE_MIN} to ${CONFIDENCE_MAX}; got: ${describe(value)}`,
    );
  }
  // -0 passes the range check; store it as 0 so a record never differs from its JSON form.
  return value === 0 ? 0 : value;
}

/**
 * The confidence a create input or candidate carries: `{ confidence }` when it has a
 * valid one, `{}` when it has none. Reads an own property only, as the freshness
 * fields are read, so an inherited value never becomes record content.
 */
export function confidenceOnCreate(input: object, op: string): { confidence?: number } {
  if (!Object.hasOwn(input, 'confidence')) return {};
  const raw = (input as { confidence?: unknown }).confidence;
  return raw === undefined ? {} : { confidence: validate(raw, op) };
}

/**
 * The confidence an update supplies: `undefined` when it leaves the field alone, `null`
 * to clear it, or the validated number.
 */
export function confidenceOnUpdate(fields: object, op = 'update'): number | null | undefined {
  if (!Object.hasOwn(fields, 'confidence')) return undefined;
  const raw = (fields as { confidence?: unknown }).confidence;
  if (raw === undefined) return undefined;
  return raw === null ? null : validate(raw, op);
}
