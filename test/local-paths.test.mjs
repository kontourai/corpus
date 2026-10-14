import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { commitAll, fixtureRepo, runCli, scratch } from './helpers.mjs';

function editManifest(repo, edit) {
  const file = path.join(repo, 'corpus.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  edit(manifest);
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

const lineCount = (file) => readFileSync(file, 'utf8').split('\n').length;

/** The valid fixture with a home path in prose, a code block, and raw HTML. Returns { repo, lines }. */
function leakyRepo(t) {
  const repo = fixtureRepo(t, 'valid');
  const concepts = path.join(repo, 'docs/concepts.md');
  const start = path.join(repo, 'docs/getting-started.md');
  const readme = path.join(repo, 'README.md');
  // The fixtures end in a newline and have 23, 14, and 14 lines, so appended text starts on line 24, 15, and 15.
  const lines = { prose: 24, code: 16, html: 15 };
  assert.deepEqual([lineCount(concepts), lineCount(start), lineCount(readme)], [24, 15, 15], 'fixture line counts changed');
  appendFileSync(concepts, 'The cache lives in /Users/alice/Library/Caches/sample on my laptop.\n');
  appendFileSync(start, '```sh\ncd /home/bob/src/sample && sample run\n```\n');
  appendFileSync(readme, '<img src="file:///C:/Users/Carol/Pictures/x.png" alt="x"> and C:\\Users\\Dave\\sample\n');
  return { repo, lines };
}

test('paths gate: home-directory paths in prose, code, and raw HTML fail with file:line (exit 1)', async (t) => {
  const { repo, lines } = leakyRepo(t);
  const result = await runCli(['check', '--root', repo]);
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /FAIL paths/);
  assert.ok(result.stderr.includes(`docs/concepts.md:${lines.prose}: local path "/Users/alice/"`), result.stderr);
  assert.ok(result.stderr.includes(`docs/getting-started.md:${lines.code}: local path "/home/bob/"`), result.stderr);
  assert.ok(result.stderr.includes(`README.md:${lines.html}: local path "C:/Users/Carol/"`), result.stderr);
  assert.ok(result.stderr.includes(`README.md:${lines.html}: local path "C:\\Users\\Dave\\"`), result.stderr);
  assert.match(result.stderr, /docs-kit check failed: 4 failures/);
  for (const gate of ['links', 'reachability', 'topics', 'redirects']) assert.match(result.stderr, new RegExp(`PASS ${gate}`));
});

test('paths gate: line numbers count stripped front matter', async (t) => {
  const repo = fixtureRepo(t, 'valid');
  const file = path.join(repo, 'docs/concepts.md');
  writeFileSync(file, `---\ntitle: Concepts\n---\n${readFileSync(file, 'utf8')}See /home/erin/notes/.\n`);
  const expected = lineCount(file) - 1;
  const result = await runCli(['check', '--root', repo]);
  assert.equal(result.status, 1, result.output);
  assert.ok(result.stderr.includes(`docs/concepts.md:${expected}: local path "/home/erin/"`), result.stderr);
});

test('paths gate: placeholders and look-alike URLs pass', async (t) => {
  const repo = fixtureRepo(t, 'valid');
  appendFileSync(
    path.join(repo, 'docs/concepts.md'),
    'Use /Users/<name>/ or /home/$USER/ or %USERPROFILE%; see https://example.com/home/frank/x and /srv/home/grace/.\n',
  );
  const result = await runCli(['check', '--root', repo]);
  assert.equal(result.status, 0, result.output);
  assert.match(result.stdout, /PASS paths/);
});

test('paths gate: a bundle-only (publish: false) document is scanned too', async (t) => {
  const repo = fixtureRepo(t, 'bundle-only');
  appendFileSync(path.join(repo, 'docs/manual.md'), '\nState is in /Users/heidi/.sample/state.json.\n');
  const result = await runCli(['check', '--root', repo]);
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /docs\/manual\.md:\d+: local path "\/Users\/heidi\/"/);
});

