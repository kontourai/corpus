import { assertAdapterBoundTo, initializeRootBinding, KitDefaultStoreAdapter, KitObsidianStoreAdapter, standaloneFileMutationLock } from '../../src/index.js';
const [storeRoot, coordinationDirectory, profile] = process.argv.slice(2);
const Constructor = profile === 'vault' ? KitObsidianStoreAdapter : KitDefaultStoreAdapter;
const options = { storeRoot, coordinationDirectory, coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock };
const adapter = new Constructor(options);
try { assertAdapterBoundTo(adapter, storeRoot); throw new Error('FIFO accepted'); } catch (error) { if ((error as { code?: string }).code !== 'ROOT_BINDING_MISMATCH') throw error; }
try { await initializeRootBinding(options); throw new Error('FIFO accepted'); } catch (error) { if ((error as { code?: string }).code !== 'ROOT_BINDING_MISMATCH') throw error; }
