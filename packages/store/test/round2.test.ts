import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { load } from 'js-yaml';
import { KitDefaultStoreAdapter, KitObsidianStoreAdapter, standaloneFileMutationLock } from '../src/index.js';
import { parseMarkdown, serializeMarkdown } from '../src/shared/frontmatter.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function temporary() { const base = realpathSync(mkdtempSync(join(tmpdir(), 'corpus-round2-'))); roots.push(base); return base; }
function recordPath(profile: string, root: string, id: string): string {
  return profile === 'default' ? join(root, 'records', `${id}.md`) : join(root, JSON.parse(readFileSync(join(root, 'path-index.json'), 'utf8')).by_id[id].path);
}
function yaml(text: string): Record<string, unknown> { return load(text.slice(4, text.indexOf('\n---\n', 4))) as Record<string, unknown>; }
for (const [profile, Constructor] of [['default', KitDefaultStoreAdapter], ['vault', KitObsidianStoreAdapter]] as const) {
  describe(`${profile} round-2 data preservation`, () => {
    for (const name of ['literal', 'strip', 'folded', 'kit-sequence', 'flow']) {
      test(`following keys and parsed values survive ${name} update`, async () => {
        const base = temporary(); const root = join(base, 'store');
        const store = new Constructor({ storeRoot: root, lock: standaloneFileMutationLock, coordinationDirectory: join(base, 'coordination'), coordinationIdentity: () => () => {} });
        const fixture = readFileSync(new URL(`./fixtures/round2/${name}.md`, import.meta.url), 'utf8');
        const { meta, body } = parseMarkdown(fixture);
        await store.create({ id: 'round2-record', type: 'concept', title: 'Record', category: 'engineering', body, provenance: { agent: 'fixture' } });
        const file = recordPath(profile, root, 'round2-record');
        const rendered = readFileSync(file, 'utf8');
        writeFileSync(file, fixture.slice(0, fixture.indexOf('\n---\n', 4)) + rendered.slice(rendered.indexOf('\n---\n', 4)));
        const before = structuredClone(await store.get('round2-record')) as unknown as Record<string, unknown>;
        await store.update('round2-record', { title: 'Updated' }, { agent: 'editor' });
        const after = structuredClone(await store.get('round2-record')) as unknown as Record<string, unknown>;
        expect(after.notes).toBe(before.notes);
        expect(after.custom).toEqual(before.custom);
        if (name === 'kit-sequence') expect((after.mutation_log as unknown[])[0]).toEqual((before.mutation_log as unknown[])[0]);
        expect(after.expires_at).toBe(meta.expires_at);
        expect(after.tags).toEqual(['following']);
        const standard = yaml(readFileSync(recordPath(profile, root, 'round2-record'), 'utf8'));
        expect(standard.expires_at).toBe(meta.expires_at);
        expect(standard.tags).toEqual(['following']);
      });
    }
    test('every written record is standard YAML, including repaired bare dash', async () => {
      const base = temporary(); const root = join(base, 'store');
      const store = new Constructor({ storeRoot: root, lock: standaloneFileMutationLock, coordinationDirectory: join(base, 'coordination'), coordinationIdentity: () => () => {} });
      for (const [index, token] of ['-', '- text', '~', '1.10', '1e3', '0x10'].entries()) {
        const id = 'case-' + index + '-' + token.replaceAll(/[^a-z0-9]/gi, 'x');
        await store.create({ id, type: 'concept', title: id, category: 'engineering', body: 'Body', provenance: { agent: 'fixture' } });
        const file = recordPath(profile, root, id);
        expect(() => yaml(readFileSync(file, 'utf8'))).not.toThrow();
        writeFileSync(file, readFileSync(file, 'utf8').replace('\n---\n', `\nfuture: ${token}\n---\n`));
        const before = (await store.get(id)) as unknown as Record<string, unknown>;
        await store.update(id, { tags: ['changed'] }, { agent: 'editor' });
        const written = readFileSync(recordPath(profile, root, id), 'utf8');
        const standard = yaml(written);
        if (token.startsWith('-')) expect(standard.future).toBe(token);
        expect((await store.get(id) as unknown as Record<string, unknown>).future).toEqual(before.future);
        expect(() => load(serializeMarkdown(parseMarkdown(written).meta, 'Body').split('\n---\n')[0].slice(4))).not.toThrow();
      }
    });
    test('missing coordination identity rejects opening before filesystem I/O', () => {
      const base = temporary(); const root = join(base, 'never-created'); const coordinationDirectory = join(base, 'never-coordination');
      expect(() => new Constructor({ storeRoot: root, coordinationDirectory, lock: standaloneFileMutationLock } as never)).toThrow(/Explicit coordinationIdentity/);
      expect(() => new Constructor({ storeRoot: root, coordinationDirectory, lock: standaloneFileMutationLock, coordinationIdentity: (() => undefined) as never })).toThrow(/must return a recheck/);
      expect(existsSync(root)).toBe(false);
      expect(existsSync(coordinationDirectory)).toBe(false);
    });
  });
}
test('only top-level, single-line, valid lossy plain scalars retain source tokens', () => {
  const original = '---\nprecision: 1.10\nexponent: 1e3\nhex: 0x10\ntilde: ~\ninvalid: -\nnested: { precision: 1.10 }\n---\n\nBody';
  const parsed = parseMarkdown(original);
  const written = serializeMarkdown(parsed.meta, parsed.body);
  for (const [key, token] of [['precision','1.10'],['exponent','1e3'],['hex','0x10'],['tilde','~']]) expect(written).toContain(`${key}: ${token}\n`);
  expect(yaml(written).invalid).toBe('-');
  expect(yaml(written).nested).toEqual({ precision: '1.10' });
  expect(structuredClone(parseMarkdown(written).meta)).toEqual(structuredClone(parsed.meta));
});
