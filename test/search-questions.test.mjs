import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { FIXTURES, fixtureRepo } from './helpers.mjs';
import { bundleFromCheckout } from '../src/bundle.mjs';
import { bundleShapeError, searchBundles } from '../src/mcp.mjs';
import { outline } from '../src/search.mjs';
import { OPEN_QUESTIONS, QUESTIONS, QUESTION_BUNDLES, expectedRank } from './search-questions.mjs';

// The fixtures are docs-bundle.json files exactly as `corpus build` wrote and
// published them to https://kontourai.github.io/<product>/docs-bundle.json;
// each carries the sha and build time it was made at.
const bundles = QUESTION_BUNDLES.map((product) => JSON.parse(readFileSync(path.join(FIXTURES, 'search-bundles', `${product}.docs-bundle.json`), 'utf8')));

test('the question-set fixtures have the shape the current build writes', (t) => {
  const built = bundleFromCheckout(fixtureRepo(t, 'valid'));
  const keys = (value) => Object.keys(value).sort();
  for (const bundle of bundles) {
    assert.equal(bundleShapeError(bundle), null, bundle.product);
    assert.deepEqual(keys(bundle), keys(built), `${bundle.product}: top-level keys`);
    for (const document of bundle.documents) assert.deepEqual(keys(document), keys(built.documents[0]), `${bundle.product}: ${document.source}`);
    for (const topic of bundle.topics) assert.deepEqual(keys(topic), keys(built.topics[0]), `${bundle.product}: topic ${topic.id}`);
  }
});

test('every expected part exists in the fixtures', () => {
  const byProduct = new Map(bundles.map((bundle) => [bundle.product, bundle]));
  for (const { question, expect } of [...QUESTIONS, ...OPEN_QUESTIONS])
    for (const part of expect) {
      const bundle = byProduct.get(part.product);
      assert.ok(bundle, `${question}: no bundle ${part.product}`);
      if (part.kind === 'topic') assert.ok(bundle.topics.some((topic) => topic.id === part.id), `${question}: no topic ${part.id}`);
      else {
        const document = bundle.documents.find((entry) => entry.source === part.source);
        assert.ok(document, `${question}: no document ${part.source}`);
        if (part.kind === 'row') assert.ok(outline(document.markdown).rows.some((row) => row.name === part.name), `${question}: no row ${part.name}`);
      }
    }
});

for (const { question, expect } of QUESTIONS)
  test(`question: ${question}`, () => {
    const results = searchBundles(bundles, question, 10);
    const rank = expectedRank(results, expect);
    assert.ok(
      rank !== null && rank <= 3,
      `expected ${JSON.stringify(expect)} in the top 3, got rank ${rank}:\n${results
        .slice(0, 5)
        .map((result) => `  ${result.score} ${result.product} ${result.kind} ${result.id ?? result.name ?? result.source}`)
        .join('\n')}`,
    );
  });

test('open questions are reported, not asserted', (t) => {
  for (const { question, expect } of OPEN_QUESTIONS) t.diagnostic(`open: rank ${expectedRank(searchBundles(bundles, question, 10), expect) ?? '>10'} for "${question}"`);
});
