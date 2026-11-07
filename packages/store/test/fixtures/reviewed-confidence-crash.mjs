import { KitDefaultStoreAdapter, KitObsidianStoreAdapter, standaloneFileMutationLock } from '../../src/index.ts';

const [profile, storeRoot, coordinationDirectory, phase, rawRequest] = process.argv.slice(2);
const Constructor = profile === 'default' ? KitDefaultStoreAdapter : KitObsidianStoreAdapter;
const store = new Constructor({ storeRoot, coordinationDirectory, coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock, allowReviewedConfidence: true, allowPurge: true });
const purging = phase.startsWith('purge-');
const point = purging ? phase.slice('purge-'.length) : phase;
let entries = 0;
let published = 0;
store.files.hooks.afterJournalWrite = (journal) => { entries = journal.entries.length; if (point === 'prepared' && journal.phase === 'prepared') process.exit(23); };
store.files.hooks.afterFilePublish = () => {
  published++;
  if (point === 'first-publish' && published === 1 || point === 'final-publish' && published === entries) process.exit(23);
};
store.files.hooks.afterCommitMarker = () => { if (point === 'committed') process.exit(23); };
if (purging) await store.purge(['source'], { agent: 'eraser', rationale: 'request' });
else await store.applyReviewedConfidence(JSON.parse(rawRequest));
process.exit(24);
