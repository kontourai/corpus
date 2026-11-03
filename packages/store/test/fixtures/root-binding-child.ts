import { KitDefaultStoreAdapter, KitObsidianStoreAdapter, standaloneFileMutationLock } from '../../src/index.js';
const [root, coordinationDirectory, profile] = process.argv.slice(2);
const Constructor = profile === 'vault' ? KitObsidianStoreAdapter : KitDefaultStoreAdapter;
const adapter = new Constructor({ storeRoot: root, coordinationDirectory, coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock });
try { process.stdout.write(adapter.rootBinding()); }
catch (error) { if ((error as { code?: string }).code !== 'ROOT_BINDING_MISMATCH') throw error; process.stdout.write('unbound'); }
