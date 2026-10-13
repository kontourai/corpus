export const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafePathSegment(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.includes('..')) return false;
  if (value.includes('/') || value.includes('\\')) return false;
  return PATH_SEGMENT_PATTERN.test(value);
}
