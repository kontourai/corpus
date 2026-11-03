import type { KitSourceRef } from '../contracts.js';
import { isRecord } from '../is-record.js';

/** Validate and copy attribution without retaining caller-owned objects or aliases. */
export function copySourceRefs(value: unknown): KitSourceRef[] | null {
  if (!Array.isArray(value) || value.length > 256) return null;
  if (Reflect.ownKeys(value).some((key) => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length || !Object.getOwnPropertyDescriptor(value, key)?.enumerable || !('value' in Object.getOwnPropertyDescriptor(value, key)!)))) return null;
  const bounded = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && Buffer.byteLength(v, 'utf8') <= 4096;
  const plain = (v: unknown): v is Record<string, unknown> => isRecord(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
  const ownData = (v: Record<string, unknown>, key: string): unknown => Object.getOwnPropertyDescriptor(v, key)?.value;
  const keysAre = (v: Record<string, unknown>, allowed: string[]) => Reflect.ownKeys(v).every((key) => typeof key === 'string' && allowed.includes(key) && Object.getOwnPropertyDescriptor(v, key)!.enumerable && 'value' in Object.getOwnPropertyDescriptor(v, key)!);
  const result: KitSourceRef[] = [];
  for (let i = 0; i < value.length; i++) {
    if (!Object.hasOwn(value, i)) return null;
    const ref: unknown = value[i];
    if (!plain(ref) || !keysAre(ref, ['kind', 'harness', 'session_id', 'transcript_ref', 'sitting_id', 'range'])) return null;
    const kind = ownData(ref, 'kind'); const harness = ownData(ref, 'harness');
    const session_id = ownData(ref, 'session_id'); const transcript_ref = ownData(ref, 'transcript_ref');
    const sitting_id = ownData(ref, 'sitting_id'); const range = ownData(ref, 'range');
    if (kind !== 'session-transcript' || !bounded(harness) || !bounded(session_id) || !bounded(transcript_ref)) return null;
    if (sitting_id !== undefined && !bounded(sitting_id)) return null;
    let copiedRange: { start: number; end: number } | undefined;
    if (range !== undefined) {
      if (!plain(range) || !keysAre(range, ['start', 'end'])) return null;
      const start = ownData(range, 'start'); const end = ownData(range, 'end');
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) < 1 || (end as number) < (start as number)) return null;
      copiedRange = { start: start as number, end: end as number };
    }
    result.push({ kind, harness, session_id, transcript_ref, ...(sitting_id !== undefined ? { sitting_id: sitting_id as string } : {}), ...(copiedRange ? { range: copiedRange } : {}) });
  }
  return result;
}
export function validSourceRefs(value: unknown): boolean { return copySourceRefs(value) !== null; }
