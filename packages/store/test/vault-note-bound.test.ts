import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { KitObsidianStoreAdapter, standaloneFileMutationLock } from '../src/index.js';
import * as vaultModule from '../src/obsidian-store.js';

const candidate = (fields: Record<string, unknown> = {}) => ({
  id: 'big',
  type: 'raw' as const,
  title: 'Big record',
  body: 'Users stall at account setup.',
  category: 'engineering',
  provenance: { agent: 'tester' },
  ...fields,
});

/** The vault's per-note read bound, written out here so the tests do not derive it from the constant they check. */
const LIMIT = 16 * 1024 * 1024;

/** The issue's body: 10 MB of text that the raw-callout rendering expands to about 20 MB. */
const OVERSIZED = 'a\n'.repeat(5 * 1024 * 1024);

/** Every file (by content hash) and directory under `root`, relative and sorted: a before/after snapshot. */
function tree(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        result[`${relative(root, path)}/`] = 'directory';
        walk(path);
      } else result[relative(root, path)] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  if (existsSync(root)) walk(root);
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

async function failure(promise: Promise<unknown>): Promise<{ code?: string; name?: string; message: string } | undefined> {
  try { await promise; } catch (error) { return error as { code?: string; name?: string; message: string }; }
  return undefined;
}

/** kontourai/corpus#44: a record larger than the vault's identity-scan read bound broke every later create. */
describe('vault note size bound', () => {
  let base: string;
  let root: string;
  let ids: number;
  const open = (): KitObsidianStoreAdapter => new KitObsidianStoreAdapter({
    storeRoot: root,
    coordinationDirectory: join(base, 'coordination'),
    coordinationIdentity: () => () => {},
    lock: standaloneFileMutationLock,
    ids: () => `generated-${++ids}`,
  });
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'corpus-note-bound-'));
    root = join(base, 'store');
    ids = 0;
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }), 120_000);

  test('the named bound is 16 MiB', () => {
    expect(vaultModule.VAULT_NOTE_MAX_BYTES).toBe(16777216);
    expect(vaultModule.VAULT_NOTE_MAX_BYTES).toBe(LIMIT);
  });

  test('create refuses an oversized record, writes nothing, and later creates still work', async () => {
    const vault = open();
    await vault.create(candidate({ id: 'small' }));
    const before = tree(root);
    const error = await failure(vault.create(candidate({ body: OVERSIZED })));
    expect(error).toMatchObject({ code: 'MISSING_EVIDENCE', name: 'MissingEvidenceError' });
    expect(error?.message).toMatch(/limited to 16777216 bytes/);
    expect(tree(root)).toEqual(before);
    expect(await vault.get('big')).toBeNull();
    expect(await vault.create(candidate({ id: 'after' }))).toBe('after');
  }, 120_000);

  test('create accepts a note of exactly the bound and refuses one byte more', async () => {
    const probe = open();
    await probe.create(candidate({ id: 'probe', type: 'concept', body: 'x' }));
    const overhead = statSync(join(root, readdirSync(root, { recursive: true, encoding: 'utf8' }).find((name) => name.endsWith('.md'))!)).size - 1;
    rmSync(root, { recursive: true, force: true });

    const vault = open();
    const exact = LIMIT - overhead;
    await vault.create(candidate({ id: 'probe', type: 'concept', body: 'x'.repeat(exact) }));
    const note = readdirSync(root, { recursive: true, encoding: 'utf8' }).find((name) => name.endsWith('.md'))!;
    expect(statSync(join(root, note)).size).toBe(LIMIT);
    // At the bound the vault still takes its next record: the identity scan reads that note.
    expect(await vault.create(candidate({ id: 'next', type: 'concept' }))).toBe('next');

    const before = tree(root);
    const error = await failure(vault.create(candidate({ id: 'probf', type: 'concept', body: 'x'.repeat(exact + 1) })));
    expect(error).toMatchObject({ code: 'MISSING_EVIDENCE' });
    expect(tree(root)).toEqual(before);
  }, 120_000);

  test('proposeCreate refuses an oversized candidate and stages nothing', async () => {
    const vault = open();
    await vault.create(candidate({ id: 'small' }));
    const before = tree(root);
    const error = await failure(vault.proposeCreate(candidate({ body: OVERSIZED }), 'proposer', { agent: 'distiller', proposal: 'add it' }));
    expect(error).toMatchObject({ code: 'MISSING_EVIDENCE' });
    expect(error?.message).toMatch(/^proposeCreate: .*limited to 16777216 bytes/);
    expect(tree(root)).toEqual(before);
    expect(existsSync(join(root, '.corpus-proposals'))).toBe(false);
  }, 120_000);

  test('applyCreate refuses an oversized candidate, leaves the proposal pending, and later creates still work', async () => {
    const vault = open();
    const proposal = await vault.proposeCreate(candidate(), 'proposer', { agent: 'distiller', proposal: 'add it' });
    // A proposal written elsewhere can hold a candidate that propose would have refused.
    const file = join(root, '.corpus-proposals', `${proposal}.json`);
    const staged = JSON.parse(readFileSync(file, 'utf8'));
    staged.candidate.body = OVERSIZED;
    writeFileSync(file, `${JSON.stringify(staged, null, 2)}\n`);
    const before = tree(root);
    const error = await failure(vault.applyCreate(proposal, 'reviewer'));
    expect(error).toMatchObject({ code: 'MISSING_EVIDENCE' });
    expect(tree(root)).toEqual(before);
    expect((await vault.getProposal(proposal))?.state).toBe('pending');
    expect(await vault.get('big')).toBeNull();
    expect(await vault.create(candidate({ id: 'after' }))).toBe('after');
  }, 120_000);

  test('proposeCreate sizes the note applyCreate writes, including the evidence in its first log entry', async () => {
    const vault = open();
    // The candidate alone fits; the proposal evidence it will carry into the record's log does not.
    const body = 'x'.repeat(14 * 1024 * 1024);
    const evidence = { agent: 'distiller', proposal: 'a\n'.repeat(200_000) };
    const before = tree(root);
    const error = await failure(vault.proposeCreate(candidate({ type: 'concept', body }), 'proposer', evidence));
    expect(error).toMatchObject({ code: 'MISSING_EVIDENCE' });
    expect(error?.message).toMatch(/^proposeCreate: .*limited to 16777216 bytes/);
    expect(tree(root)).toEqual(before);
    // The same candidate with small evidence fits, and applies.
    const proposal = await vault.proposeCreate(candidate({ type: 'concept', body }), 'proposer', { agent: 'distiller', proposal: 'add it' });
    expect(await vault.applyCreate(proposal, 'reviewer')).toBe('big');
    expect((await vault.get('big'))?.body).toBe(body);
  }, 120_000);

  test('sizing a proposal does not take an id before staging does', async () => {
    // The call's transaction takes generated-1 and staging takes generated-2; a sizing step that
    // asked the generator for an id first would push the proposal to generated-3. The clock is
    // covered by create-proposals.test.ts, which pins `proposed_at` to the first tick.
    const vault = open();
    const proposal = await vault.proposeCreate(candidate({ id: undefined }), 'proposer', { agent: 'distiller', proposal: 'add it' });
    expect(proposal).toBe('generated-2');
  });
});
