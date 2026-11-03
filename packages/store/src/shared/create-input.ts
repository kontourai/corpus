import type { CreateInput } from '../contracts.js';
import { MissingEvidenceError } from '../errors.js';
import { isValidCategory } from './category.js';
import { VALID_TYPES } from './record-schema.js';

/**
 * The field checks every record creation makes before it touches storage. `create`
 * and `proposeCreate` share them, so a candidate that a proposal accepts has
 * the same required fields as a record `create` accepts. `op` prefixes the message.
 * State-dependent checks (id collisions, slug conflicts, link targets) stay in
 * each adapter's create path, because they depend on the records present at apply.
 */
export function assertCreateFields(input: CreateInput, op: string): void {
  if (!input.type) {
    throw new MissingEvidenceError(`${op}: missing required field: type`);
  }
  if (!VALID_TYPES.has(input.type)) {
    throw new MissingEvidenceError(
      `${op}: type must be one of raw, compiled, concept, snapshot, person; got: ${input.type}`,
    );
  }
  if (!input.title?.trim()) {
    throw new MissingEvidenceError(`${op}: missing required field: title`);
  }
  if (typeof input.body !== 'string' || input.body.trim() === '') {
    throw new MissingEvidenceError(`${op}: missing required field: body`);
  }
  if (!input.category) {
    throw new MissingEvidenceError(`${op}: missing required field: category`);
  }
  if (!isValidCategory(input.category)) {
    throw new MissingEvidenceError(`${op}: invalid category: ${input.category}`);
  }
  if (!input.provenance?.agent) {
    throw new MissingEvidenceError(
      `${op}: missing required provenance field: provenance.agent`,
    );
  }
}
