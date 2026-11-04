// Child process for the double-interruption test: opens a store whose journal was left by a crashed
// erasure and dies in the middle of the recovery's own folder cleanup (exit 24), so the parent can
// check that the next recovery still finishes it.
//   node --import tsx purge-proposal-recover-crash.ts <base> <default|vault> <proposalId> [folder-to-remove]
// With a folder, the crash comes after the cleanup has really removed that (innermost) folder, which is
// where an interrupted pass leaves the next one: a missing leaf under ancestors that may still be empty.
import { rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { KitDefaultStoreAdapter, KitObsidianStoreAdapter, standaloneFileMutationLock } from '../../src/index.js';

const [base, profile, proposalId, folder] = process.argv.slice(2);
const Constructor = profile === 'vault' ? KitObsidianStoreAdapter : KitDefaultStoreAdapter;
const store = new Constructor({
  storeRoot: join(base, 'store'),
  coordinationDirectory: join(base, 'coordination'),
  coordinationIdentity: () => () => {},
  lock: standaloneFileMutationLock,
  allowPurge: true,
});
(store as unknown as { files: { pruneEmptyDirectories: () => void } }).files.pruneEmptyDirectories = () => {
  if (folder) rmdirSync(folder);
  process.exit(24);
};
await store.getProposal(proposalId);
throw new Error('Crash injection did not run');
