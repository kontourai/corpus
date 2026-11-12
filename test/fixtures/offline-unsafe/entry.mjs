// A module that is not offline-safe: it reads a file when it is imported. The
// rejection-path tests in test/search-subpath.test.mjs point both guards at it.
import { readFileSync } from 'node:fs';

export const metadata = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));

export function searchBundles() {
  return [];
}
