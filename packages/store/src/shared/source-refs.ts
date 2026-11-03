import { isRecord } from '../is-record.js';

/** Source references are attribution, never authority to open a resource. */
export function validSourceRefs(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 256) return false;
  const bounded = (v: unknown) => typeof v === 'string' && v.trim().length > 0 && Buffer.byteLength(v, 'utf8') <= 4096;
  return value.every((ref) => {
    if (!isRecord(ref) || Object.keys(ref).some((key) => !['kind', 'harness', 'session_id', 'transcript_ref', 'sitting_id', 'range'].includes(key))) return false;
    if (ref.kind !== 'session-transcript' || !bounded(ref.harness) || !bounded(ref.session_id) || !bounded(ref.transcript_ref)) return false;
    if (ref.sitting_id !== undefined && !bounded(ref.sitting_id)) return false;
    if (ref.range !== undefined) {
      const range = ref.range;
      if (!isRecord(range) || Object.keys(range).some((key) => !['start', 'end'].includes(key)) ||
          !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) ||
          (range.start as number) < 1 || (range.end as number) < (range.start as number)) return false;
    }
    return true;
  });
}
