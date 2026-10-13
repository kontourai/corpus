import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
test('public store extraction evidence contains no machine-private receipt paths', () => {
  const text = readFileSync(new URL('../docs/store-extraction.md', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /\/tmp\/corpus-program\//);
});
