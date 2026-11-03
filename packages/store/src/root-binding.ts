import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { KnowledgeFileTransactions, scaffoldNewRootIdentity, settleScaffoldMarker } from './shared/file-transactions.js';
import type { StoreOptions } from './services.js';
import { join } from 'node:path';
import type { KnowledgeStoreAdapter, RootBoundAdapter } from './contracts.js';
import { KnowledgeStoreCorruptionError, RootBindingMismatchError } from './errors.js';

const MARKER = '.corpus-root-id';

function marker(root: string): string {
  const fd = openSync(join(root, MARKER), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== 64) throw new Error('invalid root identity marker');
    const value = readFileSync(fd, 'utf8');
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('invalid root identity marker');
    return value;
  } finally { closeSync(fd); }
}
function binding(root: string): string {
  const canonical = realpathSync.native(root);
  return createHash('sha256').update(JSON.stringify([canonical, marker(canonical)])).digest('hex');
}
/** Explicitly initialize an existing unbound root under the host's transaction lock. */
export async function initializeRootBinding(options: StoreOptions): Promise<void> {
  let files: KnowledgeFileTransactions;
  try {
    const rootInfo = lstatSync(options.storeRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new RootBindingMismatchError();
    files = new KnowledgeFileTransactions(options.storeRoot, {}, options);
  } catch (error) {
    if (error instanceof RootBindingMismatchError || error instanceof KnowledgeStoreCorruptionError || (error as NodeJS.ErrnoException).code === 'ENOENT') throw new RootBindingMismatchError();
    throw error;
  }
  try {
    await files.mutate('initializeRootBinding', () => {
      // Both constructors and initialization publish with link-no-replace. A
      // completed competing marker can never be silently replaced by a rename.
      scaffoldNewRootIdentity(options.storeRoot);
      settleScaffoldMarker(options.storeRoot);
      try { binding(options.storeRoot); } catch { throw new RootBindingMismatchError(); }
    });
  } catch (error) {
    if (error instanceof KnowledgeStoreCorruptionError) throw new RootBindingMismatchError();
    throw error;
  }
}
export function captureRootBinding(root: string): string { return binding(root); }
/** Read-only comparison against a host-authorized root; this does not authorize the root. */
export function assertAdapterBoundTo(adapter: KnowledgeStoreAdapter, root: string): asserts adapter is RootBoundAdapter;
export function assertAdapterBoundTo(adapter: { rootBinding(): string }, root: string): void;
export function assertAdapterBoundTo(adapter: KnowledgeStoreAdapter | { rootBinding(): string }, root: string): void {
  let expected: string;
  try { expected = binding(root); } catch { throw new RootBindingMismatchError(); }
  if (!adapter || (typeof adapter !== 'object' && typeof adapter !== 'function') || !('rootBinding' in adapter) || typeof adapter.rootBinding !== 'function' || adapter.rootBinding() !== expected) throw new RootBindingMismatchError();
}
