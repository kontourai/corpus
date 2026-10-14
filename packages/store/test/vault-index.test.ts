import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { KitDefaultStoreAdapter, KitObsidianStoreAdapter, standaloneFileMutationLock } from '../src/index.js';

const fixtures = fileURLToPath(new URL('./fixtures/kit-v1/', import.meta.url));
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const tsx = createRequire(import.meta.url).resolve('tsx/cli');
const KIT_IDS = ['kit-compiled-0001', 'kit-compiled-0002', 'kit-concept-0001', 'kit-person-0001', 'kit-raw-0001', 'kit-snapshot-0001'];

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

/** A fresh copy of a committed fixture; tests never write the committed bytes. */
function copy(name: 'kit-vault' | 'hybrid-store'): string {
  const base = mkdtempSync(join(tmpdir(), 'corpus-vault-index-'));
  temporary.push(base);
  const root = join(base, name);
  cpSync(join(fixtures, name), root, { recursive: true });
  return root;
}

function open<T>(Constructor: new (options: any) => T, root: string): T {
  return new Constructor({
    storeRoot: root,
    coordinationDirectory: join(root, '..', 'coordination'),
    coordinationIdentity: () => () => {},
    lock: standaloneFileMutationLock,
  });
}

/** sha256 of every file under root, except the migration's own directory. */
function tree(root: string, { skip = [] as string[] } = {}): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const rel = relative(root, path).split('\\').join('/');
      if (rel === '.corpus-store-migration' || skip.includes(rel)) continue;
      if (entry.isDirectory()) walk(path);
      else result[rel] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  walk(root);
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

