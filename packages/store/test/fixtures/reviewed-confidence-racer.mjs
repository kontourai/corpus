import { KitDefaultStoreAdapter, KitObsidianStoreAdapter, standaloneFileMutationLock } from '../../src/index.ts';

const [profile, storeRoot, coordinationDirectory, rawRequest] = process.argv.slice(2);
const Constructor = profile === 'default' ? KitDefaultStoreAdapter : KitObsidianStoreAdapter;
const store = new Constructor({ storeRoot, coordinationDirectory, coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock, allowReviewedConfidence: true });
process.stdout.write('ready\n');
await new Promise((resolve) => process.stdin.once('data', resolve));
try {
  await store.applyReviewedConfidence(JSON.parse(rawRequest));
  process.stdout.write('applied\n');
} catch (error) {
  process.stdout.write(`error:${error?.code ?? 'unexpected'}\n`);
}
