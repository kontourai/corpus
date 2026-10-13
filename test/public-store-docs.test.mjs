import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
test('public store extraction evidence contains no machine-private receipt paths', () => {
  const text = readFileSync(new URL('../docs/store-extraction.md', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /\/tmp\/corpus-program\//);
});


test('public expected-fail binding counts match the actual list', () => {
  const entries = Object.values(JSON.parse(readFileSync(new URL('../packages/store/test/expected-fails.json', import.meta.url), 'utf8')));
  const assertions = entries.filter((entry) => entry.assertions).length;
  const patterns = entries.filter((entry) => entry.errorPattern).length;
  const text = readFileSync(new URL('../docs/store-extraction.md', import.meta.url), 'utf8');
  assert.ok(text.includes(`${assertions} of the ${entries.length} expected failures are bound to ref/kind/expected/actual, and ${patterns} to\nspecific error patterns.`));
});
