import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import { KnowledgeFileTransactions, scaffoldNewRootIdentity } from '../src/shared/file-transactions.js';
import { KnowledgeStoreCorruptionError } from '../src/errors.js';
import { assertAdapterBoundTo, initializeRootBinding, KitDefaultStoreAdapter, KitObsidianStoreAdapter, standaloneFileMutationLock } from '../src/index.js';

describe.each([['default', KitDefaultStoreAdapter], ['vault', KitObsidianStoreAdapter]] as const)('root binding %s', (_profile, Constructor) => {
  test.skipIf(process.getuid === undefined)('coordination privacy is independent of store directory mode', async () => {
    const base = mkdtempSync(join(tmpdir(), 'corpus-coordination-modes-'));
    try {
      for (const rootMode of [0o700, 0o755]) for (const coordinationMode of [0o700, 0o755]) {
        const root = join(base, `store-${rootMode}-${coordinationMode}`);
        const coordinationDirectory = join(base, `coordination-${rootMode}-${coordinationMode}`);
        mkdirSync(root); chmodSync(root, rootMode);
        mkdirSync(coordinationDirectory); chmodSync(coordinationDirectory, coordinationMode);
        const options = { storeRoot: root, coordinationDirectory, coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock };
        if (coordinationMode === 0o700) {
          await expect(initializeRootBinding(options)).resolves.toBeUndefined();
          expect(() => new Constructor(options)).not.toThrow();
        } else {
          await expect(initializeRootBinding(options)).rejects.toBeInstanceOf(KnowledgeStoreCorruptionError);
          expect(() => new Constructor(options)).toThrow(/coordinationDirectory/);
        }
      }
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
  test.skipIf(process.getuid === undefined)('reports a non-private coordinationDirectory without masking root binding failures', async () => {
    const base = mkdtempSync(join(tmpdir(), 'corpus-coordination-'));
    try {
      const root = join(base, 'store'); mkdirSync(root);
      const coordinationDirectory = join(base, 'coordination'); mkdirSync(coordinationDirectory); chmodSync(coordinationDirectory, 0o755);
      const options = { storeRoot: root, coordinationDirectory, coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock };
      expect(() => new Constructor(options)).toThrow(/coordinationDirectory.*private/);
      await expect(initializeRootBinding(options)).rejects.toThrow(/coordinationDirectory.*private/);
      const error = await initializeRootBinding(options).catch((cause: Error) => cause);
      expect(error).toBeInstanceOf(KnowledgeStoreCorruptionError);
      expect(String(error)).not.toContain(base);
      chmodSync(coordinationDirectory, 0o700);
      await initializeRootBinding(options);
      expect(() => assertAdapterBoundTo(new Constructor(options), root)).not.toThrow();
      await expect(initializeRootBinding({ ...options, storeRoot: join(base, 'missing') })).rejects.toMatchObject({ code: 'ROOT_BINDING_MISMATCH' });
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
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
  test('initialization does not replace a marker published between checking and writing', async () => {
    const base = mkdtempSync(join(tmpdir(), 'corpus-root-race-'));
    try {
      const root = join(base, 'store'); mkdirSync(root);
      const options = { storeRoot: root, coordinationDirectory: join(base, 'coordination'), coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock };
      const prototype = KnowledgeFileTransactions.prototype as unknown as { atomicWrite(path: string, value: Buffer): void };
      const original = prototype.atomicWrite; let prior: string | undefined;
      const spy = vi.spyOn(prototype, 'atomicWrite').mockImplementation(function (this: unknown, path, value) {
        if (path === join(root, '.corpus-root-id')) {
          scaffoldNewRootIdentity(root); prior = new Constructor(options).rootBinding();
        }
        return original.call(this, path, value);
      });
      try {
        await initializeRootBinding(options);
        const current = new Constructor(options).rootBinding();
        if (prior) expect(current).toBe(prior);
        expect(spy.mock.calls.some(([path]) => path === join(root, '.corpus-root-id'))).toBe(false);
      } finally { spy.mockRestore(); }
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
  test('recovers a completed marker left linked to its scaffold temporary', async () => {
    const base = mkdtempSync(join(tmpdir(), 'corpus-root-scaffold-crash-'));
    try {
      const root = join(base, 'store'); mkdirSync(root);
      const options = { storeRoot: root, coordinationDirectory: join(base, 'coordination'), coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock };
      const temporary = join(root, `.corpus-root-id-${'a'.repeat(32)}.tmp`); const marker = join(root, '.corpus-root-id');
      writeFileSync(temporary, 'a'.repeat(64), { mode: 0o600 }); linkSync(temporary, marker);
      await initializeRootBinding(options);
      expect(readFileSync(marker, 'utf8')).toBe('a'.repeat(64));
      expect(existsSync(temporary)).toBe(false);
      expect(() => assertAdapterBoundTo(new Constructor(options), root)).not.toThrow();
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
  test('scaffold recovery leaves unrelated regular temporaries intact', async () => {
    const base = mkdtempSync(join(tmpdir(), 'corpus-root-inode-'));
    try {
      const root = join(base, 'store'); mkdirSync(root);
      const options = { storeRoot: root, coordinationDirectory: join(base, 'coordination'), coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock };
      const unrelated = join(root, `.corpus-root-id-${'0'.repeat(32)}.tmp`);
      const linked = join(root, `.corpus-root-id-${'f'.repeat(32)}.tmp`); const marker = join(root, '.corpus-root-id');
      writeFileSync(unrelated, 'b'.repeat(64), { mode: 0o600 }); writeFileSync(linked, 'a'.repeat(64), { mode: 0o600 }); linkSync(linked, marker);
      await initializeRootBinding(options);
      expect(readFileSync(unrelated, 'utf8')).toBe('b'.repeat(64)); expect(existsSync(linked)).toBe(false);
      expect(readFileSync(marker, 'utf8')).toBe('a'.repeat(64));
      expect(() => assertAdapterBoundTo(new Constructor(options), root)).not.toThrow();
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
  test('scaffold recovery skips a symlinked lookalike temporary', async () => {
    const base = mkdtempSync(join(tmpdir(), 'corpus-root-lookalike-'));
    try {
      const root = join(base, 'store'); mkdirSync(root);
      const options = { storeRoot: root, coordinationDirectory: join(base, 'coordination'), coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock };
      const external = join(base, 'external'); writeFileSync(external, 'outside');
      const lookalike = join(root, `.corpus-root-id-${'0'.repeat(32)}.tmp`); symlinkSync(external, lookalike);
      const linked = join(root, `.corpus-root-id-${'f'.repeat(32)}.tmp`); const marker = join(root, '.corpus-root-id');
      writeFileSync(linked, 'a'.repeat(64), { mode: 0o600 }); linkSync(linked, marker);
      await initializeRootBinding(options);
      expect(readFileSync(external, 'utf8')).toBe('outside'); expect(existsSync(lookalike)).toBe(true); expect(existsSync(linked)).toBe(false);
      expect(() => assertAdapterBoundTo(new Constructor(options), root)).not.toThrow();
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('scaffold recovery skips an unreadable regular lookalike', async () => {
    const base = mkdtempSync(join(tmpdir(), 'corpus-root-unreadable-'));
    try {
      const root = join(base, 'store'); mkdirSync(root);
      const options = { storeRoot: root, coordinationDirectory: join(base, 'coordination'), coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock };
      const lookalike = join(root, `.corpus-root-id-${'0'.repeat(32)}.tmp`);
      const linked = join(root, `.corpus-root-id-${'f'.repeat(32)}.tmp`); const marker = join(root, '.corpus-root-id');
      writeFileSync(lookalike, 'unrelated'); chmodSync(lookalike, 0o000);
      writeFileSync(linked, 'a'.repeat(64), { mode: 0o600 }); linkSync(linked, marker);
      await initializeRootBinding(options);
      expect(existsSync(lookalike)).toBe(true); expect(existsSync(linked)).toBe(false);
      expect(() => assertAdapterBoundTo(new Constructor(options), root)).not.toThrow();
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
  test.skipIf(process.platform === 'win32')('scaffold recovery skips a socket lookalike temporary', async () => {
    const base = mkdtempSync('/tmp/corpus-rb-'); const server = createServer();
    try {
      const root = join(base, 's'); mkdirSync(root);
      const options = { storeRoot: root, coordinationDirectory: join(base, 'c'), coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock };
      const lookalike = join(root, `.corpus-root-id-${'0'.repeat(32)}.tmp`);
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(lookalike, resolve); });
      const linked = join(root, `.corpus-root-id-${'f'.repeat(32)}.tmp`); const marker = join(root, '.corpus-root-id');
      writeFileSync(linked, 'a'.repeat(64), { mode: 0o600 }); linkSync(linked, marker);
      await initializeRootBinding(options);
      expect(existsSync(lookalike)).toBe(true); expect(existsSync(linked)).toBe(false);
      expect(() => assertAdapterBoundTo(new Constructor(options), root)).not.toThrow();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(base, { recursive: true, force: true });
    }
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
  test('initialization and concurrent scaffolding never replace a published binding', async () => {
    for (let round = 0; round < 3; round++) {
      const base = mkdtempSync(join(tmpdir(), 'corpus-root-init-race-'));
      try {
        const root = join(base, 'store'); const coordinationDirectory = join(base, 'coordination');
        const fixture = fileURLToPath(new URL('./fixtures/root-binding-child.ts', import.meta.url));
        const children = Array.from({ length: 6 }, () => new Promise<string>((resolve, reject) => {
          const child = spawn(process.execPath, ['--import', 'tsx', fixture, root, coordinationDirectory, _profile]);
          let stdout = ''; let stderr = ''; child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
          child.on('error', reject); child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
        }));
        const deadline = Date.now() + 10_000;
        while (!existsSync(root) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2));
        expect(existsSync(root)).toBe(true);
        const options = { storeRoot: root, coordinationDirectory, coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock };
        await Promise.all(Array.from({ length: 4 }, () => initializeRootBinding(options)));
        const values = await Promise.all(children); const final = new Constructor(options).rootBinding();
        expect(values.every((value) => value === 'unbound' || value === final)).toBe(true);
        expect(() => assertAdapterBoundTo(new Constructor(options), root)).not.toThrow();
      } finally { rmSync(base, { recursive: true, force: true }); }
    }
  }, 60_000);
  test('purge-enabled adapters keep their root binding across purge and reindex', async () => {
    const base = mkdtempSync(join(tmpdir(), 'corpus-root-purge-'));
    try {
      const root = join(base, 'store'); const options = { storeRoot: root, coordinationDirectory: join(base, 'coordination'), coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock, allowPurge: true };
      const adapter = new Constructor(options); const binding = adapter.rootBinding(); const marker = readFileSync(join(root, '.corpus-root-id'), 'utf8');
      await adapter.create({ id: 'purge-record', type: 'raw', title: 't', body: 'b', category: 'testing', provenance: { agent: 'writer' } });
      await adapter.purge(['purge-record'], { agent: 'eraser', rationale: 'requested' });
      await adapter.reindex();
      expect((await adapter.get('purge-record'))?.status).toBe('purged');
      expect(adapter.rootBinding()).toBe(binding); expect(readFileSync(join(root, '.corpus-root-id'), 'utf8')).toBe(marker);
      expect(new Constructor(options).rootBinding()).toBe(binding);
      expect(() => assertAdapterBoundTo(adapter, root)).not.toThrow();
      const other = join(base, 'other'); new Constructor({ ...options, storeRoot: other });
      expect(() => assertAdapterBoundTo(adapter, other)).toThrow(expect.objectContaining({ code: 'ROOT_BINDING_MISMATCH' }));
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

test.skipIf(process.platform === 'win32')('FIFO marker refuses without blocking a constructor or helper', () => {
  const base = mkdtempSync(join(tmpdir(), 'corpus-root-fifo-'));
  try {
    const root = join(base, 'store'); mkdirSync(root); execFileSync('mkfifo', [join(root, '.corpus-root-id')]);
    const fixture = fileURLToPath(new URL('./fixtures/root-binding-fifo.ts', import.meta.url));
    for (const profile of ['default', 'vault']) {
      const child = spawnSync(process.execPath, ['--import', 'tsx', fixture, root, join(base, `coord-${profile}`), profile], { encoding: 'utf8', timeout: 5000 });
      expect(child.error).toBeUndefined(); expect(child.status, child.stderr).toBe(0);
    }
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('invalid adapter values and missing or symlink roots refuse without creating a root', async () => {
  const base = mkdtempSync(join(tmpdir(), 'corpus-root-invalid-'));
  try {
    const root = join(base, 'root'); mkdirSync(root);
    const options = { storeRoot: root, coordinationDirectory: join(base, 'coordination'), coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock };
    await initializeRootBinding(options);
    expect(() => assertAdapterBoundTo(42 as never, root)).toThrow(expect.objectContaining({ code: 'ROOT_BINDING_MISMATCH' }));
    const missing = join(base, 'missing');
    await expect(initializeRootBinding({ ...options, storeRoot: missing })).rejects.toMatchObject({ code: 'ROOT_BINDING_MISMATCH' });
    expect(existsSync(missing)).toBe(false);
    const alias = join(base, 'alias'); symlinkSync(root, alias);
    await expect(initializeRootBinding({ ...options, storeRoot: alias })).rejects.toMatchObject({ code: 'ROOT_BINDING_MISMATCH' });
  } finally { rmSync(base, { recursive: true, force: true }); }
});
