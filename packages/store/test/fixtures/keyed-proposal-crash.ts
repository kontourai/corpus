import { join } from 'node:path';
import { KitDefaultStoreAdapter, KitObsidianStoreAdapter, standaloneFileMutationLock } from '../../src/index.js';
const [base, profile] = process.argv.slice(2);
const Constructor = profile === 'vault' ? KitObsidianStoreAdapter : KitDefaultStoreAdapter;
let sequence = 0;
const store = new Constructor({ storeRoot: join(base, 'store'), coordinationDirectory: join(base, 'coordination'), coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock, ids: () => `crash-${++sequence}` });
const internal = store as unknown as { files: { hooks: { afterFilePublish(path: string): void } } };
internal.files.hooks.afterFilePublish = (path) => { if (path.includes('.corpus-proposals')) process.exit(99); };
await store.proposeCreate({ id: 'crash-record', type: 'raw', title: 'Crash', body: 'body', category: 'engineering', provenance: { agent: 'writer' } }, 'writer', { agent: 'writer', proposal: 'keep' }, { requestKey: 'crash' });