test('paths gate: build refuses to publish a leaked path (exit 1)', async (t) => {
  const { repo } = leakyRepo(t);
  commitAll(repo, 'leak');
  const result = await runCli(['build', '--root', repo, '--out', path.join(scratch(t), 'site')]);
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /FAIL paths/);
  assert.match(result.stderr, /refusing to build until check passes/);
});

test('allowLocalPaths exempts exactly the listed documents', async (t) => {
  const { repo, lines } = leakyRepo(t);
  editManifest(repo, (manifest) => {
    manifest.allowLocalPaths = ['docs/getting-started.md', 'README.md'];
  });
  const result = await runCli(['check', '--root', repo]);
  assert.equal(result.status, 1, result.output);
  assert.ok(result.stderr.includes(`docs/concepts.md:${lines.prose}: local path "/Users/alice/"`), result.stderr);
  assert.doesNotMatch(result.stderr, /getting-started\.md:\d+: local path|README\.md:\d+: local path/);
  assert.match(result.stderr, /docs-kit check failed: 1 failure$/m);

  editManifest(repo, (manifest) => manifest.allowLocalPaths.push('docs/concepts.md'));
  const allowed = await runCli(['check', '--root', repo]);
  assert.equal(allowed.status, 0, allowed.output);
  assert.match(allowed.stdout, /PASS paths/);
});

test('allowLocalPaths is strict: no globs, only documents, no repeats, an array (exit 2)', async (t) => {
  const repo = fixtureRepo(t, 'valid');
  editManifest(repo, (manifest) => {
    manifest.allowLocalPaths = ['docs/*.md', 'docs/plans/roadmap.md', 'CONTRIBUTING.md', 'docs/concepts.md', 'docs/concepts.md', '../x.md'];
  });
  const result = await runCli(['check', '--root', repo]);
  assert.equal(result.status, 2, result.output);
  assert.match(result.stderr, /allowLocalPaths\[0\] "docs\/\*\.md" must be an exact document path; globs are not allowed/);
  assert.match(result.stderr, /allowLocalPaths\[1\] "docs\/plans\/roadmap\.md" is not a document/);
  assert.match(result.stderr, /allowLocalPaths\[2\] "CONTRIBUTING\.md" is not a document/);
  assert.match(result.stderr, /allowLocalPaths\[4\] "docs\/concepts\.md" is listed more than once/);
  assert.match(result.stderr, /allowLocalPaths\[5\] must not contain "\.\."/);
  assert.match(result.stderr, /SKIP paths \(corpus\.json is invalid\)/);

  editManifest(repo, (manifest) => {
    manifest.allowLocalPaths = 'docs/concepts.md';
  });
  const notArray = await runCli(['check', '--root', repo]);
  assert.equal(notArray.status, 2, notArray.output);
  assert.match(notArray.stderr, /allowLocalPaths must be an array of document paths/);
});

test('paths gate: /Users/Shared/ and /home/runner/ are not personal and pass', async (t) => {
  const repo = fixtureRepo(t, 'valid');
  appendFileSync(
    path.join(repo, 'docs/concepts.md'),
    'Shared files live in /Users/Shared/sample/ and CI checks out to /home/runner/work/sample/.\nBut /home/runnerx/ and /Users/SharedX/ are people.\n',
  );
  const result = await runCli(['check', '--root', repo]);
  assert.equal(result.status, 1, result.output);
  assert.doesNotMatch(result.stderr, /"\/Users\/Shared\/"|"\/home\/runner\/"/);
  assert.ok(result.stderr.includes('docs/concepts.md:25: local path "/home/runnerx/"'), result.stderr);
  assert.ok(result.stderr.includes('docs/concepts.md:25: local path "/Users/SharedX/"'), result.stderr);
  assert.match(result.stderr, /docs-kit check failed: 2 failures/);
});
