import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { KitDefaultStoreAdapter, KitObsidianStoreAdapter, standaloneFileMutationLock } from '@kontourai/corpus-store';
const [snapshot, base, reportPath] = process.argv.slice(2);
mkdirSync(join(base, 'station-home'), { mode: 0o700 });
const RealDate = Date;
const time = RealDate.parse('2026-02-01T00:00:00.000Z');
globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [time])); } };
const { KitDefaultStoreAdapter: StationDefault } = await import(pathToFileURL(join(snapshot, 'src-server/knowledge-store/adapters/default-store.ts')));
const { KitObsidianStoreAdapter: StationVault } = await import(pathToFileURL(join(snapshot, 'src-server/knowledge-store/adapters/obsidian-store.ts')));
function recordPath(profile, root, id) { return profile === 'default' ? join(root, 'records', `${id}.md`) : join(root, JSON.parse(readFileSync(join(root, 'path-index.json'), 'utf8')).by_id[id].path); }
function files(root) { return readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath ?? entry.path, entry.name).slice(root.length + 1)).sort(); }
const reports = [];
for (const [profile, Station, Corpus] of [['default', StationDefault, KitDefaultStoreAdapter], ['vault', StationVault, KitObsidianStoreAdapter]]) {
  const stationRoot = join(base, profile, 'station'); const corpusRoot = join(base, profile, 'corpus');
  const station = new Station({ storeRoot: stationRoot });
  const corpus = new Corpus({ storeRoot: corpusRoot, coordinationDirectory: join(base, profile, 'corpus-coordination'), lock: standaloneFileMutationLock, coordinationIdentity: () => () => {}, clock: () => time });
  const scenarios = ['literal', 'strip', 'folded', 'kit-sequence', 'sequence-stable', 'flow', 'flow-stable'];
  for (const scenario of scenarios) {
    const fixtureName = scenario === 'sequence-stable' ? 'kit-sequence' : scenario === 'flow-stable' ? 'flow' : scenario;
    let fixture = readFileSync(new URL(`./fixtures/round2/${fixtureName}.md`, import.meta.url), 'utf8').replace('id: round2-record', `id: ${scenario}`).replace('title: Record', `title: ${scenario}`);
    if (scenario.endsWith('-stable')) fixture = fixture.replace('1.10', 'alpha');
    for (const [adapter, root] of [[station, stationRoot], [corpus, corpusRoot]]) {
      await adapter.create({ id: scenario, type: 'concept', title: scenario, body: 'Body', category: 'engineering', provenance: { agent: 'fixture' } });
      const path = recordPath(profile, root, scenario); const rendered = readFileSync(path, 'utf8');
      writeFileSync(path, fixture.slice(0, fixture.indexOf('\n---\n', 4)) + rendered.slice(rendered.indexOf('\n---\n', 4)));
      const before = await adapter.get(scenario);
      await adapter.update(scenario, { title: `${scenario}-updated`, expires_at: '2030-01-01T00:00:00.000Z', tags: ['following'] }, { agent: 'comparison' });
      const after = await adapter.get(scenario);
      assert.equal(after.notes, before.notes);
      assert.deepEqual(after.custom, before.custom);
      assert.equal(after.expires_at, '2030-01-01T00:00:00.000Z');
      assert.deepEqual(after.tags, ['following']);
      if (fixtureName === 'kit-sequence') assert.deepEqual(after.mutation_log[0], before.mutation_log[0]);
    }
  }
  const stationFiles = files(stationRoot); assert.deepEqual(files(corpusRoot), stationFiles);
  const results = stationFiles.map((file) => {
    const stationBytes = readFileSync(join(stationRoot, file)); const corpusBytes = readFileSync(join(corpusRoot, file));
    const equal = stationBytes.equals(corpusBytes);
    const reason = equal ? 'byte-identical after update' : 'decided unknown-text divergence: nested 1.10 remains a string in Corpus; Station reads/writes numeric 1.1';
    const intended = [recordPath(profile, stationRoot, 'kit-sequence'), recordPath(profile, stationRoot, 'flow')].includes(join(stationRoot, file));
    assert.equal(equal, !intended, `${profile}: unexpected byte result for ${file}`);
    return { file, equal, reason, stationSha256: createHash('sha256').update(stationBytes).digest('hex'), corpusSha256: createHash('sha256').update(corpusBytes).digest('hex') };
  });
  reports.push({ profile, files: results });
}
const report = { stationRevision: '2479f38b1ab062e2d9cd6df9f8fa2cdbeee1d136', corpusRevision: process.env.CORPUS_COMPARISON_SHA ?? 'working tree', node: process.version, reports };
console.log(JSON.stringify(report, null, 2));
if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
