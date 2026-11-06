import { createHmac } from 'node:crypto';

/**
 * A revision of one exact record's stored bytes under one bound root. This is
 * distinct from the whole-store purge revision. The root binding is an identity,
 * not an authorization secret; callers must not treat this token as permission.
 *
 * The inputs are length-framed so ids and content cannot change their boundaries.
 * Call only after resolving an exact id and reading its authoritative file within
 * the same coordinated transaction that returns or checks the revision.
 */
export function recordRevision(binding: string, id: string, bytes: Uint8Array): string {
  const hmac = createHmac('sha256', binding);
  hmac.update('corpus-record-revision-v1\0');
  hmac.update(`${Buffer.byteLength(id, 'utf8')}\0`, 'utf8');
  hmac.update(id, 'utf8');
  hmac.update(`${bytes.byteLength}\0`, 'utf8');
  hmac.update(bytes);
  return `record-rev1:${hmac.digest('hex')}`;
}
