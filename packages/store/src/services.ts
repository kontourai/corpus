import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

/** Matches Station's FileMutationLock seam; hosts retain their lock implementation. */
export type FileMutationLock = (lockPath: string) =>
  (() => void | Promise<void>) | Promise<() => void | Promise<void>>;
export interface Diagnostics {
  warn(message: string, fields?: Record<string, unknown>): void;
}
export interface StoreOptions {
  storeRoot: string;
  /** Final private directory, e.g. <Station home>/coordination/knowledge-file-transactions. */
  coordinationDirectory: string;
  lock: FileMutationLock;
  /** Captures host runtime-home identity; returned function rechecks it before I/O and observation return. */
  coordinationIdentity: () => (() => void);
  clock?: () => number;
  ids?: () => string;
  diagnostics?: Diagnostics;
  transactionObserver?: (operation: string, outcome: string) => void;
  /**
   * Default-deny switch for `purge`. A host sets it only after its own authorization,
   * since the store has no notion of who may erase records. Without it `purge`
   * throws `READ_ONLY` before any I/O.
   */
  allowPurge?: boolean;
  /** Enable reviewed-confidence writes only after the host's authorization. */
  allowReviewedConfidence?: boolean;
}
export type ResolvedServices = Required<Pick<StoreOptions, 'coordinationDirectory' | 'lock' | 'coordinationIdentity' | 'clock' | 'ids'>> & Pick<StoreOptions, 'diagnostics' | 'transactionObserver' | 'allowPurge' | 'allowReviewedConfidence'>;
export const serviceScope = new AsyncLocalStorage<ResolvedServices>();
export function resolveServices(options: Omit<StoreOptions, 'storeRoot'>): ResolvedServices {
  if (typeof options?.lock !== 'function') throw new Error('Explicit lock is required');
  if (typeof options.coordinationDirectory !== 'string' || !isAbsolute(options.coordinationDirectory)) throw new Error('Explicit absolute coordinationDirectory is required');
  if (typeof options.coordinationIdentity !== 'function') throw new Error('Explicit coordinationIdentity is required');
  const recheck = options.coordinationIdentity();
  if (typeof recheck !== 'function') throw new Error('coordinationIdentity must return a recheck function');
  return {
    ...options,
    allowPurge: options.allowPurge === true,
    allowReviewedConfidence: options.allowReviewedConfidence === true,
    coordinationIdentity: () => recheck,
    coordinationDirectory: resolve(options.coordinationDirectory),
    lock: options.lock,
    clock: options.clock ?? Date.now,
    ids: options.ids ?? randomUUID,
  };
}
export const diagnostics: Diagnostics = {
  warn(message, fields) {
    try { serviceScope.getStore()?.diagnostics?.warn(message, fields); } catch { /* Diagnostics cannot change storage outcomes. */ }
  },
};
