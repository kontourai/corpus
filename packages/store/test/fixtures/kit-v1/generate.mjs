// Writes Knowledge Kit vault fixtures with the Kit's own adapters (old writer).
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const [kitRoot, out] = process.argv.slice(2);
const { ObsidianKnowledgeStore } = await import(join(kitRoot, 'kits/knowledge/adapters/obsidian-store/index.js'));
const { DefaultKnowledgeStore } = await import(join(kitRoot, 'kits/knowledge/adapters/default-store/index.js'));
const agent = { agent: 'fixture-writer' };
async function vault(root) {
  const store = new ObsidianKnowledgeStore({ storeRoot: root });
  const raw = await store.create({ id: 'kit-raw-0001', type: 'raw', title: 'Interview notes', body: 'Line one of the notes.\nLine two of the notes.', category: 'research.interviews', provenance: agent });
  const oldSummary = await store.create({ id: 'kit-compiled-0001', type: 'compiled', title: 'Interview summary', body: 'The first summary.', category: 'research.interviews', links: [{ target_id: raw, kind: 'source' }], provenance: { ...agent, source_ids: [raw] } });
  const newSummary = await store.create({ id: 'kit-compiled-0002', type: 'compiled', title: 'Interview summary v2', body: 'The revised summary, with ## Sources mentioned in text.', category: 'research.interviews', links: [{ target_id: raw, kind: 'source' }], provenance: agent });
  await store.supersede(newSummary, [oldSummary], { agent: 'fixture-writer', rationale: 'Revised after review' });
  const concept = await store.create({ id: 'kit-concept-0001', type: 'concept', title: 'Onboarding friction', body: 'Users stall at account setup. See [[kit-compiled-0002]].', category: 'research', aliases: ['research/onboarding-friction'], links: [{ target_id: newSummary, kind: 'derived-from' }], provenance: agent, ttl_seconds: 86400 });
  await store.create({ id: 'kit-person-0001', type: 'person', title: 'Example Interviewee', body: 'A fictional participant.', category: 'research', provenance: agent });
  const snapshot = await store.create({ id: 'kit-snapshot-0001', type: 'snapshot', title: 'Quarterly snapshot', body: 'State of research at quarter end.', category: 'research.reports', provenance: agent, expires_at: '2027-01-01T00:00:00.000Z' });
  await store.retire(snapshot, 'retired', { agent: 'fixture-writer', rationale: 'Replaced by the next quarter' });
  await store.update(concept, { tags: ['onboarding'] }, { agent: 'fixture-writer', note: 'tagged' });
  return { concept };
}
const kitVault = join(out, 'kit-vault');
const hybrid = join(out, 'hybrid-store');
for (const root of [kitVault, hybrid]) { rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true }); }
await vault(kitVault);
// Hybrid: a default store and a vault written by the Kit into one root, sharing
// graph-index.json and alias-index.json; only the vault notes are in .graph-index.json.
const defaults = new DefaultKnowledgeStore({ storeRoot: hybrid });
const rawDefault = await defaults.create({ id: 'kit-default-raw-0001', type: 'raw', title: 'Meeting transcript', body: 'A neutral transcript.', category: 'operations.meetings', provenance: agent });
await defaults.create({ id: 'kit-default-compiled-0001', type: 'compiled', title: 'Meeting digest', body: 'The digest.', category: 'operations.meetings', links: [{ target_id: rawDefault, kind: 'source' }], provenance: agent });
await vault(hybrid);
console.log(JSON.stringify({ kitVault, hybrid }));
