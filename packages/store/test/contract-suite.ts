/**
 * Shared `KnowledgeStoreAdapter` contract-test suite (store-contract.md §6/§A.5/§B.4/
 * §H) — run against BOTH Station-owned Kit-format adapters (`kit-default-store`,
 * `kit-obsidian-store`) so a behavioral guarantee proven here holds identically
 * regardless of which adapter backs a root. This is the test-level expression of the
 * design doc's dual-adapter dogfood requirement (AC1's "per-adapter... round-trip"
 * language, made literal by construction rather than by two independently-maintained
 * copies of the same assertions).
 *
 * Deliberately excluded from this shared suite (kept adapter-specific, in each
 * adapter's own `*.contract.test.ts`): on-disk file/path shape assertions
 * (`records/<id>.md` vs. category-path-routed vault layout), `reindex()` /
 * corrupt-index self-heal logging assertions (adapter-internal index filenames
 * differ), and anything that depends on a specific physical file location.
 * Listing after `supersede` was once excluded because the adapters diverged; the
 * owner's working-set decision (2026-10-13) made it identical, and it is asserted
 * below for both adapters.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KnowledgeStoreAdapter } from '../src/contracts.js';
import * as yaml from 'js-yaml';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type Mock,
  test,
} from 'vitest';

interface ContractSuiteOptions {
  /** Adapters that route by category-as-path (Obsidian) can't accept dotted collision
   * ids sharing an 8-char prefix in the SAME slug-path test the way the flat
   * `records/<id>.md` layout can — both adapters support explicit caller ids
   * regardless, so this is always exercised; no option needed today. Reserved for
   * future adapter-specific suite toggles. */
  label: string;
  createAdapter: (
    storeRoot: string,
  ) => KnowledgeStoreAdapter | Promise<KnowledgeStoreAdapter>;
  /**
   * Resolve the absolute on-disk path of a record's `.md` file, given the store root
   * and record id. Adapter-specific because physical layout differs (`kit-default-
   * store`'s flat `records/<id>.md` vs. `kit-obsidian-store`'s category-path-routed
   * vault layout resolved via its `path-index.json`). Required only by the
   * tests below that tamper with or read the record file directly — every other
   * shared-suite test goes through the public adapter API only.
   */
  findRecordFilePath: (dir: string, id: string) => string;
  /** The `warn` spy the calling file installs on the shared logger factory. */
  loggerWarnSpy: Mock;
}

/**
 * Registers a `describe` block (via vitest's globals) exercising the adapter-agnostic
 * `KnowledgeStoreAdapter` contract against a real `mkdtempSync(tmpdir())` store per
 * test. Call from within an adapter's own `*.contract.test.ts` file.
 */
