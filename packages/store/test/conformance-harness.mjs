import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dump, load } from 'js-yaml';
import { KitDefaultStoreAdapter, KitObsidianStoreAdapter, standaloneFileMutationLock } from '@kontourai/corpus-store';

export const input = (id, fields = {}) => ({ id, type: 'raw', title: id, body: 'original body', category: 'engineering', provenance: { agent: 'creator' }, ...fields });
export function createStore(profile, root, coordinationDirectory) {
  const Constructor = profile === 'default' ? KitDefaultStoreAdapter : KitObsidianStoreAdapter;
  return new Constructor({ storeRoot: root, coordinationDirectory, coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock });
}
export async function recordPath(profile, root, id) {
  if (profile === 'default') return join(root, 'records', `${id}.md`);
  return join(root, JSON.parse(await readFile(join(root, 'path-index.json'), 'utf8')).by_id[id].path);
}
export async function child(args) {
  const processChild = spawn(process.execPath, [fileURLToPath(new URL('./store-child.mjs', import.meta.url)), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  processChild.stderr.on('data', (data) => { stderr += data; });
  const code = await new Promise((resolve, reject) => {
    processChild.once('error', reject);
    processChild.once('exit', resolve);
  });
  return { code, stderr };
}
export async function makeHarness(profile) {
  const base = await mkdtemp(join(tmpdir(), 'corpus-conformance-'));
  const root = join(base, 'store');
  const coordinationDirectory = join(base, 'coordination', 'knowledge-file-transactions');
  const adapter = createStore(profile, root, coordinationDirectory);
  async function edit(id, mutate) {
    const path = await recordPath(profile, root, id);
    const text = await readFile(path, 'utf8');
    const end = text.indexOf('\n---\n', 4);
    const meta = load(text.slice(4, end));
    mutate(meta);
    await writeFile(path, `---\n${dump(meta, { lineWidth: -1 }).trimEnd()}\n---\n${text.slice(end + 5)}`);
  }
  async function files(directory = root) {
    const result = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) result.push(...await files(path));
      else result.push(path);
    }
    return result;
  }
  const specials = {
    async 'body-not-frontmatter'({ values }) {
      const text = await readFile(await recordPath(profile, root, values.a), 'utf8');
      const end = text.indexOf('\n---\n', 4);
      assert.equal(Object.hasOwn(load(text.slice(4, end)), 'body'), false);
      assert.equal((await adapter.get(values.a)).body, 'original body');
      return { check: true };
    },
    async reindex({ operation, values }) {
      const indexes = ['graph-index.json', 'alias-index.json'];
      if (operation.mode !== 'idempotent') {
        for (const name of indexes) {
          if (operation.mode === 'lost') await rm(join(root, name), { force: true });
          else await writeFile(join(root, name), '{corrupt');
        }
      }
      await adapter.reindex();
      const links = await adapter.getLinks(values.b);
      assert.ok(links.reverse.some((link) => link.source_id === values.a && link.kind === 'related'));
      assert.equal((await adapter.get(values.a)).body, 'original body');
      const before = await Promise.all(indexes.map((name) => readFile(join(root, name), 'utf8')));
      await adapter.reindex();
      assert.deepEqual(await Promise.all(indexes.map((name) => readFile(join(root, name), 'utf8'))), before);
      return { check: true };
    },
    async 'legacy-label'({ values }) {
      await edit(values.a, (meta) => { meta.links[0].label = 'evil\nlabel\rwith\nnewlines'; });
      assert.equal((await adapter.get(values.a)).links[0].label, 'evil\nlabel\rwith\nnewlines');
      return {};
    },
    async 'concurrent-create'() {
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => child([profile, root, coordinationDirectory, 'create', `parallel-${i}`])));
      assert.deepEqual(results.filter((result) => result.code !== 0), []);
      const records = await adapter.listByType('raw');
      assert.equal(records.length, 8);
      assert.equal(new Set(records.map((record) => record.id)).size, 8);
      for (let i = 0; i < 8; i++) assert.equal((await adapter.get(`parallel-${i}`)).title, `parallel-${i}`);
      return { check: true };
    },
    async 'concurrent-update'() {
      await adapter.create(input('shared-record'));
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => child([profile, root, coordinationDirectory, 'update', `editor-${i}`])));
      assert.deepEqual(results.filter((result) => result.code !== 0), []);
      const record = await adapter.get('shared-record');
      assert.equal(record.mutation_log.length, 8);
      assert.deepEqual(record.mutation_log.map((entry) => entry.agent).sort(), Array.from({ length: 8 }, (_, i) => `editor-${i}`));
      assert.equal(record.tags.length, 1);
      assert.match(record.tags[0], /^editor-[0-7]$/);
      return { check: true };
    },
    async 'interrupted-create'() {
      for (const mode of ['prepared', 'first-publish', 'final-publish', 'committed']) {
        const crashRoot = join(base, mode);
        const result = await child([profile, crashRoot, coordinationDirectory, 'crash', mode]);
        assert.equal(result.code, 23, result.stderr);
        const journal = JSON.parse(await readFile(join(crashRoot, '.station-knowledge-transaction.json'), 'utf8'));
        assert.equal(journal.version, 1);
        const reopened = createStore(profile, crashRoot, coordinationDirectory);
        const recovered = await reopened.get('crashed-record');
        if (mode === 'final-publish' || mode === 'committed') assert.equal(recovered.id, 'crashed-record');
        else assert.equal(recovered, null);
        await assert.rejects(readFile(join(crashRoot, '.station-knowledge-transaction.json')), { code: 'ENOENT' });
      }
      return { check: true };
    },
    async 'traversal-create'() {
      const outside = join(base, 'escape.md');
      await writeFile(outside, 'outside original');
      for (const id of ['../escape', '../../escape', '/absolute', 'a/b', 'a\\b']) {
        try {
          const created = await adapter.create(input(id));
          assert.equal((await adapter.get(created)).id, id);
          assert.ok((await adapter.listByType('raw')).some((record) => record.id === id));
        } catch (error) {
          if (error.code !== 'MISSING_EVIDENCE') throw error;
        }
      }
      assert.equal(await readFile(outside, 'utf8'), 'outside original');
      assert.ok((await files()).every((path) => path.startsWith(root + '/')));
      return { check: true };
    },
    async 'physical-id-unindexed'() {
      await adapter.create(input('physical-record'));
      const path = await recordPath(profile, root, 'physical-record');
      const before = await readFile(path, 'utf8');
      if (profile === 'vault') await rm(join(root, 'path-index.json'));
      await rm(join(root, 'alias-index.json'), { force: true });
      await assert.rejects(adapter.create(input('physical-record', { title: 'Replacement' })));
      assert.equal(await readFile(path, 'utf8'), before);
      return { check: true };
    },
    async 'physical-id-archived'() {
      await adapter.create(input('archived-record', { type: 'compiled' }));
      await adapter.create(input('replacement-record', { type: 'compiled' }));
      await adapter.supersede('replacement-record', ['archived-record'], { agent: 'editor', rationale: 'obsolete' });
      const path = await recordPath(profile, root, 'archived-record');
      const before = await readFile(path, 'utf8');
      if (profile === 'vault') {
        assert.match(path, /archive/);
        await rm(join(root, 'path-index.json'));
      }
      await assert.rejects(adapter.create(input('archived-record')));
      assert.equal(await readFile(path, 'utf8'), before);
      return { check: true };
    },
    async 'physical-id-mismatch'() {
      await adapter.create(input('physical-record'));
      const path = await recordPath(profile, root, 'physical-record');
      await edit('physical-record', (meta) => { meta.id = 'other-identity'; });
      const before = await readFile(path, 'utf8');
      await assert.rejects(adapter.get('physical-record'));
      await assert.rejects(adapter.create(input('physical-record')));
      assert.equal(await readFile(path, 'utf8'), before);
      return { check: true };
    },
    async 'symlink-record'() {
      await adapter.create(input('linked-record'));
      const path = await recordPath(profile, root, 'linked-record');
      const outside = join(base, 'outside.md');
      const before = await readFile(path, 'utf8');
      await writeFile(outside, before);
      await rm(path);
      await symlink(outside, path);
      await assert.rejects(adapter.get('linked-record'));
      await assert.rejects(adapter.update('linked-record', { title: 'changed' }, { agent: 'editor' }));
      assert.equal(await readFile(outside, 'utf8'), before);
      return { check: true };
    },
    async 'graph-integrity'({ values }) {
      const graph = JSON.parse(await readFile(join(root, 'graph-index.json'), 'utf8'));
      assert.ok(graph.forward[values.a].some((link) => link.target_id === values.b && link.kind === 'related'));
      assert.ok(graph.reverse[values.b].some((link) => link.source_id === values.a && link.kind === 'related'));
      const before = await adapter.getLinks(values.b);
      await adapter.reindex();
      assert.deepEqual(await adapter.getLinks(values.b), before);
      return { check: true };
    },
    async 'identity-path-list'() {
      const ids = ['Mixed_ID-1.10', 'physical-00000001'];
      for (const id of ids) await adapter.create(input(id));
      assert.deepEqual((await adapter.listByType('raw')).map((record) => record.id).sort(), ids.sort());
      for (const id of ids) {
        assert.equal((await adapter.get(id)).id, id);
        assert.match(await readFile(await recordPath(profile, root, id), 'utf8'), new RegExp(`id: ${id}`));
      }
      return { check: true };
    },
    async 'read-fixture'({ operation }) {
      const a = await adapter.create(input('aaaaaaaa-0000-0000-0000-000000000001', { category: 'engineering.api', aliases: ['engineering/raw'], ttl_seconds: 60 }));
      const b = await adapter.create(input('bbbbbbbb-0000-0000-0000-000000000002', { type: 'concept', category: 'engineering.api.deep', links: [{ target_id: a, kind: 'related' }] }));
      if (operation.retired) await adapter.retire(a, 'retired', { agent: 'editor', rationale: 'obsolete' });
      return { a, b };
    },
  };
  return { adapter, specials, root, coordinationDirectory, dispose: () => rm(base, { recursive: true, force: true }) };
}
