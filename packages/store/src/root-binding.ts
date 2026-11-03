import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { KnowledgeFileTransactions } from './shared/file-transactions.js';
import type { StoreOptions } from './services.js';
import { join } from 'node:path';
import type { KnowledgeStoreAdapter, RootBoundAdapter } from './contracts.js';
import { KnowledgeStoreCorruptionError, RootBindingMismatchError } from './errors.js';

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
  const canonical = realpathSync.native(root);
  return createHash('sha256').update(JSON.stringify([canonical, marker(canonical)])).digest('hex');
}
/** Explicitly initialize an existing unbound root under the host's transaction lock. */
export async function initializeRootBinding(options: StoreOptions): Promise<void> {
  const files = new KnowledgeFileTransactions(options.storeRoot, {}, options);
  try {
    await files.mutate('initializeRootBinding', () => {
      const path = join(options.storeRoot, MARKER);
      if (files.readText(path, 64) === null) files.writeText(path, randomBytes(32).toString('hex'));
      else { try { binding(options.storeRoot); } catch { throw new RootBindingMismatchError(); } }
    });
    try { binding(options.storeRoot); } catch { throw new RootBindingMismatchError(); }
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
  if (!adapter || !('rootBinding' in adapter) || typeof adapter.rootBinding !== 'function' || adapter.rootBinding() !== expected) throw new RootBindingMismatchError();
}
