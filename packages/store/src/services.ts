import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { standaloneFileMutationLock } from './standalone-lock.js';

/** Matches Station's FileMutationLock seam; hosts retain their lock implementation. */
export type FileMutationLock = (lockPath: string) =>
  (() => void | Promise<void>) | Promise<() => void | Promise<void>>;
export interface Diagnostics {
  warn(message: string, fields?: Record<string, unknown>): void;
}
export interface StoreOptions {
  storeRoot: string;
  /** Final private directory, e.g. <Station home>/coordination/knowledge-file-transactions. */
  coordinationDirectory?: string;
  lock?: FileMutationLock;
  clock?: () => number;
  ids?: () => string;
  diagnostics?: Diagnostics;
  transactionObserver?: (operation: string, outcome: string) => void;
}
export type ResolvedServices = Required<Pick<StoreOptions, 'coordinationDirectory' | 'lock' | 'clock' | 'ids'>> & Pick<StoreOptions, 'diagnostics' | 'transactionObserver'>;
export const serviceScope = new AsyncLocalStorage<ResolvedServices>();
export function resolveServices(options: Omit<StoreOptions, 'storeRoot'>): ResolvedServices {
  return {
    ...options,
    coordinationDirectory: resolve(options.coordinationDirectory ?? join(tmpdir(), `corpus-store-${process.getuid?.() ?? 'user'}`, 'coordination', 'knowledge-file-transactions')),
    lock: options.lock ?? standaloneFileMutationLock,
    clock: options.clock ?? Date.now,
    ids: options.ids ?? randomUUID,
  };
}
export const diagnostics: Diagnostics = {
  warn(message, fields) {
    try { serviceScope.getStore()?.diagnostics?.warn(message, fields); } catch { /* Diagnostics cannot change storage outcomes. */ }
  },
};
