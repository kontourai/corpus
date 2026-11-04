/**
 * Record confidence (kontourai/corpus#68). A bounded number from 0 to 1 travels with a record through
 * propose, apply, read and update, and purge erases it with the rest of a record's content. Both
 * profiles run every test, and every refusal is checked against the bytes on disk.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { load } from 'js-yaml';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  KitDefaultStoreAdapter,
  KitObsidianStoreAdapter,
  standaloneFileMutationLock,
  type CreateInput,
  type KnowledgeStoreAdapter,
  type KnowledgeStoreCreateProposals,
  type KnowledgeStorePurger,
} from '../src/index.js';

type Store = KnowledgeStoreAdapter & KnowledgeStorePurger & KnowledgeStoreCreateProposals;
const purgeEvidence = { agent: 'privacy-officer', rationale: 'erasure request 42' };
const proposalEvidence = { agent: 'compiler', proposal: 'Keep this instinct from the session' };
/** A value no other field in these tests can contain, so a scan of the bytes finds only confidence. */
const MARK = 0.7312;

const source = (id = 'source-1'): CreateInput => ({
  id, type: 'raw', title: `Transcript ${id}`, body: 'The reviewer asked for smaller pull requests.',
  category: 'engineering', provenance: { agent: 'ferry' },
});
const compiled = (fields: Partial<CreateInput> = {}): CreateInput => ({
  id: 'instinct-1', type: 'compiled', title: 'Prefer small pull requests', body: 'Split work so a reviewer can read it in one sitting.',
  category: 'engineering', links: [{ target_id: 'source-1', kind: 'source' }],
  provenance: { agent: 'compiler', source_ids: ['source-1'] }, ...fields,
});

function everything(root: string): string {
  const parts: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      parts.push(path.slice(root.length));
      if (entry.isDirectory()) walk(path);
      else parts.push(readFileSync(path, 'utf8'));
    }
  };
  walk(root);
  return parts.join('\n');
}

async function code(promise: Promise<unknown>): Promise<string | undefined> {
  try { await promise; } catch (error) { return (error as { code?: string }).code ?? `no-code:${(error as Error).message}`; }
  return undefined;
}

