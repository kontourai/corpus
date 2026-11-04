// Child process for the interrupted-erasure tests: runs `purgeProposal` and exits at one phase of
// the store's own transaction (the internal hooks the other crash fixtures use), so the parent can
// recover the store and look at what was left. Exit 23 means the crash hook fired.
//   node --import tsx purge-proposal-crash.ts <base> <default|vault> <phase> <proposalId>
// phase: prepared (journal written, nothing published), first-publish (one file published),
// final-publish (every file published, no commit marker), committed (commit marker written).
import { join } from 'node:path';
import { KitDefaultStoreAdapter, KitObsidianStoreAdapter, standaloneFileMutationLock } from '../../src/index.js';

const [base, profile, phase, proposalId] = process.argv.slice(2);
const Constructor = profile === 'vault' ? KitObsidianStoreAdapter : KitDefaultStoreAdapter;
const store = new Constructor({
  storeRoot: join(base, 'store'),
  coordinationDirectory: join(base, 'coordination'),
  coordinationIdentity: () => () => {},
  lock: standaloneFileMutationLock,
  allowPurge: true,
});
type Journal = { phase: string; entries: unknown[] };
const hooks = (store as unknown as {
  files: { hooks: { afterJournalWrite?: (journal: Journal) => void; afterFilePublish?: () => void; afterCommitMarker?: () => void } };
}).files.hooks;
let publications = 0;
let entries = 0;
hooks.afterJournalWrite = (journal) => {
  entries = journal.entries.length;
  if (phase === 'prepared' && journal.phase === 'prepared') process.exit(23);
};
hooks.afterFilePublish = () => {
  publications++;
  if ((phase === 'first-publish' && publications === 1) || (phase === 'final-publish' && publications === entries)) process.exit(23);
};
hooks.afterCommitMarker = () => { if (phase === 'committed') process.exit(23); };
await store.purgeProposal(proposalId, { agent: 'privacy-officer', rationale: 'crash drill' });
throw new Error('Crash injection did not run');
