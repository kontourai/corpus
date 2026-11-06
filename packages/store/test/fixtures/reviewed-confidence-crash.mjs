import { KitDefaultStoreAdapter, KitObsidianStoreAdapter, standaloneFileMutationLock } from '../../src/index.ts';

const [profile, storeRoot, coordinationDirectory, phase, rawRequest] = process.argv.slice(2);
const Constructor = profile === 'default' ? KitDefaultStoreAdapter : KitObsidianStoreAdapter;
const store = new Constructor({ storeRoot, coordinationDirectory, coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock, allowReviewedConfidence: true });
store.files.hooks.afterJournalWrite = (journal) => { if (phase === 'prepared' && journal.phase === 'prepared') process.exit(23); };
store.files.hooks.afterCommitMarker = () => { if (phase === 'committed') process.exit(23); };
await store.applyReviewedConfidence(JSON.parse(rawRequest));
process.exit(24);