describe.each(['default', 'vault'] as const)('record confidence — %s profile', (profile) => {
  let base: string;
  let root: string;
  let store: Store;
  const open = (options: Record<string, unknown> = {}): Store => {
    const Constructor = profile === 'default' ? KitDefaultStoreAdapter : KitObsidianStoreAdapter;
    return new Constructor({
      storeRoot: root,
      coordinationDirectory: join(base, 'coordination'),
      coordinationIdentity: () => () => {},
      lock: standaloneFileMutationLock,
      allowPurge: true,
      ...options,
    }) as unknown as Store;
  };
  const recordPath = (id: string) =>
    profile === 'default'
      ? join(root, 'records', `${id}.md`)
      : join(root, JSON.parse(readFileSync(join(root, 'path-index.json'), 'utf8')).by_id[id].path);
  /** The frontmatter as a YAML reader sees it, which is what another tool reading the note sees. */
  const frontmatter = (id: string): Record<string, unknown> => {
    const text = readFileSync(recordPath(id), 'utf8');
    return load(text.slice(4, text.indexOf('\n---\n', 4))) as Record<string, unknown>;
  };
  const proposalFiles = () => {
    const directory = join(root, '.corpus-proposals');
    return readdirSync(directory).map((name) => join(directory, name));
  };

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), `corpus-confidence-${profile}-`));
    root = join(base, 'store');
    store = open();
    await store.create(source());
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  test('create stores confidence and a fresh reader returns the same number', async () => {
    await store.create(compiled({ confidence: 0.75 }));
    expect((await store.get('instinct-1'))?.confidence).toBe(0.75);
    expect(frontmatter('instinct-1').confidence).toBe(0.75);
    expect(readFileSync(recordPath('instinct-1'), 'utf8')).toMatch(/^confidence: 0\.75$/m);
    expect((await open().get('instinct-1'))?.confidence).toBe(0.75);
    expect((await open().listByType('compiled')).map((record) => record.confidence)).toEqual([0.75]);
  });

  test('a record without confidence has none, and the bounds 0 and 1 are kept', async () => {
    await store.create(compiled({ id: 'none' }));
    await store.create(compiled({ id: 'zero', confidence: 0 }));
    await store.create(compiled({ id: 'one', confidence: 1 }));
    expect(Object.hasOwn((await store.get('none'))!, 'confidence')).toBe(false);
    expect(Object.hasOwn(frontmatter('none'), 'confidence')).toBe(false);
    // A zero is a value, not an absence.
    expect((await store.get('zero'))?.confidence).toBe(0);
    expect(frontmatter('zero').confidence).toBe(0);
    expect((await store.get('one'))?.confidence).toBe(1);
  });

  test('confidence is stored exactly, for numbers that need an exponent or all their digits', async () => {
    const values = [0.1 + 0.2, 1e-7, 5e-324, 0.9999999999999999, 1 / 3];
    for (const [index, confidence] of values.entries()) await store.create(compiled({ id: `exact-${index}`, confidence }));
    const fresh = open();
    for (const [index, confidence] of values.entries()) {
      expect((await fresh.get(`exact-${index}`))?.confidence).toBe(confidence);
      expect(frontmatter(`exact-${index}`).confidence).toBe(confidence);
    }
  });

  test('a confidence inherited from a prototype is never record content', async () => {
    // Only an own property is a field, as for the freshness fields: a polluted prototype must not write one.
    const inherits = <T extends object>(fields: T, extra: object): T => Object.assign(Object.create(extra), fields);
    await store.create(inherits(compiled({ id: 'inherited-create' }), { confidence: 0.75 }));
    expect(Object.hasOwn((await store.get('inherited-create'))!, 'confidence')).toBe(false);

    const staged = await store.proposeCreate(inherits(compiled({ id: 'inherited-proposal' }), { confidence: 0.75 }), 'proposer-1', proposalEvidence);
    expect(Object.hasOwn((await store.getProposal(staged))!.candidate, 'confidence')).toBe(false);

    await store.create(compiled({ id: 'inherited-update', confidence: 0.4 }));
    await store.update('inherited-update', inherits({ title: 'Retitled' }, { confidence: 0.9 }), { agent: 'editor' });
    expect((await store.get('inherited-update'))?.confidence).toBe(0.4);
    // A bad inherited value is not read, so it cannot refuse a good write.
    await store.create(inherits(compiled({ id: 'inherited-bad' }), { confidence: 7 }));
  });

  test('negative zero is stored as zero', async () => {
    await store.create(compiled({ confidence: -0 }));
    expect(Object.is((await open().get('instinct-1'))?.confidence, 0)).toBe(true);
  });

  const refused: [string, unknown][] = [
    ['just above 1', 1.0000001], ['1.01', 1.01], ['2', 2], ['just below 0', -0.0000001], ['-1', -1],
    ['NaN', Number.NaN], ['Infinity', Number.POSITIVE_INFINITY], ['-Infinity', Number.NEGATIVE_INFINITY],
    ['text', '0.5'], ['true', true], ['an array', [0.5]], ['an object', { value: 0.5 }], ['null', null], ['a bigint', 1n],
  ];

  test.each(refused)('create refuses confidence %s and writes nothing', async (_name, confidence) => {
    const before = everything(root);
    expect(await code(store.create(compiled({ confidence: confidence as number })))).toBe('MISSING_EVIDENCE');
    expect(everything(root)).toBe(before);
    expect(await store.get('instinct-1')).toBeNull();
  });

  test.each(refused)('proposeCreate refuses confidence %s and stages nothing', async (_name, confidence) => {
    const before = everything(root);
    expect(await code(store.proposeCreate(compiled({ confidence: confidence as number }), 'proposer-1', proposalEvidence)))
      .toBe('MISSING_EVIDENCE');
    expect(everything(root)).toBe(before);
    expect(await store.listProposals()).toEqual([]);
  });

  test.each(refused.filter(([, value]) => value !== null))('update refuses confidence %s and leaves the record as it was', async (_name, confidence) => {
    await store.create(compiled({ confidence: 0.5 }));
    const before = everything(root);
    expect(await code(store.update('instinct-1', { confidence: confidence as number }, { agent: 'editor' }))).toBe('MISSING_EVIDENCE');
    // A refused confidence stops the whole update, even beside a field that is fine.
    expect(await code(store.update('instinct-1', { title: 'Changed', confidence: confidence as number }, { agent: 'editor' }))).toBe('MISSING_EVIDENCE');
    expect(everything(root)).toBe(before);
    expect((await store.get('instinct-1'))?.confidence).toBe(0.5);
  });

  test('the refusal names the field, the range and the value', async () => {
    await expect(store.create(compiled({ confidence: 1.5 }))).rejects.toThrow('create: confidence must be a number from 0 to 1; got: 1.5');
    await expect(store.create(compiled({ confidence: Number.NaN }))).rejects.toThrow('got: NaN');
    await expect(store.proposeCreate(compiled({ confidence: -2 }), 'proposer-1', proposalEvidence)).rejects.toThrow('proposeCreate: confidence must be a number from 0 to 1; got: -2');
    // The staged copy is JSON, where NaN is null; the refusal still names NaN.
    await expect(store.proposeCreate(compiled({ confidence: Number.NaN }), 'proposer-1', proposalEvidence)).rejects.toThrow('proposeCreate: confidence must be a number from 0 to 1; got: NaN');
  });

  test('propose, apply, read and update carry confidence end to end', async () => {
    const id = await store.proposeCreate(compiled({ confidence: 0.75 }), 'proposer-1', proposalEvidence);
    // Staged: the candidate holds it, and it is not a record yet.
    expect((await store.getProposal(id))?.candidate.confidence).toBe(0.75);
    expect(JSON.parse(readFileSync(proposalFiles()[0]!, 'utf8')).candidate.confidence).toBe(0.75);
    expect(await store.get('instinct-1')).toBeNull();

    expect(await store.applyCreate(id, 'reviewer-1')).toBe('instinct-1');
    expect((await store.get('instinct-1'))?.confidence).toBe(0.75);
    expect(frontmatter('instinct-1').confidence).toBe(0.75);
    expect((await open().get('instinct-1'))?.confidence).toBe(0.75);

    await store.update('instinct-1', { confidence: 0.9 }, { agent: 'editor', note: 'seen again' });
    expect((await open().get('instinct-1'))?.confidence).toBe(0.9);
    expect(frontmatter('instinct-1').confidence).toBe(0.9);
    const log = (await store.get('instinct-1'))!.mutation_log!;
    expect(log.map((entry) => entry.op)).toEqual(['apply-create', 'update']);
    // The log names the field and never the number.
    expect(log[1]!.evidence).toEqual({ fields: ['confidence'] });
  });

  test('a candidate with confidence the record would refuse is refused when staged, not at apply', async () => {
    await expect(store.proposeCreate(compiled({ confidence: 3 }), 'proposer-1', proposalEvidence)).rejects.toThrow(/confidence must be a number/);
    expect(await store.listProposals()).toEqual([]);
  });

  test('update changes, keeps and clears confidence', async () => {
    await store.create(compiled({ confidence: 0.4 }));
    await store.update('instinct-1', { title: 'Retitled' }, { agent: 'editor' });
    expect((await store.get('instinct-1'))?.confidence).toBe(0.4);
    // An explicit undefined means "not supplied"; it neither clears the field nor counts as a change.
    await store.update('instinct-1', { title: 'Retitled again', confidence: undefined }, { agent: 'editor' });
    expect((await store.get('instinct-1'))?.confidence).toBe(0.4);
    expect(await code(store.update('instinct-1', { confidence: undefined }, { agent: 'editor' }))).toBe('MISSING_EVIDENCE');

    await store.update('instinct-1', { confidence: 0 }, { agent: 'editor' });
    expect((await open().get('instinct-1'))?.confidence).toBe(0);
    await store.update('instinct-1', { confidence: null }, { agent: 'editor' });
    expect(Object.hasOwn((await open().get('instinct-1'))!, 'confidence')).toBe(false);
    expect(Object.hasOwn(frontmatter('instinct-1'), 'confidence')).toBe(false);
    // Setting it again after a clear works.
    await store.update('instinct-1', { confidence: 0.6 }, { agent: 'editor' });
    expect((await open().get('instinct-1'))?.confidence).toBe(0.6);
  });

  test('confidence can be added to a record that had none', async () => {
    await store.create(compiled());
    await store.update('instinct-1', { confidence: 0.25 }, { agent: 'editor' });
    expect((await open().get('instinct-1'))?.confidence).toBe(0.25);
  });

  test('later operations on a record keep its confidence', async () => {
    await store.create(compiled({ confidence: 0.8 }));
    await store.create(source('source-2'));
    await store.link('instinct-1', [{ target_id: 'source-2', kind: 'related' }], { agent: 'linker' });
    expect((await open().get('instinct-1'))?.confidence).toBe(0.8);
    await store.reindex?.call(store);
    expect((await open().get('instinct-1'))?.confidence).toBe(0.8);
  });

  describe('request-key idempotency', () => {
    const key = { requestKey: 'instinct-key-1' };
    const stage = (fields: Partial<CreateInput>, evidence = proposalEvidence) =>
      store.proposeCreate(compiled(fields), 'proposer-1', evidence, key);

    test('a retry with the same confidence returns the original proposal', async () => {
      const id = await stage({ confidence: 0.75 });
      expect(await stage({ confidence: 0.75 })).toBe(id);
      expect(await store.listProposals()).toHaveLength(1);
    });

    test('a retry with a different confidence is a conflict and stages nothing', async () => {
      const id = await stage({ confidence: 0.75 });
      expect(await code(stage({ confidence: 0.5 }))).toBe('REQUEST_KEY_CONFLICT');
      expect(await code(stage({ confidence: 0 }))).toBe('REQUEST_KEY_CONFLICT');
      expect(await code(stage({}))).toBe('REQUEST_KEY_CONFLICT');
      const all = await store.listProposals();
      expect(all.map((proposal) => proposal.id)).toEqual([id]);
      expect(all[0]!.candidate.confidence).toBe(0.75);
    });

    test('a retry that adds confidence to a candidate that had none is a conflict', async () => {
      await stage({});
      expect(await code(stage({ confidence: 0.75 }))).toBe('REQUEST_KEY_CONFLICT');
    });

    test('the digest stays bound to the confidence after the proposal is applied', async () => {
      const id = await stage({ confidence: 0.75 });
      await store.applyCreate(id, 'reviewer-1');
      expect(await stage({ confidence: 0.75 })).toBe(id);
      expect(await code(stage({ confidence: 0.76 }))).toBe('REQUEST_KEY_CONFLICT');
      expect((await store.get('instinct-1'))?.confidence).toBe(0.75);
    });

    test('a refused confidence under a key is refused before the key is consulted', async () => {
      const id = await stage({ confidence: 0.75 });
      expect(await code(stage({ confidence: 1.5 }))).toBe('MISSING_EVIDENCE');
      expect(await stage({ confidence: 0.75 })).toBe(id);
    });
  });

  describe('purge', () => {
    const expectGone = () => expect(everything(root)).not.toContain(String(MARK));

    test('the tombstone of a purged record has no confidence', async () => {
      await store.create(compiled({ id: 'victim', confidence: MARK }));
      expect(everything(root)).toContain(String(MARK));
      await store.purge(['victim'], purgeEvidence);
      const stone = (await open().get('victim'))!;
      expect(stone.status).toBe('purged');
      expect(Object.hasOwn(stone, 'confidence')).toBe(false);
      expect(Object.hasOwn(frontmatter('victim'), 'confidence')).toBe(false);
      expectGone();
      await store.reindex?.call(store);
      expectGone();
    });

    test('a record that rested only on a purged source is tombstoned with it', async () => {
      await store.create(compiled({ confidence: MARK }));
      const result = await store.purge(['source-1'], purgeEvidence);
      expect(result.cascaded).toEqual(['instinct-1']);
      expect(Object.hasOwn((await store.get('instinct-1'))!, 'confidence')).toBe(false);
      expectGone();
    });

    test('a survivor that has other support keeps the confidence its writer gave it', async () => {
      await store.create(source('source-2'));
      await store.create(compiled({
        confidence: MARK,
        links: [{ target_id: 'source-1', kind: 'source' }, { target_id: 'source-2', kind: 'source' }],
        provenance: { agent: 'compiler', source_ids: ['source-1', 'source-2'] },
      }));
      const result = await store.purge(['source-1'], purgeEvidence);
      expect(result.survivors).toEqual(['instinct-1']);
      expect((await store.get('instinct-1'))?.confidence).toBe(MARK);
    });

    test('purging a pending proposal by id erases the confidence in its candidate', async () => {
      const id = await store.proposeCreate(compiled({ confidence: MARK }), 'proposer-1', proposalEvidence);
      expect(everything(root)).toContain(String(MARK));
      await store.purgeProposal(id, purgeEvidence);
      const erased = (await store.getProposal(id))!;
      expect(erased.state).toBe('rejected');
      expect(Object.hasOwn(erased.candidate, 'confidence')).toBe(false);
      expectGone();
    });

    test('purging an applied proposal erases the record and the candidate', async () => {
      const id = await store.proposeCreate(compiled({ confidence: MARK }), 'proposer-1', proposalEvidence);
      await store.applyCreate(id, 'reviewer-1');
      await store.purgeProposal(id, purgeEvidence);
      expect(Object.hasOwn((await store.get('instinct-1'))!, 'confidence')).toBe(false);
      expect(Object.hasOwn((await store.getProposal(id))!.candidate, 'confidence')).toBe(false);
      expectGone();
    });

    test('a source purge scrubs a pending proposal that rested only on it', async () => {
      const id = await store.proposeCreate(compiled({ confidence: MARK }), 'proposer-1', proposalEvidence);
      await store.purge(['source-1'], purgeEvidence);
      expect(Object.hasOwn((await store.getProposal(id))!.candidate, 'confidence')).toBe(false);
      expectGone();
    });

    test('a request key is retired with the erased candidate, so a retry cannot restage the confidence', async () => {
      const key = { requestKey: 'erased-instinct' };
      const id = await store.proposeCreate(compiled({ confidence: MARK }), 'proposer-1', proposalEvidence, key);
      await store.purgeProposal(id, purgeEvidence);
      expect(await code(store.proposeCreate(compiled({ confidence: MARK }), 'proposer-1', proposalEvidence, key))).toBe('REQUEST_KEY_CONFLICT');
      expect(await code(store.proposeCreate(compiled({ confidence: 0.1 }), 'proposer-1', proposalEvidence, key))).toBe('REQUEST_KEY_CONFLICT');
      expectGone();
    });

    test('an erased proposal that still holds a confidence is corrupt, not trusted', async () => {
      const id = await store.proposeCreate(compiled({ confidence: MARK }), 'proposer-1', proposalEvidence);
      await store.purgeProposal(id, purgeEvidence);
      const path = proposalFiles().find((file) => file.endsWith(`${id}.json`))!;
      const proposal = JSON.parse(readFileSync(path, 'utf8'));
      proposal.candidate.confidence = MARK;
      writeFileSync(path, `${JSON.stringify(proposal, null, 2)}\n`);
      await expect(store.purgeProposal(id, purgeEvidence)).rejects.toThrow(/is corrupt: an erased proposal is not what a purge writes/);
    });
  });

  describe('reading a record from disk', () => {
    test.each([['above 1', '1.5'], ['below 0', '-0.1'], ['not a number', 'high'], ['quoted', '"0.5"'], ['not a number value', '.nan'], ['infinite', '.inf'], ['null', 'null']])(
      'a hand-edited confidence that is %s is corruption, not a value',
      async (_name, edited) => {
        await store.create(compiled({ confidence: 0.75 }));
        const path = recordPath('instinct-1');
        writeFileSync(path, readFileSync(path, 'utf8').replace('confidence: 0.75', `confidence: ${edited}`));
        await expect(open().get('instinct-1')).rejects.toThrow(/confidence must be a number from 0 to 1/);
      },
    );

    test('a confidence in a note an older writer made is read as the number it is', async () => {
      await store.create(compiled());
      const path = recordPath('instinct-1');
      writeFileSync(path, readFileSync(path, 'utf8').replace(/^status: active$/m, 'status: active\nconfidence: 0.5'));
      expect((await open().get('instinct-1'))?.confidence).toBe(0.5);
    });
  });
});

describe('vault dimensions', () => {
  test('a dimension cannot be named confidence, which would overwrite the field', () => {
    const base = mkdtempSync(join(tmpdir(), 'corpus-confidence-dimension-'));
    try {
      const make = (dimensions: string[]) => new KitObsidianStoreAdapter({
        storeRoot: join(base, 'store'),
        coordinationDirectory: join(base, 'coordination'),
        coordinationIdentity: () => () => {},
        lock: standaloneFileMutationLock,
        dimensions,
      });
      expect(() => make(['confidence'])).toThrow(/do not replace record fields/);
      expect(() => make(['certainty'])).not.toThrow();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
