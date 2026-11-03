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

  test('keyed proposal note sizing includes structured source references', async () => {
    const vault = open();
    const ref = { kind: 'session-transcript' as const, harness: 'h', session_id: 's', transcript_ref: 'x'.repeat(4096) };
    const body = 'a\n'.repeat(3_950_000);
    const large = candidate({ body, provenance: { agent: 'tester', source_refs: Array.from({ length: 256 }, () => ref) } });
    const options = { requestKey: 'source-size' }; const evidence = { agent: 'distiller', proposal: 'add it' };
    const before = tree(root);
    const error = await failure(vault.proposeCreate(large, 'proposer', evidence, options));
    expect(error).toMatchObject({ code: 'MISSING_EVIDENCE', message: expect.stringMatching(/^proposeCreate: .*limited to 16777216 bytes/) });
    expect(tree(root)).toEqual(before);
    const withoutRefs = candidate({ body });
    const receipt = await vault.proposeCreate(withoutRefs, 'proposer', evidence, options);
    expect(await vault.proposeCreate(withoutRefs, 'proposer', evidence, options)).toBe(receipt);
  }, 120_000);

  test('keyed proposals enforce the same note bound before reserving the key', async () => {
    const vault = open();
    const before = tree(root);
    const options = { requestKey: 'note-bound-key' };
    const error = await failure(vault.proposeCreate(candidate({ body: OVERSIZED }), 'proposer', { agent: 'distiller', proposal: 'add it' }, options));
    expect(error).toMatchObject({ code: 'MISSING_EVIDENCE', message: expect.stringMatching(/^proposeCreate: .*limited to 16777216 bytes/) });
    expect(tree(root)).toEqual(before);
    const receipt = await vault.proposeCreate(candidate(), 'proposer', { agent: 'distiller', proposal: 'add it' }, options);
    expect(await vault.proposeCreate(candidate(), 'proposer', { agent: 'distiller', proposal: 'add it' }, options)).toBe(receipt);
    expect(await vault.applyCreate(receipt, 'reviewer')).toBe('big');
    expect(await vault.proposeCreate(candidate(), 'proposer', { agent: 'distiller', proposal: 'add it' }, options)).toBe(receipt);
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

  // The invariant behind proposeCreate's early refusal: its estimate is not below what applyCreate writes,
  // whatever the reviewer id, so a proposal that fits is not later refused for the reviewer's escaping.
  // It reads the sizes through the vault's own size check; no public surface reports them.
  const reviewers: Array<[string, string]> = [
    ['plain', 'reviewer'],
    ['DEL, 1 JSON byte and 4 YAML bytes', '\u007f'.repeat(1022)],
    ['C0 controls', '\u0001\u0007\u001b'.repeat(56)],
    ['quotes', '"'.repeat(510)],
    ['backslashes', '\\'.repeat(510)],
    ['accented', '\u00e9'.repeat(510)],
    ['astral', '\u{1F600}'.repeat(255)],
    ['NEL and C1', '\u0085\u0090'.repeat(255)],
    ['line and paragraph separators', 'x\u2028\u2029'.repeat(100)],
    ['multiline', 'ab\ncd '.repeat(140)],
    ['YAML indicators', ': # - ? | > '.repeat(80)],
  ];
  const candidates: Array<[string, Record<string, unknown>]> = [
    ['short id', { id: 'rec-1' }],
    ['long id linking to itself', { id: 'x'.repeat(1000), body: `see [[${'x'.repeat(1000)}]]` }],
    // The file name comes from the title, so here the link renders longer than the id.
    ['short id linking to itself under a long title', { id: 'sl', title: 'Long title '.repeat(20), links: [{ target_id: 'sl', kind: 'related' }, { target_id: 'sl', kind: 'source' }] }],
    ['no id', { id: undefined, tags: ['a', 'b'], aliases: ['alias-one'] }],
  ];
  describe.each(candidates)('estimate versus applied note: %s', (_label, extra) => {
    test.each(reviewers)('reviewer: %s', async (_name, reviewer) => {
      const vault = open();
      const sizes: Record<string, number> = {};
      const internals = vault as unknown as { assertNoteFits(text: string, operation: string): void };
      const original = internals.assertNoteFits.bind(vault);
      internals.assertNoteFits = (text, operation) => { sizes[operation] = Buffer.byteLength(text); original(text, operation); };
      const proposal = await vault.proposeCreate(candidate({ type: 'concept', body: 'hello', ...extra }), 'proposer', { agent: 'distiller', proposal: 'add it' });
      await vault.applyCreate(proposal, reviewer);
      expect(sizes.proposeCreate).toBeGreaterThanOrEqual(sizes.create);
    });
  });

  // Review round 2: sizing an id-less candidate must not remap a record that already holds the
  // stand-in id, or links to that record render at the candidate's short file name.
  test('estimate versus applied note: links to an existing record that holds the stand-in id', async () => {
    const vault = open();
    const standInId = '00000000-0000-0000-0000-000000000000';
    await vault.create(candidate({ id: standInId, type: 'concept', title: 'Long title '.repeat(20) }));
    const sizes: Record<string, number> = {};
    const internals = vault as unknown as { assertNoteFits(text: string, operation: string): void };
    const original = internals.assertNoteFits.bind(vault);
    internals.assertNoteFits = (text, operation) => { sizes[operation] = Buffer.byteLength(text); original(text, operation); };
    const kinds = ['source', 'appears-in', 'person', 'related', 'refines'];
    const proposal = await vault.proposeCreate(
      candidate({ id: undefined, type: 'person', title: 'X', body: 'hello', links: kinds.map((kind) => ({ target_id: standInId, kind })) }),
      'proposer',
      { agent: 'distiller', proposal: 'add it' },
    );
    await vault.applyCreate(proposal, '\u007f'.repeat(1022));
    expect(sizes.proposeCreate).toBeGreaterThanOrEqual(sizes.create);
  });

  test('estimate versus applied note: a proposal id that YAML must quote', async () => {
    // A digit-only id is one of the 200-character proposal ids that costs two quote bytes in YAML.
    let counter = 0;
    const digits = new KitObsidianStoreAdapter({
      storeRoot: root,
      coordinationDirectory: join(base, 'coordination'),
      coordinationIdentity: () => () => {},
      lock: standaloneFileMutationLock,
      ids: () => String(++counter).padStart(200, '0'),
    });
    const sizes: Record<string, number> = {};
    const internals = digits as unknown as { assertNoteFits(text: string, operation: string): void };
    const original = internals.assertNoteFits.bind(digits);
    internals.assertNoteFits = (text, operation) => { sizes[operation] = Buffer.byteLength(text); original(text, operation); };
    const proposal = await digits.proposeCreate(candidate({ type: 'concept', body: 'hello' }), 'proposer', { agent: 'distiller', proposal: 'add it' });
    await digits.applyCreate(proposal, '\u007f'.repeat(1022));
    expect(sizes.proposeCreate).toBeGreaterThanOrEqual(sizes.create);
  });

  // Review round 3: an id-less candidate cannot be linked to as itself, so a link that names the
  // stand-in id is a link to an absent record and renders as that id.
  test('estimate versus applied note: links to an absent record that has the stand-in id', async () => {
    // Default UUID ids: short generated ids would hide the few bytes this case is about.
    const vault = new KitObsidianStoreAdapter({
      storeRoot: root,
      coordinationDirectory: join(base, 'coordination'),
      coordinationIdentity: () => () => {},
      lock: standaloneFileMutationLock,
    });
    const sizes: Record<string, number> = {};
    const internals = vault as unknown as { assertNoteFits(text: string, operation: string): void };
    const original = internals.assertNoteFits.bind(vault);
    internals.assertNoteFits = (text, operation) => { sizes[operation] = Buffer.byteLength(text); original(text, operation); };
    const kinds = ['source', 'appears-in', 'person', 'related', 'refines'];
    const proposal = await vault.proposeCreate(
      candidate({ id: undefined, type: 'person', title: 'X', body: 'hello', links: kinds.map((kind) => ({ target_id: '00000000-0000-0000-0000-000000000000', kind })) }),
      'proposer',
      { agent: 'distiller', proposal: 'add it' },
    );
    await vault.applyCreate(proposal, '\u007f'.repeat(1022));
    expect(sizes.proposeCreate).toBeGreaterThanOrEqual(sizes.create);
  });
});
