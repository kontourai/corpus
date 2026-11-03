import { constants, closeSync, fstatSync, linkSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { RootBindingMismatchError } from './errors.js';

const MARKER = '.corpus-root-id';

function marker(root: string): string {
  const fd = openSync(join(root, MARKER), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== 64) throw new Error('invalid root identity marker');
    const value = readFileSync(fd, 'utf8');
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('invalid root identity marker');
    return value;
  } finally { closeSync(fd); }
}
function binding(root: string): string {
  const canonical = realpathSync(root);
  return createHash('sha256').update(JSON.stringify([canonical, marker(canonical)])).digest('hex');
}
/** Scaffold an identity only if absent, then capture the root binding. */
export function scaffoldRootBinding(root: string): string {
  const canonical = realpathSync(root);
  const path = join(canonical, MARKER);
  const temporary = join(canonical, `.corpus-root-id-${randomBytes(16).toString('hex')}.tmp`);
  try {
    writeFileSync(temporary, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
    try { linkSync(temporary, path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } finally {
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return binding(canonical);
}
/** Read-only comparison against a host-authorized root; this does not authorize the root. */
export function assertAdapterBoundTo(adapter: { rootBinding(): string }, root: string): void {
  let expected: string;
  try { expected = binding(root); } catch { throw new RootBindingMismatchError(); }
  if (!adapter || typeof adapter.rootBinding !== 'function' || adapter.rootBinding() !== expected) throw new RootBindingMismatchError();
}