function migrate(root: string, ...flags: string[]) {
  const result = spawnSync(process.execPath, [tsx, cli, 'migrate', root, ...flags], { encoding: 'utf8', timeout: 120_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json: result.stdout ? JSON.parse(result.stdout) : undefined };
}

async function snapshot(store: KitObsidianStoreAdapter) {
  return Promise.all(KIT_IDS.map((id) => store.get(id)));
}

describe('vault index selection', () => {
  test('a Knowledge Kit vault opens read-only through its kit-v1 index', async () => {
    const root = copy('kit-vault');
    const before = tree(root);
    const store = open(KitObsidianStoreAdapter, root);
    const concept = await store.get('kit-concept-0001');
    expect(concept?.body).toBe('Users stall at account setup. See [[kit-compiled-0002]].');
    expect((await store.get('research/onboarding-friction'))?.id).toBe('kit-concept-0001');
    expect((await store.listByType('compiled')).map((r) => r.id)).toEqual(['kit-compiled-0002']);
    expect((await store.listByType('compiled', { includeHistory: true })).map((r) => r.id).sort()).toEqual(['kit-compiled-0001', 'kit-compiled-0002']);
    expect(await store.listByType('snapshot')).toEqual([]);
    expect((await store.getLinks('kit-compiled-0001')).reverse).toContainEqual({ source_id: 'kit-compiled-0002', kind: 'supersedes' });
    for (const write of [
      () => store.create({ type: 'raw', title: 'New', body: 'body', category: 'research', provenance: { agent: 'tester' } }),
      () => store.update('kit-concept-0001', { body: 'changed' }, { agent: 'tester' }),
      () => store.retire('kit-concept-0001', 'retired', { agent: 'tester', rationale: 'r' }),
      () => store.reindex(),
    ]) {
      await expect(write()).rejects.toMatchObject({ code: 'READ_ONLY', message: expect.stringContaining('corpus-store migrate') });
    }
    expect(tree(root)).toEqual(before);
  });

  test('an occupied vault without an index is refused instead of read as empty', async () => {
    const root = copy('kit-vault');
    unlinkSync(join(root, '.graph-index.json'));
    const before = tree(root);
    const store = open(KitObsidianStoreAdapter, root);
    for (const call of [
      () => store.get('kit-concept-0001'),
      () => store.listByType('concept'),
      () => store.create({ type: 'raw', title: 'New', body: 'body', category: 'research', provenance: { agent: 'tester' } }),
    ]) {
      await expect(call()).rejects.toThrow(/holds records but has no path-index\.json/);
    }
    // Record notes alone, without any derived index, still count as occupied.
    unlinkSync(join(root, 'graph-index.json'));
    unlinkSync(join(root, 'alias-index.json'));
    await expect(store.listByType('concept')).rejects.toThrow(/holds records but has no path-index\.json/);
    const { 'graph-index.json': _graph, 'alias-index.json': _alias, ...notes } = before;
    expect(tree(root)).toEqual(notes);
  });

  test('an empty root or one with only plain notes opens as a new vault', async () => {
    const base = mkdtempSync(join(tmpdir(), 'corpus-vault-plain-'));
    temporary.push(base);
    const root = join(base, 'vault');
    const empty = open(KitObsidianStoreAdapter, root);
    expect(await empty.listByType('raw')).toEqual([]);
    writeFileSync(join(root, 'README.md'), '# Notes\n\nA plain note without frontmatter.\n');
    writeFileSync(join(root, 'tagged.md'), '---\naliases: [plain]\n---\n\nFrontmatter without a record id or type.\n');
    const id = await empty.create({ type: 'raw', title: 'First', body: 'body', category: 'research', provenance: { agent: 'tester' } });
    expect((await empty.get(id))?.title).toBe('First');
  });

  test('both path indexes at once is a conflict', async () => {
    const root = copy('kit-vault');
    copyFileSync(join(root, '.graph-index.json'), join(root, 'path-index.json'));
    const before = tree(root);
    await expect(open(KitObsidianStoreAdapter, root).get('kit-concept-0001')).rejects.toThrow(/both path-index\.json and \.graph-index\.json/);
    const refused = migrate(root);
    expect(refused.status).toBe(1);
    expect(refused.json.problems.join('\n')).toMatch(/both path-index\.json and \.graph-index\.json exist/);
    expect(tree(root)).toEqual(before);
  });
});

describe('corpus-store migrate', () => {
  test('converts a Kit vault, changes only the index, and the package reads every record identically', async () => {
    const root = copy('kit-vault');
    const originalIndex = readFileSync(join(root, '.graph-index.json'));
    const records = await snapshot(open(KitObsidianStoreAdapter, root));
    const before = tree(root);
    const checked = migrate(root, '--check');
    expect(checked.status, checked.stderr).toBe(0);
    expect(checked.json).toMatchObject({ outcome: 'checked', records: 6, archived: 1, unindexedMarkdown: [] });
    expect(tree(root)).toEqual(before);
    expect(existsSync(join(root, '.corpus-store-migration', 'manifest.json'))).toBe(false);

    const migrated = migrate(root);
    expect(migrated.status, migrated.stderr).toBe(0);
    expect(migrated.json).toMatchObject({ outcome: 'migrated', records: 6, archived: 1, files: 8 });
    const unchanged = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).filter(([file]) => file !== '.graph-index.json' && file !== 'path-index.json'));
    expect(unchanged(tree(root))).toEqual(unchanged(before));
    expect(existsSync(join(root, '.graph-index.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(root, 'path-index.json'), 'utf8'))).toEqual(JSON.parse(originalIndex.toString('utf8')));
    expect(readFileSync(join(root, '.corpus-store-migration', 'kit-v1-path-index.json'))).toEqual(originalIndex);
    const manifest = JSON.parse(readFileSync(join(root, '.corpus-store-migration', 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ state: 'verified', from: { format: 'kit-v1', sha256: createHash('sha256').update(originalIndex).digest('hex') }, to: { format: 'path-index' } });
    expect(manifest.files).toEqual(unchanged(before));
    expect(createHash('sha256').update(readFileSync(join(root, '.corpus-store-migration', 'manifest.json'))).digest('hex')).toBe(migrated.json.manifestSha256);

    const store = open(KitObsidianStoreAdapter, root);
    expect(await snapshot(store)).toEqual(records);
    const id = await store.create({ type: 'raw', title: 'After migration', body: 'body', category: 'research', provenance: { agent: 'tester' } });
    expect((await store.get(id))?.title).toBe('After migration');
    expect(migrate(root).json.outcome).toBe('already-migrated');
  });

  test('converts the hybrid store without touching the default-store records that share its root', async () => {
    const root = copy('hybrid-store');
    const defaults = open(KitDefaultStoreAdapter, root);
    const defaultRecords = await defaults.listByType('raw', { includeHistory: true });
    const vaultRecords = await snapshot(open(KitObsidianStoreAdapter, root));
    const before = tree(root);
    const migrated = migrate(root);
    expect(migrated.status, migrated.stderr).toBe(0);
    expect(migrated.json).toMatchObject({ outcome: 'migrated', records: 6, unindexedMarkdown: ['records/kit-default-compiled-0001.md', 'records/kit-default-raw-0001.md'] });
    const after = tree(root);
    for (const file of ['records/kit-default-raw-0001.md', 'records/kit-default-compiled-0001.md', 'cache-version.json', 'graph-index.json', 'alias-index.json']) {
      expect(after[file], file).toBe(before[file]);
    }
    expect(await defaults.listByType('raw', { includeHistory: true })).toEqual(defaultRecords);
    expect(await snapshot(open(KitObsidianStoreAdapter, root))).toEqual(vaultRecords);
  });

  test('reverses only while the bytes still match, and never overwrites a later edit', async () => {
    const root = copy('kit-vault');
    const before = tree(root);
    expect(migrate(root).status).toBe(0);
    const reversed = migrate(root, '--reverse');
    expect(reversed.status, reversed.stderr).toBe(0);
    expect(reversed.json.outcome).toBe('reversed');
    expect(tree(root)).toEqual(before);
    expect(existsSync(join(root, 'path-index.json'))).toBe(false);

    expect(migrate(root).status).toBe(0);
    const store = open(KitObsidianStoreAdapter, root);
    await store.update('kit-concept-0001', { body: 'Edited after the migration.' }, { agent: 'tester' });
    const edited = tree(root);
    const refused = migrate(root, '--reverse');
    expect(refused.status).toBe(1);
    // A body edit leaves path-index.json as written; the edited note alone blocks reversal.
    expect(refused.json.problems).toEqual(['research/onboarding-friction.md changed']);
    expect(tree(root)).toEqual(edited);
    expect((await store.get('kit-concept-0001'))?.body).toBe('Edited after the migration.');

    // A retitle moves the note, which also changes path-index.json.
    await store.update('kit-person-0001', { title: 'Renamed Interviewee' }, { agent: 'tester' });
    const moved = migrate(root, '--reverse');
    expect(moved.status).toBe(1);
    expect(moved.json.problems).toEqual(expect.arrayContaining([
      'path-index.json changed after the migration',
      'people/example-interviewee.md was removed',
      'people/renamed-interviewee.md was added',
    ]));
  });

  test('refuses an inexact Kit index and writes nothing', () => {
    const cases: Array<[string, (root: string) => void, RegExp]> = [
      ['missing note', (root) => unlinkSync(join(root, 'people', 'example-interviewee.md')), /kit-person-0001: people\/example-interviewee\.md does not exist/],
      ['wrong identity', (root) => {
        const index = JSON.parse(readFileSync(join(root, '.graph-index.json'), 'utf8'));
        const [a, b] = ['kit-person-0001', 'kit-raw-0001'];
        [index.by_id[a].path, index.by_id[b].path] = [index.by_id[b].path, index.by_id[a].path];
        index.by_path[index.by_id[a].path] = a;
        index.by_path[index.by_id[b].path] = b;
        writeFileSync(join(root, '.graph-index.json'), JSON.stringify(index));
      }, /kit-person-0001: research\/interviews\/sources\/interview-notes\.md has frontmatter id "kit-raw-0001"/],
      ['archived flag', (root) => {
        const index = JSON.parse(readFileSync(join(root, '.graph-index.json'), 'utf8'));
        index.by_id['kit-compiled-0001'].archived = false;
        writeFileSync(join(root, '.graph-index.json'), JSON.stringify(index));
      }, /kit-compiled-0001: archived is false but the path is archive\//],
      ['no index', (root) => unlinkSync(join(root, '.graph-index.json')), /neither path-index\.json nor \.graph-index\.json exists/],
    ];
    for (const [label, damage, problem] of cases) {
      const root = copy('kit-vault');
      damage(root);
      const before = tree(root);
      const refused = migrate(root);
      expect(refused.status, label).toBe(1);
      expect(refused.json.outcome, label).toBe('refused');
      expect(refused.json.problems.join('\n'), label).toMatch(problem);
      expect(tree(root), label).toEqual(before);
      expect(existsSync(join(root, '.corpus-store-migration', 'manifest.json')), label).toBe(false);
    }
  });

  test('usage errors exit 2', () => {
    for (const args of [[], ['migrate'], ['convert', '.'], ['migrate', '.', '--bogus'], ['migrate', '.', '--check', '--reverse']]) {
      const result = spawnSync(process.execPath, [tsx, cli, ...args], { encoding: 'utf8' });
      expect(result.status, args.join(' ')).toBe(2);
      expect(result.stderr).toContain('usage: corpus-store migrate');
    }
  });
});
