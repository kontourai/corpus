// Fault injection for purge. Each control weakens one rule in the source, rebuilds,
// and requires the named check to fail for the stated reason, then restores the
// file and requires the same check to pass again. Run on a clean, committed tree:
//   npm run proof:purge --workspace=@kontourai/corpus-store -- [output-directory] [control ids...]
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const output = resolve(process.argv[2] ?? join(tmpdir(), 'corpus-purge-faults'));
mkdirSync(output, { recursive: true });
const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
assert.equal(git('status', '--porcelain').stdout.trim(), '', 'Commit a clean baseline before mutation');
const revision = git('rev-parse', 'HEAD').stdout.trim();
const store = 'packages/store/';
const purge = store + 'src/shared/purge.ts';
const conformance = (...ids) => ['run', 'conformance', '--workspace=@kontourai/corpus-store', '--', ...ids];
const focused = (...files) => ['run', 'test', '--workspace=@kontourai/corpus-store', '--', ...files];
const remove = (source, text) => { assert.ok(source.includes(text), `fault target not found: ${text}`); return source.replace(text, ''); };
const swap = (source, from, to) => { assert.ok(source.includes(from), `fault target not found: ${from}`); return source.replace(from, to); };

const controls = [
  { id: 'skip-cascade', file: purge, mutate: (s) => swap(s, 'ordered.filter((r) => affected.has(r.id) && !alive.has(r.id))', 'ordered.filter(() => false)'),
    args: conformance('purge-cascade-sole-dependency', 'purge-cascade-cycle', 'purge-source-ids-support'), reason: /result\.cascaded/ },
  // Tombstone a record as soon as any support is lost, instead of only when all of it is.
  { id: 'cascade-on-any-lost-support', file: purge, mutate: (s) => swap(s, 'supportIds(record).some(real)', 'supportIds(record).every(real)'),
    args: conformance('purge-survivor-keeps-support', 'purge-source-ids-support'), reason: /(survivor|cascaded|e_after|f_after)/ },
  { id: 'outside-support-not-real', file: purge, mutate: (s) => swap(s, '!gone.has(id) && (!records.has(id) ||', '!gone.has(id) && records.has(id) && (false ||'),
    args: conformance('purge-source-ids-support'), reason: /result\.cascaded/ },
  // The naive rule: a record survives while any support is not purged, so a cycle holds itself up.
  { id: 'no-cycle-rule', file: purge, mutate: (s) => swap(s, 'if (supportIds(record).some(real)) {', 'if (supportIds(record).some((id) => !gone.has(id))) {'),
    args: conformance('purge-cascade-cycle', 'purge-cascade-cycle-member'), reason: /result\.cascaded/ },
  // A supporter the purge does not reach is not real support, so b falls although x is alive.
  { id: 'unreached-supporter-ignored', file: purge, mutate: (s) => swap(s, '|| !affected.has(id) ||', '||'),
    args: conformance('purge-survivor-with-live-cycle'), reason: /(result\.survivors|b_after)/ },
  { id: 'survivor-log-skipped', file: purge, mutate: (s) => swap(s, "auditEntry(op, at, evidence, { purged_ids: purgedIds }),", ''),
    args: conformance('purge-survivor-keeps-support', 'purge-source-ids-support'), reason: /(mutation_log|survivor)/ },
  { id: 'tombstone-keeps-body', file: purge, mutate: (s) => swap(s, "    body: '',\n    category: PURGED_CATEGORY,", '    body: record.body,\n    category: PURGED_CATEGORY,'),
    args: conformance('purge-tombstone-shape', 'purge-store-bytes'), reason: /(record\.body|is still on disk)/ },
  { id: 'tombstone-keeps-title', file: purge, mutate: (s) => swap(s, 'title: PURGED_TITLE,', 'title: record.title,'),
    args: conformance('purge-tombstone-shape', 'purge-store-bytes'), reason: /(record\.title|is still on disk)/ },
  { id: 'tombstone-keeps-content-hash', file: purge, mutate: (s) => swap(swap(s, "import { isRecord } from '../is-record.js';", "import { createHash } from 'node:crypto';\nimport { isRecord } from '../is-record.js';"), "    status: 'purged',\n", "    status: 'purged',\n    ...({ content_sha256: createHash('sha256').update(record.body).digest('hex') } as object),\n"),
    args: conformance('purge-store-bytes'), reason: /sha256 of .* is on disk/ },
  { id: 'tombstone-keeps-link-labels', file: purge, mutate: (s) => swap(s, '.map(({ target_id, kind }) => ({ target_id, kind }))', '.map((link) => ({ ...link }))'),
    args: conformance('purge-tombstone-links', 'purge-store-bytes'), reason: /(label|is still on disk)/ },
  { id: 'tombstone-keeps-log-prose', file: purge, mutate: (s) => swap(s, '...(record.mutation_log ?? []).map(scrubEntry),', '...(record.mutation_log ?? []),'),
    args: focused('test/purge.test.ts'), reason: /(Secret|reduces earlier log entries|exactly the tombstone shape)/ },
  { id: 'survivor-keeps-erased-label', file: purge, mutate: (s) => swap(s, 'if (!erased.has(link.target_id) || link.label === undefined) return link;', 'return link;'),
    args: conformance('purge-store-bytes'), reason: /label ALPHA-7.* is still on disk/ },
  { id: 'survivor-log-keeps-erased-label', file: purge, mutate: (s) => swap(s, '.map((entry) => unlabelErased(entry, erased))', ''),
    args: focused('test/purge.test.ts'), reason: /Erased Title/ },
  { id: 'tombstone-mutable', file: store + 'src/default-store.ts', mutate: (s) => swap(s, "    assertNotPurged('update', record);\n", ''),
    args: conformance('purge-refuses-tombstone-mutation'), reason: /update must reject|PURGED/ },
  { id: 'tombstone-citable', file: purge, mutate: (s) => swap(s, 'if (target) assertNotPurged(op, target);', ''),
    args: conformance('purge-refuses-tombstone-mutation'), reason: /(update|create) must reject/ },
  { id: 'alias-survives-purge', file: store + 'src/default-store.ts', mutate: (s) => swap(s, '      unregisterAliases(aliasIndex, id);\n', ''),
    args: conformance('purge-read-paths'), reason: /by_alias/ },
  { id: 'vault-title-path-survives', file: store + 'src/obsidian-store.ts', mutate: (s) => swap(s, 'const target = this.tombstonePath(id, pathIndex);', 'const target = entry.path;'),
    args: conformance('purge-store-bytes'), reason: /ember-zebra-interview.* is still on disk/ },
  { id: 'vault-survivors-not-rerendered', file: store + 'src/obsidian-store.ts', mutate: (s) => swap(s, 'this.writeRecord(kept, pathIndex);', 'void kept;'),
    args: focused('test/purge.test.ts'), reason: /zebra-quartz-memo/ },
  { id: 'journal-keeps-before-images', file: store + 'src/shared/file-transactions.ts', mutate: (s) => swap(s, 'for (const entry of context.journal.entries) entry.before = null;', ''),
    args: conformance('purge-journal-erasure'), reason: /still holds erased content in the journal|journal must/ },
  { id: 'purge-always-allowed', file: store + 'src/default-store.ts', mutate: (s) => swap(s, 'if (this.services.allowPurge !== true) {', 'if (this.services.allowPurge !== true && false) {'),
    args: focused('test/purge.test.ts'), reason: /is refused without allowPurge/ },
  { id: 'partial-write-on-missing-id', file: store + 'src/default-store.ts', mutate: (s) => swap(s, '    for (const id of requested) {\n      if (!records.has(id)) throw new KnowledgeRecordNotFoundError(id);\n    }\n    const plan', '    requested = requested.filter((id) => records.has(id));\n    const plan'),
    args: conformance('purge-input-validation'), reason: /NOT_FOUND|must reject/ },
  { id: 'prefix-resolves-target', file: store + 'src/default-store.ts', mutate: (s) => swap(s, '    for (const id of requested) {\n      if (!records.has(id)) throw new KnowledgeRecordNotFoundError(id);\n    }\n    const plan = planPurge(requested, records);', '    requested = requested.map((id) => [...records.keys()].find((key) => key.startsWith(id)) ?? id);\n    for (const id of requested) {\n      if (!records.has(id)) throw new KnowledgeRecordNotFoundError(id);\n    }\n    const plan = planPurge(requested, records);'),
    args: conformance('purge-input-validation'), reason: /(purge|NOT_FOUND|must reject)/ },
  { id: 'orphan-journal-temp-kept', file: store + 'src/shared/file-transactions.ts', mutate: (s) => swap(s, '    this.removeOrphanJournalTemporaries();\n', ''),
    args: focused('test/purge.test.ts'), reason: /journal temporary left by a crash/ },
  { id: 'success-over-unscrubbed-journal', file: store + 'src/shared/file-transactions.ts', mutate: (s) => swap(s, '            if (!markerPersisted) {', '            if (false) {'),
    args: focused('test/purge.test.ts'), reason: /commit marker cannot be written/ },
  { id: 'empty-folders-kept', file: store + 'src/shared/file-transactions.ts', mutate: (s) => swap(s, 'if (options.erasure) this.pruneEmptyDirectories(context.journal);', ''),
    args: conformance('purge-store-bytes'), reason: /person-739.* is still on disk/ },
  { id: 'migration-artifacts-ignored', file: store + 'src/obsidian-store.ts', mutate: (s) => swap(s, "if (this.files.readText(this.resolveStorePath(kept)) !== null) {", 'if (false) {'),
    args: focused('test/purge.test.ts'), reason: /migration artifacts/ },
  { id: 'evidence-types-unchecked', file: purge, mutate: (s) => swap(s, "const text = (value: unknown) => typeof value === 'string' && value.trim() !== '';", 'const text = (value: unknown) => Boolean(value);'),
    args: focused('test/purge.test.ts'), reason: /wrong runtime type/ },
  { id: 'allow-purge-truthy', file: store + 'src/services.ts', mutate: (s) => swap(s, 'allowPurge: options.allowPurge === true,', 'allowPurge: Boolean(options.allowPurge),'),
    args: focused('test/purge.test.ts'), reason: /allowPurge must be exactly true/ },
  { id: 'prune-follows-symlinks', file: store + 'src/shared/file-transactions.ts', mutate: (s) => swap(s, '          this.assertNoSymlink(directory);\n', ''),
    args: focused('test/purge.test.ts'), reason: /swapped for a symlink/ },
  { id: 'partial-journal-temp-kept', file: store + 'src/shared/file-transactions.ts', mutate: (s) => swap(s, 'if (startsLikeJournal(text)) {', "if (startsLikeJournal(text) && text.trimEnd().endsWith('}')) {"),
    args: focused('test/purge.test.ts'), reason: /cut short by a crash/ },
  { id: 'foreign-json-deleted', file: store + 'src/shared/file-transactions.ts', mutate: (s) => swap(s, 'if (startsLikeJournal(text)) {', 'if (/^\\{"version":1,"transactionId"/.test(text)) {'),
    args: focused('test/purge.test.ts'), reason: /cut short by a crash/ },
  { id: 'orphan-unlink-failure-swallowed', file: store + 'src/shared/file-transactions.ts', mutate: (s) => swap(s, '        } catch (error) {\n          throw unavailable(error);\n        }\n      }\n    }\n  }\n\n  /** Best effort', '        } catch {\n          // swallowed\n        }\n      }\n    }\n  }\n\n  /** Best effort'),
    args: focused('test/purge.test.ts'), reason: /cannot be removed fails the operation/ },
  { id: 'readback-skips-prune', file: store + 'src/shared/file-transactions.ts', mutate: (s) => swap(s, "            this.pruneEmptyDirectories(context.journal);\n          }\n          this.observe(operation, 'applied-readback');", "          }\n          this.observe(operation, 'applied-readback');"),
    args: focused('test/purge.test.ts'), reason: /commit marker had to be skipped/ },
  // Simple escapes (an escaped quote, newline, backslash) are no longer accepted.
  { id: 'journal-temp-prefix-too-strict', file: store + 'src/shared/file-transactions.ts', mutate: (s) => swap(s, 'if (next !== undefined && ', 'if (false && next !== undefined && '),
    args: focused('test/purge.test.ts'), reason: /every cut of a journal with escaped quotes/ },
  { id: 'journal-temp-head-truncated', file: store + 'src/shared/file-transactions.ts', mutate: (s) => swap(s, 'startsLikeJournal(text)', 'startsLikeJournal(text.slice(0, 1024))'),
    args: focused('test/purge.test.ts'), reason: /very long id and operation/ },
  // The regular-expression form of the same check overflows the stack on a multi-megabyte header.
  { id: 'journal-temp-regexp-recursion', file: store + 'src/shared/file-transactions.ts', mutate: (s) => swap(s, 'startsLikeJournal(text)) {', '/^\\{"version":1,"transactionId":"(?:[^"\\\\]|\\\\.)*","operation"/s.test(text)) {'),
    args: focused('test/purge.test.ts'), reason: /multi-megabyte journal header/ },
  // Accept any escape sequence, as the old pattern did.
  { id: 'foreign-unknown-escape-deleted', file: store + 'src/shared/file-transactions.ts', mutate: (s) => swap(s, "if (next !== 'u') return false;", "if (next !== 'u') { at += 2; continue; }"),
    args: focused('test/purge.test.ts'), reason: /left alone/ },
  // Accept \u000a (and the other controls that have a short escape) as the long form.
  { id: 'foreign-long-control-escape-deleted', file: store + 'src/shared/file-transactions.ts', mutate: (s) => swap(s, ' && ![0x08, 0x09, 0x0a, 0x0c, 0x0d].includes(unit)', ''),
    args: focused('test/purge.test.ts'), reason: /left alone/ },
  // Accept a \\u escape for a character JSON.stringify would write raw.
  { id: 'foreign-needless-unicode-escape-deleted', file: store + 'src/shared/file-transactions.ts', mutate: (s) => swap(s, 'if (!control && !surrogate) return false;', ''),
    args: focused('test/purge.test.ts'), reason: /left alone/ },
  // Create proposals (#42) carry their whole candidate outside every record path.
  { id: 'proposal-erasure-skipped', file: store + 'src/default-store.ts', mutate: (s) => swap(s, 'const proposals = this.proposals.erase(plan.erased, plan.allErased, evidence, now);', 'const proposals = { rejected: [] as string[], scrubbed: [] as string[], blocked: [] as string[] };'),
    args: conformance('purge-proposal-sole-support-rejected', 'purge-proposal-record-erased', 'purge-store-bytes'), reason: /(proposalsRejected|proposalsScrubbed|after\.|is still on disk)/ },
  { id: 'proposal-pending-not-rejected', file: store + 'src/shared/create-proposals.ts', mutate: (s) => swap(s, "? { state: 'rejected' as const,", "? { state: 'pending' as const,"),
    args: conformance('purge-proposal-sole-support-rejected'), reason: /after\.state/ },
  { id: 'proposal-created-record-not-followed', file: store + 'src/shared/create-proposals.ts', mutate: (s) => swap(s, "const createdErased = proposal.state === 'applied' && proposal.record_id !== undefined && newlyErased.has(proposal.record_id);", 'const createdErased = false;'),
    args: conformance('purge-proposal-record-erased'), reason: /(proposalsScrubbed|after\.)/ },
  { id: 'proposal-candidate-kept', file: store + 'src/shared/create-proposals.ts', mutate: (s) => swap(s, 'candidate: stubCandidate(proposal.candidate),', 'candidate: proposal.candidate,'),
    args: conformance('purge-proposal-sole-support-rejected'), reason: /after\.candidate/ },
  { id: 'proposal-evidence-kept', file: store + 'src/shared/create-proposals.ts', mutate: (s) => swap(s, 'evidence: { agent: proposal.evidence.agent, proposal: PURGED_TITLE },', 'evidence: proposal.evidence,'),
    args: conformance('purge-proposal-sole-support-rejected'), reason: /after\.evidence/ },
  { id: 'proposal-partial-support-erased', file: store + 'src/shared/create-proposals.ts', mutate: (s) => swap(s, 'support.some((id) => newlyErased.has(id)) && support.every((id) => allErased.has(id));', 'support.some((id) => newlyErased.has(id));'),
    args: conformance('purge-proposal-other-support-blocked'), reason: /(proposalsBlocked|after\.|PURGED)/ },
  { id: 'proposal-cites-tombstone', file: store + 'src/shared/create-proposals.ts', mutate: (s) => swap(s, 'guard?.(stored);', ''),
    args: conformance('purge-proposal-cites-tombstone'), reason: /proposeCreate must reject/ },
  { id: 'proposal-support-drops-candidate-id', file: store + 'src/shared/create-proposals.ts', mutate: (s) => swap(s, 'supportIds({ provenance: proposal.candidate.provenance, links: proposal.candidate.links })', 'supportIds({ id: proposal.candidate.id, provenance: proposal.candidate.provenance, links: proposal.candidate.links })'),
    args: focused('test/purge-proposals.test.ts'), reason: /candidate id counts as support|real support/ },
  { id: 'proposal-shape-unchecked', file: store + 'src/shared/create-proposals.ts', mutate: (s) => swap(s, '      assertErasable(proposal);\n', ''),
    args: focused('test/purge-proposals.test.ts'), reason: /stored shape purge cannot judge/ },
  { id: 'purge-bounds-raw-bytes', file: purge, mutate: (s) => swap(s, 'Buffer.byteLength(JSON.stringify(value)) <= limit', 'Buffer.byteLength(value) <= limit'),
    args: focused('test/purge-proposals.test.ts'), reason: /bounded as JSON/ },
  { id: 'proposal-marker-trusted', file: store + 'src/shared/create-proposals.ts', mutate: (s) => swap(s, "if (!settled) throw corrupt('an erased proposal is not what a purge writes');", ''),
    args: focused('test/purge-proposals.test.ts'), reason: /trusted only over exactly what a purge writes/ },
  { id: 'proposal-agent-trimmed', file: store + 'src/shared/create-proposals.ts', mutate: (s) => swap(s, "typeof provenance.agent !== 'string' || provenance.agent === ''", "typeof provenance.agent !== 'string' || provenance.agent.trim() === ''"),
    args: focused('test/purge-proposals.test.ts'), reason: /healthy store stays purgeable/ },
  { id: 'proposal-staging-shape-unchecked', file: store + 'src/shared/create-proposals.ts', mutate: (s) => swap(s, "if (problem) throw new MissingEvidenceError(`proposeCreate: ${problem}`);", ''),
    args: focused('test/purge-proposals.test.ts'), reason: /no accepted proposal can stop a later purge/ },
  { id: 'proposal-empty-link-accepted', file: store + 'src/shared/create-proposals.ts', mutate: (s) => swap(s, "link.target_id === '' || link.kind === ''", 'false'),
    args: focused('test/purge-proposals.test.ts'), reason: /empty link (target|kind)/ },
  { id: 'purge-ignores-note-bound', file: store + 'src/obsidian-store.ts', mutate: (s) => swap(s, "this.writeRecord(kept, pathIndex, { enforceNoteBound: 'purge' });", 'this.writeRecord(kept, pathIndex);'),
    args: focused('test/purge.test.ts'), reason: /(without its prose|not even that fits)/ },
  { id: 'tombstone-not-shortened', file: store + 'src/obsidian-store.ts', mutate: (s) => swap(s, "for (const shape of TOMBSTONE_SHAPES) {", "for (const shape of TOMBSTONE_SHAPES.slice(0, 1)) {"),
    args: focused('test/purge.test.ts'), reason: /near the vault note bound/ },
  { id: 'survivor-prose-not-dropped', file: store + 'src/obsidian-store.ts', mutate: (s) => swap(s, 'kept = survivor(true);', 'throw error;'),
    args: focused('test/purge.test.ts'), reason: /without its prose/ },
  { id: 'tombstone-keeps-long-agent', file: purge, mutate: (s) => swap(s, "agent: short(agent) ? agent : '[omitted]',", 'agent,'),
    args: focused('test/purge.test.ts'), reason: /agent or session id too long to keep/ },
  { id: 'tombstone-keeps-long-type', file: purge, mutate: (s) => swap(s, "const type = short(record.type) ? record.type : ('[omitted]' as KitRecord['type']);", 'const type = record.type;'),
    args: focused('test/purge.test.ts'), reason: /made of a very long type can still be erased/ },
  { id: 'shortened-tombstone-drops-rationale', file: purge, mutate: (s) => swap(s, 'rationale: minimal.rationale,', ''),
    args: focused('test/purge.test.ts'), reason: /rationale of at most 64 bytes/ },
  { id: 'tombstone-measure-overflow-fatal', file: store + 'src/obsidian-store.ts', mutate: (s) => swap(s, 'if (!(error instanceof RangeError)) throw error;', 'throw error;'),
    args: focused('test/purge.test.ts'), reason: /made of a very long (type|created_at) can still be erased/ },
  { id: 'rationale-cut-from-spaces', file: purge, mutate: (s) => swap(s, 'leadingJson(evidence.rationale.trimStart(), maxBytes)', 'leadingJson(evidence.rationale, maxBytes)'),
    args: focused('test/purge.test.ts'), reason: /leading spaces cannot leave only spaces/ },
  // purgeProposal (#62): erase one create proposal by its own id.
  { id: 'proposal-purge-always-allowed', file: store + 'src/default-store.ts', mutate: (s) => swap(s, "if (this.services.allowPurge !== true) {\n      throw new ReadOnlyStoreError('purgeProposal'", "if (this.services.allowPurge !== true && false) {\n      throw new ReadOnlyStoreError('purgeProposal'"),
    args: focused('test/purge-proposal.test.ts', '-t', 'it is refused without allowPurge'), reason: /instead of rejecting/ },
  { id: 'proposal-purge-evidence-unchecked', file: purge, mutate: (s) => swap(s, "validatePurgeEvidence('purgeProposal', evidence);", ''),
    args: conformance('purge-proposal-erase-input-validation'), reason: /purgeProposal must reject/ },
  { id: 'proposal-purge-unknown-id-ignored', file: store + 'src/shared/create-proposals.ts', mutate: (s) => swap(s, 'if (!proposal) throw new KnowledgeRecordNotFoundError(proposalId);\n    assertErasable(proposal);', 'if (!proposal) return { proposalId, alreadyErased: true };\n    assertErasable(proposal);'),
    args: conformance('purge-proposal-erase-input-validation'), reason: /purgeProposal must reject/ },
  { id: 'proposal-purge-not-idempotent', file: store + 'src/shared/create-proposals.ts', mutate: (s) => swap(s, '    if (proposal.erasure) return { proposalId, alreadyErased: true };\n', ''),
    args: conformance('purge-proposal-erase-pending-no-source'), reason: /again\.alreadyErased/ },
  { id: 'proposal-purge-marker-trusted', file: store + 'src/shared/create-proposals.ts', mutate: (s) => swap(s, '    assertErasable(proposal);\n    if (proposal.erasure) return { proposalId, alreadyErased: true };', '    if (proposal.erasure) return { proposalId, alreadyErased: true };'),
    args: focused('test/purge-proposal.test.ts', '-t', 'a corrupt proposal is not erased'), reason: /instead of rejecting/ },
  { id: 'proposal-purge-source-refs-kept', file: store + 'src/shared/create-proposals.ts', mutate: (s) => swap(s, "      agent: provenance.agent,\n      ...(provenance.session_id ? { session_id: provenance.session_id } : {}),\n      ...(provenance.source_ids?.length ? { source_ids: [...provenance.source_ids] } : {}),\n    },\n    links: (candidate.links", "      agent: provenance.agent,\n      ...(provenance.source_refs ? { source_refs: provenance.source_refs } : {}),\n      ...(provenance.session_id ? { session_id: provenance.session_id } : {}),\n      ...(provenance.source_ids?.length ? { source_ids: [...provenance.source_ids] } : {}),\n    },\n    links: (candidate.links"),
    args: conformance('purge-proposal-erase-pending-no-source'), reason: /after\.candidate\.provenance\.source_refs must be absent/ },
  // An applied proposal's content lives in its record: the record purge must run, in both profiles.
  { id: 'proposal-purge-applied-record-kept', file: store + 'src/default-store.ts', mutate: (s) => swap(s, 'return record && !isPurged(record) ? this.purgeLocked([recordId], evidence) : undefined;', 'return undefined;'),
    args: conformance('purge-proposal-erase-applied'), reason: /result\.record\.purged/ },
  { id: 'vault-proposal-purge-applied-record-kept', file: store + 'src/obsidian-store.ts', mutate: (s) => swap(s, 'return record && !isPurged(record) ? this.purgeLocked([recordId], evidence) : undefined;', 'return undefined;'),
    args: conformance('purge-proposal-erase-applied'), reason: /result\.record\.purged/ },
  { id: 'proposal-purge-tombstone-repurged', file: store + 'src/default-store.ts', mutate: (s) => swap(s, 'return record && !isPurged(record) ?', 'return record ?'),
    args: focused('test/purge-proposal.test.ts', '-t', 'whose record is already a tombstone'), reason: /alreadyPurged/ },
  { id: 'proposal-purge-unsafe-record-id', file: store + 'src/default-store.ts', mutate: (s) => swap(s, 'const record = isSafePathSegment(recordId) ? this.readRecord(recordId) : null;', 'const record = this.readRecord(recordId);'),
    args: focused('test/purge-proposal.test.ts', '-t', 'whose record is already a tombstone'), reason: /does not match its authoritative filename/ },
  { id: 'vault-proposal-purge-inherited-record-id', file: store + 'src/obsidian-store.ts', mutate: (s) => swap(s, 'Object.hasOwn(pathIndex.by_id, recordId) ? this.readRecord(recordId, pathIndex) : null', 'this.readRecord(recordId, pathIndex)'),
    args: focused('test/purge-proposal.test.ts', '-t', 'an applied proposal whose record'), reason: /Invalid store path/ },
  // Interrupted erasure: the erasure flag is what drops the before-images at the commit marker.
  { id: 'proposal-purge-journal-keeps-before-images', file: store + 'src/default-store.ts', mutate: (s) => swap(s, "      { erasure: true },\n    );\n  }\n\n  // ── get / getLinks", "    );\n  }\n\n  // ── get / getLinks"),
    args: conformance('purge-proposal-journal-erasure'), reason: /committed journal still holds erased content/ },
  { id: 'vault-proposal-purge-journal-keeps-before-images', file: store + 'src/obsidian-store.ts', mutate: (s) => swap(s, "      { erasure: true },\n    );\n  }\n\n  // ── get / getLinks", "    );\n  }\n\n  // ── get / getLinks"),
    args: conformance('purge-proposal-journal-erasure'), reason: /committed journal still holds erased content/ },
  // Concurrent settlement: an erased proposal is settled `rejected`, and that is what keeps a queued apply out.
  { id: 'proposal-settle-after-erasure', file: store + 'src/shared/create-proposals.ts', mutate: (s) => swap(s, "if (proposal.state !== 'pending') {", "if (proposal.state !== 'pending' && proposal.erasure === undefined) {"),
    args: focused('test/purge-proposal.test.ts', '-t', 'erase holds the lock while an apply is queued'), reason: /applyCreate after erasure must be refused/ },
  { id: 'proposal-reject-after-erasure', file: store + 'src/shared/create-proposals.ts', mutate: (s) => swap(s, "if (proposal.state !== 'pending') {", "if (proposal.state !== 'pending' && proposal.erasure === undefined) {"),
    args: focused('test/purge-proposal.test.ts', '-t', 'a reject that holds the lock'), reason: /rejectCreate after erasure must be refused/ },
  { id: 'proposal-settle-after-erasure-race', file: store + 'src/shared/create-proposals.ts', mutate: (s) => swap(s, "if (proposal.state !== 'pending') {", "if (proposal.state !== 'pending' && proposal.erasure === undefined) {"),
    args: conformance('purge-proposal-concurrent-settlement'), reason: /no live record may survive|must end erased/ },
  // A retry after erasure is refused as a retired key, never compared with anything.
  { id: 'proposal-retry-after-erasure-compared', file: store + 'src/shared/create-proposals.ts', mutate: (s) => swap(s, "if (existing && (Object.hasOwn(existing, 'erasure') || existing.request_key_retired === true)) throw new RequestKeyConflictError(true);", ''),
    args: focused('test/purge-proposal.test.ts', '-t', 'a retry after erasing'), reason: /retired/ },
];

