import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dump, load } from 'js-yaml';
import { assertAdapterBoundTo, initializeRootBinding, KitDefaultStoreAdapter, KitObsidianStoreAdapter, standaloneFileMutationLock } from '@kontourai/corpus-store';

export const input = (id, fields = {}) => ({ id, type: 'raw', title: id, body: 'original body', category: 'engineering', provenance: { agent: 'creator' }, ...fields });
export function createStore(profile, root, coordinationDirectory) {
  const Constructor = profile === 'default' ? KitDefaultStoreAdapter : KitObsidianStoreAdapter;
  return new Constructor({ storeRoot: root, coordinationDirectory, coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock, allowPurge: true, allowReviewedConfidence: true });
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
  let retainFixture = false;
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
  async function folders(directory = root) {
    const result = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(directory, entry.name);
      result.push(path, ...await folders(path));
    }
    return result;
  }
  const deadline = async (promise, ms, phase) => {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`reviewed-confidence ${profile}: ${phase} timed out`)), ms); })]);
    } finally { clearTimeout(timer); }
  };
  function reviewedChild(mode, value) {
    const proc = spawn(process.execPath, [fileURLToPath(new URL('./store-child.mjs', import.meta.url)), profile, root, coordinationDirectory, mode, JSON.stringify(value)], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = ''; let closed = false; let processError; let inputError;
    proc.on('error', (error) => { processError = error; });
    const streamsAvailable = Boolean(proc.stdin && proc.stdout && proc.stderr);
    proc.stdin?.on('error', (error) => { inputError = error; });
    proc.stdout?.on('error', (error) => { err += ` stdout: ${error.message}`; });
    proc.stderr?.on('error', (error) => { err += ` stderr: ${error.message}`; });
    // An error is evidence of failure, but only close settles child/pipe ownership.
    const done = new Promise((resolve) => {
      proc.once('close', (status, signal) => { closed = true; resolve({ status, signal, out, err, processError, inputError }); });
    });
    let readyResolve;
    const ready = new Promise((resolve) => { readyResolve = resolve; });
    proc.stdout?.on('data', (chunk) => { out += chunk; if (out.includes('ready\n')) readyResolve(); });
    proc.stderr?.on('data', (chunk) => { err += chunk; });
    const send = () => new Promise((resolve, reject) => {
      if (!proc.stdin) return reject(new Error(`reviewed-confidence ${profile}: ${mode} stdin unavailable`));
      if (inputError) return reject(inputError);
      proc.stdin.end('go', (error) => error || inputError ? reject(error ?? inputError) : resolve());
    });
    async function stop() {
      if (closed) return;
      proc.kill('SIGTERM');
      try { await deadline(done, 2000, `${mode} termination`); return; } catch { /* escalate only our own child */ }
      if (!closed) proc.kill('SIGKILL');
      try { await deadline(done, 2000, `${mode} forced termination`); }
      catch {
        retainFixture = true;
        // Preserve the root while releasing parent-side references if close never arrives.
        proc.stdin?.destroy(); proc.stdout?.destroy(); proc.stderr?.destroy(); proc.unref();
        throw new Error(`reviewed-confidence ${profile}: ${mode} child did not close; fixture retained at ${base}`);
      }
    }
    return { proc, ready, done, send, stop, streamsAvailable };
  }
  const specials = {
    async 'reviewed-confidence'({ operation }) {
      const mode = operation.mode;
      assert.ok(['replay', 'stale-evidence', 'erased-evidence', 'default-deny', 'literal-digest', 'erased-target', 'missing-evidence', 'race', 'crash', 'stale-target', 'wrong-root', 'retired-evidence', 'wrong-old-confidence'].includes(mode), 'unknown reviewed-confidence mode');
      const digest = (c) => `sha256:${createHash('sha256').update(JSON.stringify([
        'corpus-reviewed-confidence-candidate-v1', c.rootBinding, c.recordId, c.revision,
        c.oldConfidence, c.newConfidence, c.evidence.map((e) => [e.id, e.revision]),
      ])).digest('hex')}`;
      if (mode === 'literal-digest') {
        const { reviewedConfidenceCandidateDigest } = await import('@kontourai/corpus-store');
        const candidate = { rootBinding: '0'.repeat(64), recordId: 'target', revision: `record-rev1:${'1'.repeat(64)}`, oldConfidence: 0.3, newConfidence: 0.7, evidence: [{ id: 'source', revision: `record-rev1:${'2'.repeat(64)}` }] };
        return { actual: reviewedConfidenceCandidateDigest(candidate), independent: digest(candidate) };
      }
      await adapter.create(input('target', { confidence: 0.3 }));
      await adapter.create(input('source', { confidence: 0.3 }));
      const target = await adapter.reviewedConfidenceSnapshot('target');
      const source = await adapter.reviewedConfidenceSnapshot('source');
      const candidate = { rootBinding: target.rootBinding, recordId: 'target', revision: target.revision, oldConfidence: 0.3, newConfidence: 0.7, evidence: [{ id: 'source', revision: source.revision }] };
      const request = { ...candidate, candidateDigest: digest(candidate), authorizationDigest: `sha256:${'a'.repeat(64)}`, requestKey: 'reviewed-key', agent: 'reviewer' };
      const code = async (fn) => { try { await fn(); return 'RESOLVED'; } catch (error) { return error.code ?? 'NO_CODE'; } };
      if (mode === 'default-deny') {
        const Constructor = profile === 'default' ? KitDefaultStoreAdapter : KitObsidianStoreAdapter;
        const closed = new Constructor({ storeRoot: root, coordinationDirectory, coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock });
        return { result: await code(() => closed.applyReviewedConfidence(request)), score: (await adapter.get('target')).confidence };
      }
      if (mode === 'wrong-old-confidence') {
        const before = await readFile(await recordPath(profile, root, 'target'));
        const wrong = { ...candidate, oldConfidence: 0.4 };
        const result = await code(() => adapter.applyReviewedConfidence({ ...request, ...wrong, candidateDigest: digest(wrong) }));
        const after = await readFile(await recordPath(profile, root, 'target'));
        const receipts = await readdir(join(root, '.corpus-reviewed-confidence')).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
        return { result, unchanged: before.equals(after), receipts: receipts.filter((name) => name.endsWith('.json')).length };
      }
      if (mode === 'stale-target') {
        await adapter.update('target', { body: 'changed target' }, { agent: 'editor' });
        return { result: await code(() => adapter.applyReviewedConfidence(request)), score: (await adapter.get('target')).confidence };
      }
      if (mode === 'wrong-root') {
        const wrong = { ...candidate, rootBinding: '0'.repeat(64) };
        return { result: await code(() => adapter.applyReviewedConfidence({ ...request, ...wrong, candidateDigest: digest(wrong) })), score: (await adapter.get('target')).confidence };
      }
      if (mode === 'retired-evidence') {
        await adapter.retire('source', 'retired', { agent: 'editor', rationale: 'obsolete' });
        return { result: await code(() => adapter.applyReviewedConfidence(request)), score: (await adapter.get('target')).confidence };
      }
      if (mode === 'missing-evidence') {
        const missing = { ...candidate, evidence: [{ id: 'missing', revision: source.revision }] };
        return { result: await code(() => adapter.applyReviewedConfidence({ ...request, ...missing, candidateDigest: digest(missing) })), score: (await adapter.get('target')).confidence };
      }
      if (mode === 'race') {
        const other = { ...candidate, newConfidence: 0.8 };
        const requests = [request, { ...request, ...other, candidateDigest: digest(other), requestKey: 'other-key' }];
        const racers = [];
        try {
          for (const item of requests) {
            const racer = reviewedChild('reviewed-race', item);
            racers.push(racer);
            assert.ok(racer.streamsAvailable, `reviewed-confidence ${profile}: race child streams unavailable`);
          }
          await deadline(Promise.all(racers.map((r) => Promise.race([r.ready, r.done.then(() => { throw new Error(`reviewed-confidence ${profile}: racer exited before ready`); })]))), 30000, 'race readiness');
          await deadline(Promise.all(racers.map((r) => r.send())), 30000, 'race start');
          const results = await deadline(Promise.all(racers.map((r) => r.done)), 30000, 'race completion');
          for (const result of results) { assert.ifError(result.processError); assert.ifError(result.inputError); assert.equal(result.status, 0, `reviewed-confidence ${profile}: racer failed: ${result.err}`); }
          return { applied: results.filter((x) => x.out.includes('applied\n')).length, stale: results.filter((x) => x.out.includes('error:STALE_REVISION\n')).length, updates: (await adapter.get('target')).mutation_log.filter((x) => x.op === 'update').length };
        } finally {
          const stopped = await Promise.allSettled(racers.map((r) => r.stop()));
          const failed = stopped.find((r) => r.status === 'rejected');
          if (failed) throw failed.reason;
        }
      }
      if (mode === 'crash') {
        const phase = operation.phase; assert.ok(['prepared', 'first-publish', 'final-publish', 'committed'].includes(phase));
        const processChild = reviewedChild('reviewed-crash', { phase, request });
        let outcome;
        try {
          assert.ok(processChild.streamsAvailable, `reviewed-confidence ${profile}: crash ${phase} child streams unavailable`);
          outcome = await deadline(processChild.done, 30000, `crash ${phase} completion`);
        }
        finally { await processChild.stop(); }
        assert.ifError(outcome.processError);
        assert.equal(outcome.status, 23, `reviewed-confidence ${profile}: crash ${phase}: ${outcome.err}`);
        const reopened = createStore(profile, root, coordinationDirectory);
        const prior = await reopened.get('target');
        const before = prior.confidence; const countBefore = prior.mutation_log.filter((x) => x.op === 'update').length;
        const receiptFiles = await readdir(join(root, '.corpus-reviewed-confidence')).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
        const receiptsBefore = receiptFiles.filter((name) => name.endsWith('.json')).length;
        const receipt = await reopened.applyReviewedConfidence(request);
        const repeated = await createStore(profile, root, coordinationDirectory).applyReviewedConfidence(request);
        return { before, countBefore, receiptsBefore, sameReceipt: JSON.stringify(receipt) === JSON.stringify(repeated), score: (await reopened.get('target')).confidence, updates: (await reopened.get('target')).mutation_log.filter((x) => x.op === 'update').length };
      }
      const first = await adapter.applyReviewedConfidence(request);
      if (mode === 'replay') {
        const repeated = await adapter.applyReviewedConfidence(request);
        const changed = { ...candidate, newConfidence: 0.8 };
        return { sameReceipt: JSON.stringify(first) === JSON.stringify(repeated), score: (await adapter.get('target')).confidence,
          conflict: await code(() => adapter.applyReviewedConfidence({ ...request, ...changed, candidateDigest: digest(changed) })) };
      }
      if (mode === 'stale-evidence') {
        await adapter.update('source', { body: 'changed evidence' }, { agent: 'editor' });
        return { result: await code(() => adapter.applyReviewedConfidence(request)), score: (await adapter.get('target')).confidence };
      }
      await adapter.purge([mode === 'erased-target' ? 'target' : 'source'], { agent: 'eraser', rationale: 'requested' });
      const receipt = JSON.parse(await readFile(join(root, '.corpus-reviewed-confidence', `${first.receiptId}.json`), 'utf8'));
      return { result: await code(() => adapter.applyReviewedConfidence(request)), retired: receipt.retired, keys: Object.keys(receipt).sort() };
    },
    async 'root-binding'({ operation }) {
      assert.ok(['match', 'alias', 'mismatch', 'rescaffold', 'legacy', 'purge', 'purge-proposal'].includes(operation.mode), 'unknown root-binding mode');
      if (operation.mode === 'match') assertAdapterBoundTo(adapter, root);
      if (operation.mode === 'purge' || operation.mode === 'purge-proposal') {
        const initial = adapter.rootBinding(); const marker = await readFile(join(root, '.corpus-root-id'), 'utf8');
        if (operation.mode === 'purge') {
          await adapter.create(input('binding-purge'));
          await adapter.purge(['binding-purge'], { agent: 'eraser', rationale: 'requested' });
        } else {
          const proposal = await adapter.proposeCreate(input('binding-purge-proposal'), 'proposer-1', { agent: 'drafter', proposal: 'binding drill' });
          await adapter.purgeProposal(proposal, { agent: 'eraser', rationale: 'requested' });
        }
        await adapter.reindex();
        if (operation.mode === 'purge') assert.equal((await adapter.get('binding-purge')).status, 'purged');
        assert.equal(adapter.rootBinding(), initial); assert.equal(await readFile(join(root, '.corpus-root-id'), 'utf8'), marker);
        assert.equal(createStore(profile, root, coordinationDirectory).rootBinding(), initial);
        assertAdapterBoundTo(adapter, root);
        const other = join(base, 'other'); createStore(profile, other, coordinationDirectory);
        assert.throws(() => assertAdapterBoundTo(adapter, other), { code: 'ROOT_BINDING_MISMATCH' });
      }
      if (operation.mode === 'legacy') {
        const legacy = join(base, 'legacy'); await mkdir(legacy);
        const unbound = createStore(profile, legacy, coordinationDirectory);
        assert.throws(() => assertAdapterBoundTo(unbound, legacy), { code: 'ROOT_BINDING_MISMATCH' });
        await assert.rejects(readFile(join(legacy, '.corpus-root-id')), { code: 'ENOENT' });
        const options = { storeRoot: legacy, coordinationDirectory, coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock };
        await initializeRootBinding(options); const bound = createStore(profile, legacy, coordinationDirectory);
        const before = bound.rootBinding(); const bytes = await readFile(join(legacy, '.corpus-root-id'), 'utf8');
        await initializeRootBinding(options);
        assert.equal(await readFile(join(legacy, '.corpus-root-id'), 'utf8'), bytes);
        assert.equal(createStore(profile, legacy, coordinationDirectory).rootBinding(), before);
        assertAdapterBoundTo(bound, legacy);
      }
      if (operation.mode === 'alias') {
        const alias = join(base, 'alias'); await symlink(root, alias);
        assertAdapterBoundTo(adapter, alias);
      }
      if (operation.mode === 'mismatch') {
        const other = join(base, 'other'); createStore(profile, other, coordinationDirectory);
        assert.throws(() => assertAdapterBoundTo(adapter, other), { code: 'ROOT_BINDING_MISMATCH' });
      }
      if (operation.mode === 'rescaffold') {
        await rm(root, { recursive: true, force: true }); createStore(profile, root, coordinationDirectory);
        assert.throws(() => assertAdapterBoundTo(adapter, root), { code: 'ROOT_BINDING_MISMATCH' });
      }
      return { check: true };
    },
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
      await adapter.create(input('archive-source'));
      const sourced = { type: 'compiled', links: [{ target_id: 'archive-source', kind: 'source' }] };
      await adapter.create(input('archived-record', sourced));
      await adapter.create(input('replacement-record', sourced));
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
    async 'purge-store-bytes'({ operation }) {
      // Every byte the store keeps, and every path, as the thing a reader of the disk sees.
      const scan = async () => {
        const entries = await Promise.all((await files()).map(async (path) => ({ path: path.slice(root.length + 1), text: await readFile(path, 'utf8') })));
        // Empty folders keep names too (a vault routes notes into category folders).
        return [...entries, ...(await folders()).map((path) => ({ path: path.slice(root.length + 1), text: '' }))];
      };
      const seen = await scan();
      const found = (marker) => seen.some((file) => file.text.includes(marker) || file.path.includes(marker));
      if (operation.mode === 'present') {
        // The scan must be able to see the content, or an empty result proves nothing.
        for (const marker of operation.markers) {
          if (profile === 'default' && marker === 'ember-zebra-interview') continue; // only the vault names files by title
          assert.ok(found(marker), `scan must see ${JSON.stringify(marker)} before the purge`);
        }
        return { check: true };
      }
      if (operation.mode === 'rebuilt') {
        // Derived projections must rebuild without the content.
        await rm(join(root, 'graph-index.json'), { force: true });
        await rm(join(root, 'alias-index.json'), { force: true });
        await adapter.reindex();
        return await (async () => {
          const rebuilt = await scan();
          for (const marker of operation.markers) assert.equal(rebuilt.some((file) => file.text.includes(marker) || file.path.includes(marker)), false, `${JSON.stringify(marker)} reappeared after reindex`);
          return { check: true };
        })();
      }
      // `subject: "proposal"` is for a proposal erasure, which has no record of its own to check.
      if (operation.subject !== 'proposal') assert.equal((await adapter.get('purge-bytes-a')).status, 'purged');
      for (const marker of operation.markers) assert.equal(found(marker), false, `${JSON.stringify(marker)} is still on disk`);
      // No plain digest of any erased value, in any common encoding.
      for (const marker of operation.markers) {
        for (const algorithm of ['md5', 'sha1', 'sha256', 'sha512']) {
          const digest = createHash(algorithm).update(marker).digest();
          for (const form of [digest.toString('hex'), digest.toString('base64'), digest.toString('base64url')]) {
            assert.equal(seen.some((file) => file.text.toLowerCase().includes(form.toLowerCase())), false, `${algorithm} of ${JSON.stringify(marker)} is on disk`);
          }
        }
      }
      return { check: true };
    },
    async 'purge-journal-erasure'() {
      const marker = 'JOURNAL-MARKER-ALPHA-7';
      const journalPath = join(root, '.station-knowledge-transaction.json');
      const seed = async (id) => {
        await adapter.create(input(id, { body: marker }));
        await adapter.create(input(`${id}-dependent`, { type: 'compiled', body: `${marker} dependent`, links: [{ target_id: id, kind: 'source' }] }));
      };
      // Crash after the commit marker: the journal left behind holds no erased content.
      await seed('journal-committed');
      const committed = await child([profile, root, coordinationDirectory, 'crash-purge', 'committed,journal-committed']);
      assert.equal(committed.code, 23, committed.stderr);
      const journal = JSON.parse(await readFile(journalPath, 'utf8'));
      assert.equal(journal.phase, 'committed');
      assert.equal(journal.operation, 'purge');
      assert.ok(journal.entries.length >= 2, 'the journal must name the purged files');
      for (const entry of journal.entries) {
        for (const side of [entry.before, entry.after]) {
          if (side !== null) assert.equal(Buffer.from(side, 'base64').toString('utf8').includes(marker), false, `${entry.path} still holds erased content in the journal`);
        }
      }
      const reopened = createStore(profile, root, coordinationDirectory);
      assert.equal((await reopened.get('journal-committed')).status, 'purged');
      assert.equal((await reopened.get('journal-committed-dependent')).status, 'purged');
      await assert.rejects(readFile(journalPath), { code: 'ENOENT' });
      // A purge that never reached its commit marker is rolled back whole, never half applied.
      for (const phase of ['prepared', 'first-publish']) {
        const id = `journal-${phase}`;
        await seed(id);
        const interrupted = await child([profile, root, coordinationDirectory, 'crash-purge', `${phase},${id}`]);
        assert.equal(interrupted.code, 23, interrupted.stderr);
        const recovered = createStore(profile, root, coordinationDirectory);
        for (const key of [id, `${id}-dependent`]) {
          const record = await recovered.get(key);
          assert.equal(record.status, 'active', `${key} must not be half purged`);
          assert.ok(record.body.includes(marker));
        }
        await assert.rejects(readFile(journalPath), { code: 'ENOENT' });
      }
      return { check: true };
    },
    async 'purge-proposal-journal-erasure'() {
      const marker = 'PROPOSAL-JOURNAL-MARKER-ALPHA-7';
      const journalPath = join(root, '.station-knowledge-transaction.json');
      const proposal = (tag) => adapter.proposeCreate({ type: 'concept', title: `${marker} ${tag}`, body: `${marker} body`, category: 'conformance.purge', provenance: { agent: 'drafter' } }, 'proposer-1', { agent: 'drafter', proposal: `${marker} evidence` }, { requestKey: `journal-${tag}` });
      const bytes = (journal) => journal.entries.flatMap((entry) => [entry.before, entry.after]).filter((side) => side !== null).map((side) => Buffer.from(side, 'base64').toString('utf8')).join('\n');
      // Crash after the commit marker: the journal left behind holds none of the erased content, and the proposal is erased.
      const committed = await proposal('committed');
      const marked = await child([profile, root, coordinationDirectory, 'crash-purge-proposal', `committed,${committed}`]);
      assert.equal(marked.code, 23, marked.stderr);
      const journal = JSON.parse(await readFile(journalPath, 'utf8'));
      assert.equal(journal.phase, 'committed');
      assert.equal(journal.operation, 'purgeProposal');
      assert.equal(bytes(journal).includes(marker), false, 'the committed journal still holds erased content');
      const reopened = createStore(profile, root, coordinationDirectory);
      const erased = await reopened.getProposal(committed);
      assert.equal(erased.candidate.title, '[purged]');
      assert.equal(erased.request_key_retired, true);
      await assert.rejects(readFile(journalPath), { code: 'ENOENT' });
      // A crash before the first publication rolls back whole: the proposal is intact and can be erased again.
      const prepared = await proposal('prepared');
      const interrupted = await child([profile, root, coordinationDirectory, 'crash-purge-proposal', `prepared,${prepared}`]);
      assert.equal(interrupted.code, 23, interrupted.stderr);
      const recovered = createStore(profile, root, coordinationDirectory);
      const intact = await recovered.getProposal(prepared);
      assert.equal(intact.state, 'pending');
      assert.ok(intact.candidate.body.includes(marker));
      await assert.rejects(readFile(journalPath), { code: 'ENOENT' });
      assert.equal((await recovered.purgeProposal(prepared, { agent: 'privacy-officer', rationale: 'retry' })).alreadyErased, false);
      // An applied proposal spans the record and the proposal: a partial publication is rolled back whole.
      const applied = await proposal('applied');
      const recordId = await adapter.applyCreate(applied, 'reviewer-1');
      const partial = await child([profile, root, coordinationDirectory, 'crash-purge-proposal', `first-publish,${applied}`]);
      assert.equal(partial.code, 23, partial.stderr);
      const afterPartial = createStore(profile, root, coordinationDirectory);
      assert.equal((await afterPartial.get(recordId)).status, 'active', 'the record must not be half purged');
      assert.equal((await afterPartial.getProposal(applied)).erasure, undefined, 'the proposal must not be half erased');
      await assert.rejects(readFile(journalPath), { code: 'ENOENT' });
      const whole = await afterPartial.purgeProposal(applied, { agent: 'privacy-officer', rationale: 'retry' });
      assert.deepEqual(whole.record.purged, [recordId]);
      // A crash at the commit marker of an applied proposal leaves nothing named for the erased record once recovered:
      // not its content, and not the folder its category routed it to.
      const routed = await adapter.proposeCreate({ type: 'concept', title: `${marker} routed`, body: `${marker} routed body`, category: 'private.pathleak741', provenance: { agent: 'drafter' } }, 'proposer-1', { agent: 'drafter', proposal: `${marker} evidence` });
      await adapter.applyCreate(routed, 'reviewer-1');
      const late = await child([profile, root, coordinationDirectory, 'crash-purge-proposal', `committed,${routed}`]);
      assert.equal(late.code, 23, late.stderr);
      await createStore(profile, root, coordinationDirectory).getProposal(routed);
      assert.equal((await folders()).some((folder) => folder.includes('pathleak741')), false, 'a recovered erasure left a folder named for the erased record');
      return { check: true };
    },
    async 'purge-proposal-concurrent-settlement'() {
      const marker = 'RACE-MARKER-ALPHA-7';
      const evidence = { agent: 'privacy-officer', rationale: 'race drill' };
      const stage = (round) => adapter.proposeCreate({ type: 'concept', title: `${marker} ${round}`, body: `${marker} body ${round}`, category: 'conformance.purge', provenance: { agent: 'drafter' } }, 'proposer-1', { agent: 'drafter', proposal: `${marker} evidence` });
      const racers = () => [createStore(profile, root, coordinationDirectory), createStore(profile, root, coordinationDirectory)];
      for (const settle of ['applyCreate', 'rejectCreate']) {
        for (let round = 0; round < 6; round++) {
          const id = await stage(`${settle}-${round}`);
          const [a, b] = racers();
          const settling = () => a[settle](id, 'reviewer-1', ...(settle === 'rejectCreate' ? ['race rationale'] : []));
          const erasing = () => b.purgeProposal(id, evidence);
          // Start each side first in turn; the store lock, not the call order, decides who wins.
          let settlingCall;
          let erasingCall;
          if (round % 2 === 0) { settlingCall = settling(); erasingCall = erasing(); } else { erasingCall = erasing(); settlingCall = settling(); }
          const [settled, erased] = await Promise.allSettled([settlingCall, erasingCall]);
          assert.equal(erased.status, 'fulfilled', `${settle} round ${round}: the erasure must succeed`);
          if (settled.status === 'rejected') {
            assert.equal(settled.reason.code, 'MISSING_EVIDENCE', `${settle} round ${round}: a settle that loses the race is refused cleanly`);
            assert.match(settled.reason.message, /is rejected, not pending/, `${settle} round ${round}: a settle that loses the race must find the proposal settled, not fail on its erased candidate (got ${settled.reason.code}: ${settled.reason.message})`);
          }
          const proposal = await adapter.getProposal(id);
          assert.ok(proposal.erasure, `${settle} round ${round}: the proposal must end erased`);
          assert.equal(proposal.candidate.body, '');
          for (const record of await adapter.listByType('concept', { includeHistory: true })) assert.equal(record.status, 'purged', `${settle} round ${round}: no live record may survive`);
        }
      }
      const id = await stage('double');
      const [a, b] = racers();
      const both = await Promise.all([a.purgeProposal(id, evidence), b.purgeProposal(id, { agent: 'second', rationale: 'second request' })]);
      assert.deepEqual(both.map((result) => result.alreadyErased).sort(), [false, true]);
      const files = [];
      const walk = async (directory) => { for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) await walk(path); else files.push(await readFile(path, 'utf8')); } };
      await walk(root);
      assert.equal(files.some((text) => text.includes(marker)), false, 'erased content is still on disk');
      return { check: true };
    },
    async 'purge-journal-in-flight'() {
      // Every file is published and the commit marker is not: the purge is applied on
      // disk, so nothing on disk may still hold the erased content, journal included.
      const marker = 'IN-FLIGHT-MARKER-ALPHA-7';
      await adapter.create(input('in-flight-source', { body: marker }));
      const crashed = await child([profile, root, coordinationDirectory, 'crash-purge', 'final-publish,in-flight-source']);
      assert.equal(crashed.code, 23, crashed.stderr);
      const journal = JSON.parse(await readFile(join(root, '.station-knowledge-transaction.json'), 'utf8'));
      assert.equal(journal.phase, 'prepared');
      for (const entry of journal.entries) {
        for (const side of [entry.before, entry.after]) {
          if (side !== null) assert.equal(Buffer.from(side, 'base64').toString('utf8').includes(marker), false, `in-flight journal still holds erased content in ${entry.path}`);
        }
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
  return { adapter, specials, root, coordinationDirectory, dispose: () => retainFixture ? Promise.reject(new Error(`reviewed-confidence ${profile}: child did not settle; fixture retained at ${base}`)) : rm(base, { recursive: true, force: true }) };
}
