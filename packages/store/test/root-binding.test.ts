import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { assertAdapterBoundTo, KitDefaultStoreAdapter, KitObsidianStoreAdapter, standaloneFileMutationLock } from '../src/index.js';

describe.each([['default', KitDefaultStoreAdapter], ['vault', KitObsidianStoreAdapter]] as const)('root binding %s', (_profile, Constructor) => {
  test('matches canonical aliases and rejects other and rescaffolded roots', () => {
    const base = mkdtempSync(join(tmpdir(), 'corpus-root-binding-'));
    try {
      const root = join(base, 'store');
      const options = (storeRoot: string) => ({ storeRoot, coordinationDirectory: join(base, 'coordination'), coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock });
      const adapter = new Constructor(options(root));
      const other = join(base, 'other');
      new Constructor(options(other));
      expect(() => assertAdapterBoundTo(adapter, root)).not.toThrow();
      const alias = join(base, 'alias'); symlinkSync(root, alias);
      expect(() => assertAdapterBoundTo(adapter, alias)).not.toThrow();
      expect(() => assertAdapterBoundTo(adapter, other)).toThrow(expect.objectContaining({ code: 'ROOT_BINDING_MISMATCH' }));
      rmSync(root, { recursive: true });
      new Constructor(options(root));
      expect(() => assertAdapterBoundTo(adapter, root)).toThrow(expect.objectContaining({ code: 'ROOT_BINDING_MISMATCH' }));
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});
