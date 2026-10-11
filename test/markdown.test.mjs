import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeMarkdown, githubSlug, resolveLink } from '../src/markdown.mjs';

// Expected values are what github.com renders for these headings.
test('githubSlug follows GitHub heading anchors', () => {
  assert.equal(githubSlug('Getting Started'), 'getting-started');
  assert.equal(githubSlug('docs-bundle.json'), 'docs-bundlejson');
  assert.equal(githubSlug('What’s new? (v2)'), 'whats-new-v2');
  assert.equal(githubSlug('snake_case & kebab-case'), 'snake_case--kebab-case');
  assert.equal(githubSlug('Émoji 🚀 support'), 'émoji--support');
  assert.equal(githubSlug('日本語 見出し'), '日本語-見出し');
});

test('analyzeMarkdown slugs rendered heading text, counts duplicates, and ignores fenced code', () => {
  const { headings, anchors, title } = analyzeMarkdown(
    '# The `foo` API\n\n## Setup\n\n```md\n## Not a heading\n```\n\n## Setup\n\n> ## Quoted\n\n<a id="custom"></a>\n',
  );
  assert.equal(title, 'The foo API');
  assert.deepEqual(headings.map((h) => [h.slug, h.topLevel]), [
    ['the-foo-api', true],
    ['setup', true],
    ['setup-1', true],
    ['quoted', false],
  ]);
  assert.ok(anchors.has('custom'));
  assert.ok(!anchors.has('not-a-heading'));
});

test('resolveLink classifies targets relative to the source document', () => {
  assert.deepEqual(resolveLink('https://example.com', 'docs/a.md'), { kind: 'external' });
  assert.deepEqual(resolveLink('#x', 'docs/a.md'), { kind: 'fragment', fragment: 'x', rawFragment: 'x' });
  assert.deepEqual(resolveLink('../README.md#top', 'docs/a.md'), { kind: 'local', path: 'README.md', fragment: 'top', rawFragment: 'top' });
  assert.deepEqual(resolveLink('/src/x%20y.js', 'docs/deep/a.md'), { kind: 'local', path: 'src/x y.js', fragment: '', rawFragment: '' });
  assert.equal(resolveLink('../../outside.md', 'docs/a.md').kind, 'invalid');
});