function run(label, args, success) {
  const result = spawnSync('npm', args, { cwd: repo, encoding: 'utf8', timeout: 300000, maxBuffer: 256 * 1024 * 1024 });
  const log = (result.stdout ?? '') + (result.stderr ?? '');
  writeFileSync(join(output, label + '.log'), log);
  assert.equal(result.error, undefined, `${label}: execution error`);
  assert.equal(result.signal, null, `${label}: interrupted command`);
  if (success) assert.equal(result.status, 0, log); else assert.notEqual(result.status, 0, `${label} must fail`);
  console.log(`${label}: exit ${result.status}`);
  return { exit: result.status, log };
}

const build = (label) => run(label, ['run', 'build', '--workspace=@kontourai/corpus-store'], true);
const selected = process.argv.slice(3);
for (const id of selected) assert.ok(controls.some((control) => control.id === id), `Unknown fault control: ${id}`);
build('build-baseline');
const results = [];
for (const control of controls.filter((control) => !selected.length || selected.includes(control.id))) {
  const file = join(repo, control.file);
  const original = readFileSync(file, 'utf8');
  const baseline = run(control.id + '-baseline', control.args, true);
  let injected;
  try {
    const mutated = control.mutate(original);
    assert.notEqual(mutated, original, `${control.id}: the injection changed nothing`);
    writeFileSync(file, mutated);
    build(control.id + '-build-injected');
    injected = run(control.id + '-injected', control.args, false);
    // Read the failure text: a broken build or "no tests found" is not a catch.
    assert.doesNotMatch(injected.log, /no tests found|error TS\d+/i, `${control.id}: failed for an unrelated reason`);
    assert.match(injected.log, control.reason, `${control.id}: wrong rejection reason`);
  } finally { writeFileSync(file, original); }
  build(control.id + '-build-restored');
  const restored = run(control.id + '-restored', control.args, true);
  results.push({ id: control.id, baseline: baseline.exit, injected: injected.exit, restored: restored.exit });
  writeFileSync(join(output, 'results.json'), JSON.stringify({ revision, node: process.version, results }, null, 2) + '\n');
  assert.equal(git('status', '--porcelain').stdout.trim(), '', `${control.id}: failed to restore baseline`);
}
writeFileSync(join(output, 'results.json'), JSON.stringify({ revision, node: process.version, results }, null, 2) + '\n');
