/**
 * Working set versus history (owner decision, 2026-10-13): list results return the
 * working set by default, and `includeHistory: true` is the single flag that adds
 * history. Both adapters use this one predicate, so the default and vault profiles
 * cannot drift apart again.
 *
 * A record is historical when it is retired, or superseded. Supersession is read
 * from the record itself (the `superseded-by` mutation-log entry that every
 * `supersede` writes) and, in the vault profile, from its archived location, which
 * the vault only assigns on supersession. An `implemented` record stays in the
 * working set: it completed rather than went out of date.
 */
import type { KitRecord, ListOptions } from '../contracts.js';

export function isSuperseded(record: KitRecord): boolean {
  return (record.mutation_log ?? []).some((entry) => entry?.op === 'superseded-by');
}

export function isHistorical(
  record: KitRecord,
  location: { archived?: boolean } = {},
): boolean {
  return (
    location.archived === true ||
    (record.status ?? 'active') === 'retired' ||
    isSuperseded(record)
  );
}

/**
 * `includeRetired` is a deprecated alias accepted for existing callers. It is
 * translated to `includeHistory` (retired and superseded records alike), so the
 * adapters have exactly one history switch.
 */
export function includesHistory(options: ListOptions = {}): boolean {
  return options.includeHistory === true || options.includeRetired === true;
}
