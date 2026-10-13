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
  coordinationIdentity?: () => (() => void);
  clock?: () => number;
  ids?: () => string;
  diagnostics?: Diagnostics;
  transactionObserver?: (operation: string, outcome: string) => void;
}
export type ResolvedServices = Required<Pick<StoreOptions, 'coordinationDirectory' | 'lock' | 'clock' | 'ids'>> & Pick<StoreOptions, 'diagnostics' | 'transactionObserver' | 'coordinationIdentity'>;
export const serviceScope = new AsyncLocalStorage<ResolvedServices>();
export function resolveServices(options: Omit<StoreOptions, 'storeRoot'>): ResolvedServices {
  if (typeof options?.lock !== 'function') throw new Error('Explicit lock is required');
  if (typeof options.coordinationDirectory !== 'string' || !isAbsolute(options.coordinationDirectory)) throw new Error('Explicit absolute coordinationDirectory is required');
  return {
    ...options,
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
