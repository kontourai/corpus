import { spawn } from 'node:child_process';
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { assertAdapterBoundTo, initializeRootBinding, KitDefaultStoreAdapter, KitObsidianStoreAdapter, standaloneFileMutationLock } from '../src/index.js';

describe.each([['default', KitDefaultStoreAdapter], ['vault', KitObsidianStoreAdapter]] as const)('root binding %s', (_profile, Constructor) => {
  test('existing unmarked roots require explicit initialization', async () => {
    const base = mkdtempSync(join(tmpdir(), 'corpus-root-legacy-'));
    try {
      const root = join(base, 'store'); mkdirSync(root);
      const options = { storeRoot: root, coordinationDirectory: join(base, 'coordination'), coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock };
      const before = new Constructor(options);
      expect(() => assertAdapterBoundTo(before, root)).toThrow(expect.objectContaining({ code: 'ROOT_BINDING_MISMATCH' }));
      await initializeRootBinding(options);
      const after = new Constructor(options);
      expect(() => assertAdapterBoundTo(after, root)).not.toThrow();
      expect(() => assertAdapterBoundTo(before, root)).toThrow(expect.objectContaining({ code: 'ROOT_BINDING_MISMATCH' }));
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
  test('malformed markers leave record reads available and binding fails closed', async () => {
    const base = mkdtempSync(join(tmpdir(), 'corpus-root-marker-'));
    try {
      const root = join(base, 'store');
      const options = { storeRoot: root, coordinationDirectory: join(base, 'coordination'), coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock };
      const adapter = new Constructor(options);
      await adapter.create({ id: 'readable', type: 'raw', title: 'Readable', body: 'body', category: 'test', provenance: { agent: 'test' } });
      const marker = join(root, '.corpus-root-id'); const bytes = readFileSync(marker, 'utf8');
      for (const variant of ['malformed', 'symlink', 'hardlink']) {
        rmSync(marker);
        const external = join(base, 'external'); writeFileSync(external, variant === 'malformed' ? bytes + '\n' : bytes);
        if (variant === 'symlink') symlinkSync(external, marker);
        else if (variant === 'hardlink') linkSync(external, marker);
        else writeFileSync(marker, bytes + '\n');
        const reopened = new Constructor(options);
        expect((await reopened.get('readable'))?.title).toBe('Readable');
        expect(() => assertAdapterBoundTo(reopened, root)).toThrow(expect.objectContaining({ code: 'ROOT_BINDING_MISMATCH' }));
        await expect(initializeRootBinding(options)).rejects.toMatchObject({ code: 'ROOT_BINDING_MISMATCH' });
        rmSync(external);
      }
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
  test('initialization never replaces an existing identity', async () => {
    const base = mkdtempSync(join(tmpdir(), 'corpus-root-idempotent-'));
    try {
      const root = join(base, 'store'); mkdirSync(root);
      const options = { storeRoot: root, coordinationDirectory: join(base, 'coordination'), coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock };
      await initializeRootBinding(options);
      const adapter = new Constructor(options); const before = adapter.rootBinding();
      const marker = readFileSync(join(root, '.corpus-root-id'), 'utf8');
      await initializeRootBinding(options);
      expect(readFileSync(join(root, '.corpus-root-id'), 'utf8')).toBe(marker);
      expect(new Constructor(options).rootBinding()).toBe(before);
      expect(() => assertAdapterBoundTo(adapter, root)).not.toThrow();
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
  test('concurrent first constructors do not crash or split identity', async () => {
    const base = mkdtempSync(join(tmpdir(), 'corpus-root-concurrent-'));
    try {
      const root = join(base, 'store'); const coordinationDirectory = join(base, 'coordination');
      const fixture = fileURLToPath(new URL('./fixtures/root-binding-child.ts', import.meta.url));
      const outputs = await Promise.all(Array.from({ length: 8 }, () => new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', fixture, root, coordinationDirectory, _profile]);
        let stdout = ''; let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject); child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
      })));
      expect(outputs.every((value) => value === 'unbound' || /^[a-f0-9]{64}$/.test(value))).toBe(true);
      const reopened = new Constructor({ storeRoot: root, coordinationDirectory, coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock });
      const binding = reopened.rootBinding();
      expect(new Set(outputs.filter((value) => value !== 'unbound'))).toEqual(new Set([binding]));
      expect(() => assertAdapterBoundTo(reopened, root)).not.toThrow();
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
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
      const caseVariant = root.toUpperCase();
      if (existsSync(caseVariant)) expect(() => assertAdapterBoundTo(adapter, caseVariant)).not.toThrow();
      expect(() => assertAdapterBoundTo(adapter, other)).toThrow(expect.objectContaining({ code: 'ROOT_BINDING_MISMATCH' }));
      rmSync(root, { recursive: true });
      new Constructor(options(root));
      expect(() => assertAdapterBoundTo(adapter, root)).toThrow(expect.objectContaining({ code: 'ROOT_BINDING_MISMATCH' }));
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});

test('initializing a kit-v1 vault is an explicit host write and does not enable mutations', async () => {
  const base = mkdtempSync(join(tmpdir(), 'corpus-root-kit-v1-'));
  try {
    const root = join(base, 'vault'); cpSync(fileURLToPath(new URL('./fixtures/kit-v1/kit-vault', import.meta.url)), root, { recursive: true });
    const options = { storeRoot: root, coordinationDirectory: join(base, 'coordination'), coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock };
    const before = new KitObsidianStoreAdapter(options);
    expect(existsSync(join(root, '.corpus-root-id'))).toBe(false);
    await initializeRootBinding(options);
    const after = new KitObsidianStoreAdapter(options);
    expect(() => assertAdapterBoundTo(after, root)).not.toThrow();
    await expect(after.create({ type: 'raw', title: 't', body: 'b', category: 'test', provenance: { agent: 'a' } })).rejects.toMatchObject({ code: 'READ_ONLY' });
    expect((await before.get('kit-concept-0001'))?.id).toBe('kit-concept-0001');
  } finally { rmSync(base, { recursive: true, force: true }); }
});