export function runAdapterContractSuite(options: ContractSuiteOptions): void {
  const { label, createAdapter, findRecordFilePath, loggerWarnSpy } = options;

  describe(`${label} — shared KnowledgeStoreAdapter contract (store-contract.md §6/§A.5/§B.4/§H)`, () => {
    let dir: string;
    let adapter: KnowledgeStoreAdapter;

    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), `${label}-contract-`));
      adapter = await createAdapter(dir);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    test('creates a raw → compiled → concept chain with source/example links', async () => {
      const rawId = await adapter.create({
        type: 'raw',
        title: 'Customer call transcript',
        body: 'The customer said the onboarding flow was confusing.',
        category: 'engineering.onboarding',
        provenance: { agent: 'ingest-agent' },
      });

      const compiledId = await adapter.create({
        type: 'compiled',
        title: 'Onboarding confusion summary',
        body: 'Users report onboarding is confusing.',
        category: 'engineering.onboarding',
        links: [{ target_id: rawId, kind: 'source' }],
        provenance: { agent: 'compile-agent', source_ids: [rawId] },
      });

      const conceptId = await adapter.create({
        type: 'concept',
        title: 'Onboarding friction',
        body: 'Friction points encountered during first-run setup.',
        category: 'engineering.onboarding',
        links: [{ target_id: compiledId, kind: 'example' }],
        provenance: { agent: 'concept-agent' },
      });

      const compiled = await adapter.get(compiledId);
      expect(compiled?.links).toEqual([{ target_id: rawId, kind: 'source' }]);

      const concept = await adapter.get(conceptId);
      expect(concept?.links).toEqual([
        { target_id: compiledId, kind: 'example' },
      ]);

      const compiledLinks = await adapter.getLinks(compiledId);
      expect(compiledLinks.forward).toEqual([
        { target_id: rawId, kind: 'source' },
      ]);
      const rawLinks = await adapter.getLinks(rawId);
      expect(rawLinks.reverse).toEqual([
        { source_id: compiledId, kind: 'source' },
      ]);

      const conceptLinks = await adapter.getLinks(conceptId);
      expect(conceptLinks.forward).toEqual([
        { target_id: compiledId, kind: 'example' },
      ]);
      const compiledReverse = await adapter.getLinks(compiledId);
      expect(compiledReverse.reverse).toEqual([
        { source_id: conceptId, kind: 'example' },
      ]);
    });

    test('compiled create requires a source link to an existing raw record', async () => {
      const raw = await adapter.create({ type: 'raw', title: 'Raw input', body: 'evidence', category: 'engineering', provenance: { agent: 'agent-1' } });
      const concept = await adapter.create({ type: 'concept', title: 'A concept', body: 'definition', category: 'engineering', provenance: { agent: 'agent-1' } });
      const compiled = (title: string, fields: Record<string, unknown>) => adapter.create({
        type: 'compiled', title, body: 'summary', category: 'engineering', provenance: { agent: 'agent-1' }, ...fields,
      });
      for (const [title, fields] of [
        ['No links', {}],
        ['Provenance only', { provenance: { agent: 'agent-1', source_ids: [raw] } }],
        ['Related, not source', { links: [{ target_id: raw, kind: 'related' }] }],
        ['Missing source', { links: [{ target_id: 'missing-raw-record', kind: 'source' }] }],
        ['Concept source', { links: [{ target_id: concept, kind: 'source' }] }],
        ['Wikilink only', { body: `See [[${raw}]]` }],
      ] as const) {
        await expect(compiled(title, fields)).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });
      }
      expect(await adapter.listByType('compiled', { includeHistory: true })).toEqual([]);
      const id = await compiled('Sourced', { links: [{ target_id: concept, kind: 'source' }, { target_id: raw, kind: 'source' }] });
      expect((await adapter.get(id))?.type).toBe('compiled');
      // Only creation is checked: a compiled record may later drop its links.
      await adapter.update(id, { links: [], body: 'edited' }, { agent: 'agent-1' });
      expect((await adapter.get(id))?.body).toBe('edited');
    });

    test('create rejects missing/invalid required fields with MISSING_EVIDENCE', async () => {
      const base = {
        type: 'raw' as const,
        title: 'T',
        body: 'B',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      };

      await expect(
        adapter.create({ ...base, type: undefined as any }),
      ).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });
      await expect(
        adapter.create({ ...base, type: 'invalid-type' as any }),
      ).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });
      await expect(
        adapter.create({ ...base, title: '' }),
      ).rejects.toMatchObject({
        code: 'MISSING_EVIDENCE',
      });
      await expect(adapter.create({ ...base, body: '' })).rejects.toMatchObject(
        {
          code: 'MISSING_EVIDENCE',
        },
      );
      await expect(
        adapter.create({ ...base, category: '' }),
      ).rejects.toMatchObject({
        code: 'MISSING_EVIDENCE',
      });
      await expect(
        adapter.create({ ...base, category: 'Bad Category!' }),
      ).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });
      await expect(
        adapter.create({ ...base, provenance: { agent: '' } }),
      ).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });
    });

    // M1 (Wave-2 review): this pinning test was previously default-store-only
    // (`default-store.contract.test.ts`) despite proving an adapter-agnostic
    // guarantee. Moved here so BOTH `kit-default-store` and `kit-obsidian-store` run
    // it — see `findRecordFilePath` on `ContractSuiteOptions` for the adapter-specific
    // file-location lookup this test needs (the guarantee itself is not adapter-
    // specific; only where the `.md` file lives on disk is).
    test('preserves unknown frontmatter keys and unknown type strings on round-trip (never dropped on rewrite)', async () => {
      // Forward-compat tenet (Open Knowledge Format v0.1 alignment, design-input note): a
      // conforming reader/writer must tolerate and PRESERVE fields/type strings it doesn't
      // recognize — never silently drop them on a rewrite. Simulate a record written by some
      // future producer (a foreign top-level key + a not-yet-canonical `type`) by writing the
      // file directly (bypassing this adapter's own `create()`, which validates `type` against
      // the CURRENT known set — that validation is a write-time contract gate for NEW Station-
      // authored records, not a read-time filter).
      const id = await adapter.create({
        type: 'raw',
        title: 'Forward-compat fixture',
        body: 'original body',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });

      const filePath = findRecordFilePath(dir, id);
      const before = readFileSync(filePath, 'utf-8');
      const endIdx = before.indexOf('\n---\n', 4);
      const frontmatter = yaml.load(before.slice(4, endIdx)) as Record<
        string,
        unknown
      >;
      frontmatter.type = 'future-record-type';
      frontmatter.custom_future_field = 'preserved-value';
      const bodyText = before.slice(endIdx + 5).replace(/^\n+/, '');
      writeFileSync(
        filePath,
        `---\n${yaml.dump(frontmatter, { lineWidth: -1 }).trimEnd()}\n---\n\n${bodyText}`,
        'utf-8',
      );

      const read = await adapter.get(id);
      expect(read?.type).toBe('future-record-type');
      expect(
        (read as unknown as Record<string, unknown>).custom_future_field,
      ).toBe('preserved-value');

      const listed = await adapter.listByType('future-record-type' as any);
      expect(listed.find((r) => r.id === id)).toBeDefined();

      await adapter.update(id, { title: 'Renamed' }, { agent: 'agent-1' });
      const after = await adapter.get(id);
      expect(after?.type).toBe('future-record-type');
      expect(
        (after as unknown as Record<string, unknown>).custom_future_field,
      ).toBe('preserved-value');
      expect(after?.title).toBe('Renamed');

      // Re-resolve the file path AFTER update() — an adapter that routes by
      // title/category (Obsidian) may have moved the file when the title changed;
      // `kit-default-store`'s flat `records/<id>.md` path is stable either way.
      const filePathAfter = findRecordFilePath(dir, id);
      const raw = readFileSync(filePathAfter, 'utf-8');
      const end2 = raw.indexOf('\n---\n', 4);
      const fm2 = yaml.load(raw.slice(4, end2)) as Record<string, unknown>;
      expect(fm2.custom_future_field).toBe('preserved-value');
      expect(fm2.type).toBe('future-record-type');
    });

    // A metadata-only mutation such as `retire()` never touches links itself, so
    // an already-bad legacy or externally authored label would persist unless
    // `writeRecord` sanitizes on every persisted write.
    test('a legacy newline-label already on disk is sanitized on the very next write, even through a metadata-only mutation (retire) that never touches links itself', async () => {
      const targetId = await adapter.create({
        type: 'concept',
        title: 'Link target',
        body: 'target body',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });
      const sourceId = await adapter.create({
        type: 'concept',
        title: 'Legacy label source',
        body: 'Original body.',
        category: 'engineering',
        links: [
          {
            target_id: targetId,
            kind: 'related',
            label: 'SAFE_PLACEHOLDER_LABEL',
          },
        ],
        provenance: { agent: 'agent-1' },
      });
      const filePath = findRecordFilePath(dir, sourceId);
      const readFrontmatter = () => {
        const raw = readFileSync(filePath, 'utf-8');
        return yaml.load(raw.slice(4, raw.indexOf('\n---\n', 4))) as {
          links: Array<{ label?: string }>;
          status: string;
        };
      };

      // Hand-tamper the on-disk frontmatter, bypassing the adapter's own
      // sanitize-on-write path, and confirm a real embedded newline landed.
      const maliciousLabel = 'evil\nlabel\nwith\nnewlines';
      writeFileSync(
        filePath,
        readFileSync(filePath, 'utf-8').replace(
          'label: SAFE_PLACEHOLDER_LABEL',
          `label: ${JSON.stringify(maliciousLabel)}`,
        ),
        'utf-8',
      );
      expect(readFrontmatter().links[0].label).toBe(maliciousLabel);

      loggerWarnSpy.mockClear();
      await adapter.retire(sourceId, 'retired', {
        agent: 'agent-1',
        rationale: 'no longer relevant',
      });

      const after = readFrontmatter();
      expect(after.status).toBe('retired');
      expect(after.links[0].label).toBe('evil label with newlines');
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('embedded line break'),
        expect.objectContaining({
          original: maliciousLabel,
          sanitized: 'evil label with newlines',
        }),
      );
      // The public record carries the same sanitized label, not only the bytes.
      const record = await adapter.get(sourceId);
      expect(record?.links?.[0].label).toBe('evil label with newlines');
    });

    test('update requires an existing record, evidence.agent, and >=1 mutable field', async () => {
      const id = await adapter.create({
        type: 'raw',
        title: 'T',
        body: 'B',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });

      await expect(
        adapter.update('nonexistent-id', { title: 'x' }, { agent: 'agent-1' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      await expect(
        adapter.update(id, { title: 'x' }, {} as any),
      ).rejects.toMatchObject({
        code: 'MISSING_EVIDENCE',
      });

      await expect(
        adapter.update(id, {}, { agent: 'agent-1' }),
      ).rejects.toMatchObject({
        code: 'MISSING_EVIDENCE',
      });

      await adapter.update(
        id,
        { title: 'Updated title' },
        { agent: 'agent-1' },
      );
      const updated = await adapter.get(id);
      expect(updated?.title).toBe('Updated title');
      expect(updated?.mutation_log?.at(-1)).toMatchObject({
        op: 'update',
        agent: 'agent-1',
      });
    });

    test('link is idempotent and rejects unknown source/target', async () => {
      const a = await adapter.create({
        type: 'raw',
        title: 'A',
        body: 'a',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });
      const b = await adapter.create({
        type: 'raw',
        title: 'B',
        body: 'b',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });

      await adapter.link(a, [{ target_id: b, kind: 'related' }], {
        agent: 'agent-1',
      });
      await adapter.link(a, [{ target_id: b, kind: 'related' }], {
        agent: 'agent-1',
      });
      const links = await adapter.getLinks(a);
      expect(links.forward).toEqual([{ target_id: b, kind: 'related' }]);

      await expect(
        adapter.link('nonexistent', [{ target_id: b, kind: 'related' }], {
          agent: 'agent-1',
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        adapter.link(a, [{ target_id: 'nonexistent', kind: 'related' }], {
          agent: 'agent-1',
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        adapter.link(a, [], { agent: 'agent-1' }),
      ).rejects.toMatchObject({
        code: 'MISSING_EVIDENCE',
      });
    });

    test('propose → apply gates a concept body change through a proposes link; reject leaves it unchanged', async () => {
      const concept = await adapter.create({
        type: 'concept',
        title: 'Concept A',
        body: 'Original definition',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });
      const proposer = await adapter.create({
        type: 'raw',
        title: 'Proposal source',
        body: 'evidence for the proposal',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });

      await expect(
        adapter.propose(concept, proposer, { agent: 'agent-1' } as any),
      ).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });

      await adapter.propose(concept, proposer, {
        agent: 'agent-1',
        proposal: 'Broaden the definition',
      });

      await expect(
        adapter.apply(concept, proposer, {
          agent: 'agent-1',
          new_body: 'Broadened definition',
        } as any),
      ).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });

      await adapter.apply(concept, proposer, {
        agent: 'agent-1',
        new_body: 'Broadened definition',
        rationale: 'Field evidence supports it',
      });

      const updatedConcept = await adapter.get(concept);
      expect(updatedConcept?.body).toBe('Broadened definition');

      const proposer2 = await adapter.create({
        type: 'raw',
        title: 'Second proposal source',
        body: 'more evidence',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });
      await adapter.propose(concept, proposer2, {
        agent: 'agent-1',
        proposal: 'Narrow it back',
      });
      await adapter.reject(concept, proposer2, {
        agent: 'agent-1',
        reason: 'Not enough evidence',
      });
      const afterReject = await adapter.get(concept);
      expect(afterReject?.body).toBe('Broadened definition');

      await expect(
        adapter.apply(concept, 'nonexistent-proposer', {
          agent: 'agent-1',
          new_body: 'x',
          rationale: 'y',
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    // propose/apply/reject may target a record of any type (owner decision,
    // 2026-10-13). The evidence, existence and proposes-link checks still apply.

    test('propose and apply accept a target of every record type; reject accepts a non-concept target', async () => {
      const source = await adapter.create({
        type: 'raw',
        title: 'Compiled source',
        body: 'source evidence',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });
      const proposer = await adapter.create({
        type: 'raw',
        title: 'Proposer',
        body: 'evidence',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });
      for (const type of ['raw', 'compiled', 'concept', 'snapshot', 'person'] as const) {
        const target = await adapter.create({
          type,
          title: `Target ${type}`,
          body: 'Original body',
          category: 'engineering',
          provenance: { agent: 'agent-1' },
          ...(type === 'compiled' ? { links: [{ target_id: source, kind: 'source' }] } : {}),
        });
        await adapter.propose(target, proposer, { agent: 'agent-1', proposal: 'Change it' });
        await adapter.apply(target, proposer, { agent: 'agent-1', new_body: `Applied ${type}`, rationale: 'Evidence supports it' });
        const record = await adapter.get(target);
        expect(record?.type).toBe(type);
        expect(record?.body).toBe(`Applied ${type}`);
        expect(record?.mutation_log?.map((entry) => entry.op)).toEqual(['propose', 'apply']);
        expect((await adapter.getLinks(target)).reverse).toEqual([{ source_id: proposer, kind: 'proposes' }]);
      }
      const snapshot = await adapter.create({
        type: 'snapshot',
        title: 'Rejected target',
        body: 'Original body',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });
      await adapter.propose(snapshot, proposer, { agent: 'agent-1', proposal: 'Revert it' });
      await adapter.reject(snapshot, proposer, { agent: 'agent-1', reason: 'Not enough evidence' });
      const rejected = await adapter.get(snapshot);
      expect(rejected?.body).toBe('Original body');
      expect(rejected?.mutation_log?.map((entry) => entry.op)).toEqual(['propose', 'reject']);
    }, 60_000);

    test('apply and reject on a non-concept target still require the proposer\'s proposes link', async () => {
      const target = await adapter.create({
        type: 'snapshot',
        title: 'Snapshot target',
        body: 'Original body',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });
      const proposer = await adapter.create({
        type: 'raw',
        title: 'Unlinked proposer',
        body: 'evidence',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });
      await expect(
        adapter.apply(target, proposer, { agent: 'agent-1', new_body: 'x', rationale: 'y' }),
      ).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });
      await expect(
        adapter.reject(target, proposer, { agent: 'agent-1', reason: 'no' }),
      ).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });
      await expect(
        adapter.propose(target, proposer, { agent: 'agent-1', proposal: '   ' }),
      ).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });
      await expect(
        adapter.propose(target, 'nonexistent-proposer', { agent: 'agent-1', proposal: 'Change it' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const record = await adapter.get(target);
      expect(record?.body).toBe('Original body');
      expect(record?.mutation_log ?? []).toEqual([]);
    });

    test('propose rejects a nonexistent concept_id with NOT_FOUND', async () => {
      const proposer = await adapter.create({
        type: 'raw',
        title: 'Proposal source',
        body: 'evidence',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });

      await expect(
        adapter.propose('nonexistent-concept', proposer, {
          agent: 'agent-1',
          proposal: 'Broaden the definition',
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    test('reject rejects a nonexistent concept_id with NOT_FOUND', async () => {
      const proposer = await adapter.create({
        type: 'raw',
        title: 'Proposal source',
        body: 'evidence',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });

      await expect(
        adapter.reject('nonexistent-concept', proposer, {
          agent: 'agent-1',
          reason: 'Not applicable',
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    // supersede (Addendum A.5/A.6): superseded records stay gettable with a reverse
    // `supersedes` link, and leave the working set in both adapters.

    test('supersede never deletes; superseded records remain gettable with a reverse supersedes link', async () => {
      const source = await adapter.create({
        type: 'raw',
        title: 'Summary source',
        body: 'source evidence',
        category: 'engineering.sources',
        provenance: { agent: 'agent-1' },
      });
      const oldCompiled = await adapter.create({
        type: 'compiled',
        title: 'Old summary',
        body: 'stale content',
        category: 'engineering',
        links: [{ target_id: source, kind: 'source' }],
        provenance: { agent: 'agent-1' },
      });
      const newCompiled = await adapter.create({
        type: 'compiled',
        title: 'New summary',
        body: 'fresh content',
        category: 'engineering',
        links: [{ target_id: source, kind: 'source' }],
        provenance: { agent: 'agent-1' },
      });

      await expect(
        adapter.supersede(newCompiled, [oldCompiled], {
          agent: 'agent-1',
        } as any),
      ).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });

      await adapter.supersede(newCompiled, [oldCompiled], {
        agent: 'agent-1',
        rationale: 'Newer data supersedes the old summary',
      });

      const old = await adapter.get(oldCompiled);
      expect(old).not.toBeNull();
      expect(old?.body).toBe('stale content');
      expect(old?.mutation_log?.some((e) => e.op === 'superseded-by')).toBe(
        true,
      );

      const oldLinks = await adapter.getLinks(oldCompiled);
      expect(oldLinks.reverse).toEqual(
        expect.arrayContaining([
          { source_id: newCompiled, kind: 'supersedes' },
        ]),
      );

      await expect(
        adapter.supersede(newCompiled, [], {
          agent: 'agent-1',
          rationale: 'x',
        }),
      ).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });
      await expect(
        adapter.supersede('nonexistent', [oldCompiled], {
          agent: 'agent-1',
          rationale: 'x',
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    test('lists return the working set; includeHistory adds superseded and retired records', async () => {
      const ids = async (records: Promise<{ id: string }[]>) => (await records).map((r) => r.id).sort();
      const source = await adapter.create({ type: 'raw', title: 'Source', body: 'evidence', category: 'history.sources', provenance: { agent: 'agent-1' } });
      const compiled = (title: string) => adapter.create({ type: 'compiled', title, body: title, category: 'history', provenance: { agent: 'agent-1' }, links: [{ target_id: source, kind: 'source' }] });
      const superseded = await compiled('Superseded summary');
      const current = await compiled('Current summary');
      const retired = await compiled('Retired summary');
      const implemented = await compiled('Implemented summary');
      await adapter.supersede(current, [superseded], { agent: 'agent-1', rationale: 'newer' });
      await adapter.retire(retired, 'retired', { agent: 'agent-1', rationale: 'obsolete' });
      await adapter.retire(implemented, 'implemented', { agent: 'agent-1', rationale: 'done', implementedByRef: 'change-1' });

      const working = [current, implemented].sort();
      const history = [current, implemented, retired, superseded].sort();
      expect(await ids(adapter.listByType('compiled'))).toEqual(working);
      expect(await ids(adapter.listByCategory('history'))).toEqual(working);
      expect(await ids(adapter.listByType('compiled', { includeHistory: true }))).toEqual(history);
      expect(await ids(adapter.listByCategory('history', { includeHistory: true }))).toEqual(history);
      expect((await ids(adapter.listByCategory('history', { prefix: true, includeHistory: true })))).toEqual([...history, source].sort());
      // The deprecated alias is translated to includeHistory, superseded records included.
      expect(await ids(adapter.listByType('compiled', { includeRetired: true }))).toEqual(history);
      expect(await ids(adapter.listByCategory('history', { includeRetired: true }))).toEqual(history);
      expect(await ids(adapter.listByType('compiled', { includeHistory: false }))).toEqual(working);
      // get and getLinks always reach history.
      expect((await adapter.get(superseded))?.id).toBe(superseded);
      expect((await adapter.get(retired))?.status).toBe('retired');
    });

    // retire (Addendum B.2/B.4/B.5) — status-based working-set exclusion is identical
    // across both adapters (neither archives on retire; only supersede archives).

    test('retire enforces the status transition table and working-set exclusion', async () => {
      const source = await adapter.create({
        type: 'raw',
        title: 'Retire source',
        body: 'source evidence',
        category: 'engineering.sources',
        provenance: { agent: 'agent-1' },
      });
      const id = await adapter.create({
        type: 'compiled',
        title: 'To retire',
        body: 'content',
        category: 'engineering',
        links: [{ target_id: source, kind: 'source' }],
        provenance: { agent: 'agent-1' },
      });

      await expect(
        adapter.retire(id, 'retired', { agent: 'agent-1' } as any),
      ).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });
      await expect(
        adapter.retire(id, 'implemented', {
          agent: 'agent-1',
          rationale: 'shipped',
        }),
      ).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });

      await adapter.retire(id, 'implemented', {
        agent: 'agent-1',
        rationale: 'shipped',
        implementedByRef: 'PR#123',
      });
      let record = await adapter.get(id);
      expect(record?.status).toBe('implemented');

      await adapter.retire(id, 'retired', {
        agent: 'agent-1',
        rationale: 'fully done',
      });
      record = await adapter.get(id);
      expect(record?.status).toBe('retired');

      await expect(
        adapter.retire(id, 'implemented', {
          agent: 'agent-1',
          rationale: 'x',
          implementedByRef: 'y',
        }),
      ).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });

      const listed = await adapter.listByType('compiled');
      expect(listed.find((r) => r.id === id)).toBeUndefined();
      const listedWithRetired = await adapter.listByType('compiled', {
        includeHistory: true,
      });
      expect(listedWithRetired.find((r) => r.id === id)).toBeDefined();

      const byCategory = await adapter.listByCategory('engineering');
      expect(byCategory.find((r) => r.id === id)).toBeUndefined();
      const byCategoryWithRetired = await adapter.listByCategory(
        'engineering',
        {
          includeHistory: true,
        },
      );
      expect(byCategoryWithRetired.find((r) => r.id === id)).toBeDefined();

      expect(record?.provenance.agent).toBe('agent-1');
    });

    test('retire on a direct active -> retired transition also succeeds', async () => {
      const id = await adapter.create({
        type: 'concept',
        title: 'Direct retire',
        body: 'content',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });
      await adapter.retire(id, 'retired', {
        agent: 'agent-1',
        rationale: 'obsolete',
      });
      const record = await adapter.get(id);
      expect(record?.status).toBe('retired');
    });

    test('listByCategory supports exact and prefix matching', async () => {
      await adapter.create({
        type: 'concept',
        title: 'API concept',
        body: 'b',
        category: 'engineering.api',
        provenance: { agent: 'agent-1' },
      });
      await adapter.create({
        type: 'concept',
        title: 'REST concept',
        body: 'b',
        category: 'engineering.api.rest',
        provenance: { agent: 'agent-1' },
      });
      await adapter.create({
        type: 'concept',
        title: 'Unrelated',
        body: 'b',
        category: 'design',
        provenance: { agent: 'agent-1' },
      });

      const exact = await adapter.listByCategory('engineering.api');
      expect(exact).toHaveLength(1);

      const prefixed = await adapter.listByCategory('engineering.api', {
        prefix: true,
      });
      expect(prefixed).toHaveLength(2);
    });

    describe('Addendum H — identity resolution', () => {
      test('resolves by exact id', async () => {
        const id = await adapter.create({
          type: 'raw',
          title: 'Exact id test',
          body: 'b',
          category: 'engineering',
          provenance: { agent: 'agent-1' },
        });
        const record = await adapter.get(id);
        expect(record?.id).toBe(id);
      });

      test('resolves by slug alias and survives a category restructure', async () => {
        const id = await adapter.create({
          type: 'concept',
          title: 'Slug test',
          body: 'b',
          category: 'decision.strategy',
          aliases: ['decision.strategy/2026-07-05-gtm-direction'],
          provenance: { agent: 'agent-1' },
        });

        const bySlug = await adapter.get(
          'decision.strategy/2026-07-05-gtm-direction',
        );
        expect(bySlug?.id).toBe(id);

        await adapter.update(
          id,
          { category: 'decision.gtm' },
          { agent: 'agent-1' },
        );
        const stillResolves = await adapter.get(
          'decision.strategy/2026-07-05-gtm-direction',
        );
        expect(stillResolves?.id).toBe(id);
        expect(stillResolves?.category).toBe('decision.gtm');
      });

      test('aliases are append-only across update calls', async () => {
        const id = await adapter.create({
          type: 'concept',
          title: 'Append-only aliases',
          body: 'b',
          category: 'engineering',
          aliases: ['engineering/first-alias'],
          provenance: { agent: 'agent-1' },
        });
        await adapter.update(
          id,
          { aliases: ['engineering/second-alias'] },
          { agent: 'agent-1' },
        );
        const record = await adapter.get(id);
        expect(record?.aliases).toEqual(
          expect.arrayContaining([
            'engineering/first-alias',
            'engineering/second-alias',
          ]),
        );
        expect(await adapter.get('engineering/first-alias')).toMatchObject({
          id,
        });
        expect(await adapter.get('engineering/second-alias')).toMatchObject({
          id,
        });
      });

      test('a slug already owned by a different record is SLUG_CONFLICT', async () => {
        await adapter.create({
          type: 'concept',
          title: 'Owner',
          body: 'b',
          category: 'engineering',
          aliases: ['engineering/shared-slug'],
          provenance: { agent: 'agent-1' },
        });
        await expect(
          adapter.create({
            type: 'concept',
            title: 'Collider',
            body: 'b',
            category: 'engineering',
            aliases: ['engineering/shared-slug'],
            provenance: { agent: 'agent-1' },
          }),
        ).rejects.toMatchObject({ code: 'SLUG_CONFLICT' });
      });

      test('resolves an unambiguous >=8-char id prefix', async () => {
        const id = await adapter.create({
          type: 'raw',
          title: 'Prefix test',
          body: 'b',
          category: 'engineering',
          provenance: { agent: 'agent-1' },
        });
        const prefix = id.slice(0, 8);
        const record = await adapter.get(prefix);
        expect(record?.id).toBe(id);
      });

      test('a sub-8-char handle never prefix-matches (resolves to null, not a match)', async () => {
        const id = await adapter.create({
          type: 'raw',
          title: 'Short handle test',
          body: 'b',
          category: 'engineering',
          provenance: { agent: 'agent-1' },
        });
        const shortHandle = id.slice(0, 4);
        const record = await adapter.get(shortHandle);
        expect(record).toBeNull();
      });

      test('an ambiguous id prefix throws AMBIGUOUS_ID with .matches', async () => {
        const sharedPrefix = 'aaaaaaaa';
        const idA = `${sharedPrefix}-1111-4111-8111-111111111111`;
        const idB = `${sharedPrefix}-2222-4222-8222-222222222222`;
        await adapter.create({
          id: idA,
          type: 'raw',
          title: 'A',
          body: 'b',
          category: 'engineering',
          provenance: { agent: 'agent-1' },
        });
        await adapter.create({
          id: idB,
          type: 'raw',
          title: 'B',
          body: 'b',
          category: 'engineering',
          provenance: { agent: 'agent-1' },
        });

        await expect(adapter.get(sharedPrefix)).rejects.toMatchObject({
          code: 'AMBIGUOUS_ID',
          matches: expect.arrayContaining([idA, idB]),
        });
        await expect(adapter.getLinks(sharedPrefix)).rejects.toMatchObject({
          code: 'AMBIGUOUS_ID',
        });
      });

      test('an unresolved handle returns null from get and empty arrays from getLinks', async () => {
        expect(
          await adapter.get('00000000-0000-0000-0000-000000000000'),
        ).toBeNull();
        const links = await adapter.getLinks(
          '00000000-0000-0000-0000-000000000000',
        );
        expect(links).toEqual({ forward: [], reverse: [] });
      });
    });
  });
}
