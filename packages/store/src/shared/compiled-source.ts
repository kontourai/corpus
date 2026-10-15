/**
 * A compiled record must link a raw source when it is created (owner decision,
 * 2026-10-13): at least one link of kind `source` whose target is an existing `raw`
 * record. `provenance.source_ids` alone does not satisfy it. Only creation is
 * checked, so existing compiled records without a source stay readable and
 * updatable.
 */
import type { KitLink, KitRecord, KitRecordType } from '../contracts.js';
import { MissingEvidenceError } from '../errors.js';

export function assertCompiledSource(
  type: KitRecordType,
  links: readonly KitLink[],
  lookup: (id: string) => KitRecord | null,
): void {
  if (type !== 'compiled') return;
  for (const link of links) {
    if (link.kind === 'source' && lookup(link.target_id)?.type === 'raw') return;
  }
  throw new MissingEvidenceError(
    'create: a compiled record must link a raw source (a link of kind "source" to an existing raw record)',
  );
}
