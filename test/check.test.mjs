import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateManifest } from '../src/manifest.mjs';
import { FIXTURES, commitAll, fixtureRepo, git, runCli, scratch } from './helpers.mjs';

const fixture = (name) => path.join(FIXTURES, name);

test('check passes the valid fixture', async () => {
  const result = await runCli(['check', '--root', fixture('valid')]);
  assert.equal(result.status, 0, result.output);
  for (const gate of ['manifest', 'links', 'reachability', 'topics']) assert.match(result.stdout, new RegExp(`PASS ${gate}`));
  assert.match(result.stdout, /docs-kit check passed/);
});

test('check rejects a broken relative link (exit 1)', async () => {
  const result = await runCli(['check', '--root', fixture('broken-link')]);
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /FAIL links/);
  assert.match(result.stderr, /docs\/a\.md:3: \[missing guide\]\(missing-guide\.md\) - missing target docs\/missing-guide\.md/);
});

test('check rejects a link to a missing anchor (exit 1)', async () => {
  const result = await runCli(['check', '--root', fixture('missing-anchor')]);
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /\[setup\]\(b\.md#setup-steps\) - missing anchor #setup-steps in docs\/b\.md/);
});

test('check rejects an unlisted doc but accepts excluded ones (exit 1)', async () => {
  const result = await runCli(['check', '--root', fixture('unlisted-doc')]);
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /FAIL reachability/);
  assert.match(result.stderr, /docs\/orphan\.md is neither listed in documents nor matched by exclude/);
  assert.doesNotMatch(result.stderr, /drafts\/idea\.md/);
});

test('check rejects a topic whose anchor does not resolve (exit 1)', async () => {
  const result = await runCli(['check', '--root', fixture('bad-topic-anchor')]);
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /FAIL topics/);
  assert.match(result.stderr, /topic "setup": #installation does not match a heading in docs\/a\.md/);
});

test('check refuses unknown manifest keys at every level (exit 2)', async () => {
  const result = await runCli(['check', '--root', fixture('unknown-key')]);
  assert.equal(result.status, 2, result.output);
  assert.match(result.stderr, /corpus\.json: unknown key "sections"/);
  assert.match(result.stderr, /documents\[0\]: unknown key "order"/);
  assert.match(result.stderr, /SKIP links \(corpus\.json is invalid\)/);
});

test('check refuses v2 without required purpose (exit 2)', async () => {
  const result = await runCli(['check', '--root', fixture('schema-v2')]);
  assert.equal(result.status, 2, result.output);
  assert.match(result.stderr, /missing required key "purpose"/);
});

test('check refuses source paths that escape the root (exit 2)', async () => {
  const result = await runCli(['check', '--root', fixture('path-escape')]);
  assert.equal(result.status, 2, result.output);
  assert.match(result.stderr, /documents\[1\]\.source must not contain "\.\."/);
  assert.match(result.stderr, /topics\[0\]\.source path must be relative to the repository root, not absolute/);
});

test('check refuses a listed document that is a symlink out of the repository (exit 2)', async (t) => {
  const dir = scratch(t);
  const repo = path.join(dir, 'repo');
  mkdirSync(path.join(repo, 'docs'), { recursive: true });
  writeFileSync(path.join(dir, 'outside.md'), '# Outside\n');
  writeFileSync(path.join(repo, 'README.md'), '# Repo\n');
  symlinkSync(path.join(dir, 'outside.md'), path.join(repo, 'docs', 'escape.md'));
  writeFileSync(
    path.join(repo, 'corpus.json'),
    JSON.stringify({ schemaVersion: 2, product: 'repo', title: 'Repo', repo: 'kontourai/repo', purpose: 'A fixture.', builtOn: [], documents: [{ source: 'docs/escape.md', section: 'Guide' }] }),
  );
  const result = await runCli(['check', '--root', repo]);
  assert.equal(result.status, 2, result.output);
  assert.match(result.stderr, /documents\[0\]\.source "docs\/escape\.md" does not exist \(or is outside the repository\)/);
});

test('check reports every failing gate, not only the first', async (t) => {
  const repo = fixtureRepo(t, 'broken-link');
  writeFileSync(path.join(repo, 'docs', 'orphan.md'), '# Orphan\n');
  const result = await runCli(['check', '--root', repo]);
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /FAIL links/);
  assert.match(result.stderr, /FAIL reachability/);
  assert.match(result.stderr, /check failed: 2 failures/);
});

test('check without a manifest is a usage error (exit 2) that names corpus.json', async (t) => {
  const result = await runCli(['check', '--root', scratch(t)]);
  assert.equal(result.status, 2, result.output);
  assert.match(result.stderr, /no corpus\.json in .*\(run "corpus init" to scaffold one\)/);
  assert.doesNotMatch(result.stderr, /docs-kit\.json/);
});

test('validateManifest without a file name labels problems with corpus.json, not the retired name', () => {
  const { errors } = validateManifest({ schemaVersion: 2 }, FIXTURES);
  assert.ok(errors.length > 0);
  for (const error of errors) assert.match(error, /^corpus\.json: /);
});

test('mcp --repo without a manifest names corpus.json as the expected file (exit 2)', async (t) => {
  const result = await runCli(['mcp', '--repo', scratch(t)]);
  assert.equal(result.status, 2, result.output);
  assert.match(result.stderr, /no corpus\.json in .*\(run "corpus init" to scaffold one\)/);
});

test('freshness: a covered change without a doc change is stale (exit 1); --advisory warns (exit 0)', async (t) => {
  const repo = fixtureRepo(t, 'valid');
  appendFileSync(path.join(repo, 'src', 'cli', 'main.js'), 'export const added = true;\n');
  commitAll(repo, 'change covered source only');

  const strict = await runCli(['check', '--root', repo, '--base', 'HEAD~1']);
  assert.equal(strict.status, 1, strict.output);
  assert.match(strict.stderr, /FAIL freshness \(1 changed files since HEAD~1\)/);
  assert.match(strict.stderr, /docs\/getting-started\.md is stale: covered files changed since HEAD~1 \(src\/cli\/main\.js\)/);
  assert.match(strict.stderr, /docs\/reference\/cli\.md is stale/);
  assert.doesNotMatch(strict.stderr, /docs\/concepts\.md is stale/);

  const advisory = await runCli(['check', '--root', repo, '--base', 'HEAD~1', '--advisory']);
  assert.equal(advisory.status, 0, advisory.output);
  assert.match(advisory.stdout, /WARN freshness/);
  assert.match(advisory.stdout, /warning: docs\/getting-started\.md is stale/);
});

test('freshness: updating the covering docs in the same range passes', async (t) => {
  const repo = fixtureRepo(t, 'valid');
  appendFileSync(path.join(repo, 'src', 'cli', 'main.js'), 'export const added = true;\n');
  appendFileSync(path.join(repo, 'docs', 'getting-started.md'), '\nUpdated for the new flag.\n');
  appendFileSync(path.join(repo, 'docs', 'reference', 'cli.md'), '\nDocuments the new flag.\n');
  commitAll(repo, 'change source and docs together');
  const result = await runCli(['check', '--root', repo, '--base', 'HEAD~1']);
  assert.equal(result.status, 0, result.output);
  assert.match(result.stdout, /PASS freshness \(3 changed files since HEAD~1\)/);
});

test('freshness: a base ref that does not resolve is exit 2, never a pass', async (t) => {
  const repo = fixtureRepo(t, 'valid');
  const result = await runCli(['check', '--root', repo, '--base', 'no-such-branch']);
  assert.equal(result.status, 2, result.output);
  assert.match(result.stderr, /ERROR freshness/);
  assert.match(result.stderr, /--base no-such-branch does not resolve to a commit/);
  const advisory = await runCli(['check', '--root', repo, '--base', 'no-such-branch', '--advisory']);
  assert.equal(advisory.status, 2, 'advisory must not hide a git error');
});

test('freshness outside a git repository is exit 2', async (t) => {
  const dir = scratch(t);
  const copy = path.join(dir, 'valid');
  cpSync(fixture('valid'), copy, { recursive: true });
  const result = await runCli(['check', '--root', copy, '--base', 'HEAD~1'], { env: { GIT_CEILING_DIRECTORIES: dir } });
  assert.equal(result.status, 2, result.output);
  assert.match(result.stderr, /does not resolve to a commit/);
});

test('--advisory without --base is a usage error', async () => {
  const result = await runCli(['check', '--root', fixture('valid'), '--advisory']);
  assert.equal(result.status, 2, result.output);
  assert.match(result.stderr, /--advisory only applies to the freshness gate/);
});

test('freshness uses the merge base, so main moving ahead does not mark docs stale', async (t) => {
  const repo = fixtureRepo(t, 'valid');
  git(repo, ['branch', '-M', 'main']);
  git(repo, ['checkout', '-q', '-b', 'feature']);
  appendFileSync(path.join(repo, 'docs', 'concepts.md'), '\nFeature docs.\n');
  commitAll(repo, 'feature docs');
  git(repo, ['checkout', '-q', 'main']);
  appendFileSync(path.join(repo, 'src', 'cli', 'main.js'), 'export const onMain = true;\n');
  commitAll(repo, 'main moves');
  git(repo, ['checkout', '-q', 'feature']);
  const result = await runCli(['check', '--root', repo, '--base', 'main']);
  assert.equal(result.status, 0, result.output);
  assert.match(result.stdout, /PASS freshness \(1 changed files since main\)/);
});

function editManifest(repo, edit) {
  const file = path.join(repo, 'corpus.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  edit(manifest);
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

test('covers: a bare directory expands to dir/**; a glob matching nothing fails the covers gate but not build', async (t) => {
  const repo = fixtureRepo(t, 'valid');
  editManifest(repo, (manifest) => {
    manifest.documents[0].covers = ['src/cli'];
    delete manifest.documents[2].covers;
  });
  commitAll(repo, 'bare directory covers');
  appendFileSync(path.join(repo, 'src', 'cli', 'main.js'), 'export const more = 1;\n');
  commitAll(repo, 'touch covered code');
  const stale = await runCli(['check', '--root', repo, '--base', 'HEAD~1']);
  assert.equal(stale.status, 1, stale.output);
  assert.match(stale.stderr, /docs\/getting-started\.md is stale: covered files changed since HEAD~1 \(src\/cli\/main\.js\)/);

  editManifest(repo, (manifest) => {
    manifest.documents[1].covers = ['src/nope/**', 'src/cli/*.js'];
  });
  commitAll(repo, 'a covers glob that matches nothing');
  appendFileSync(path.join(repo, 'src', 'cli', 'main.js'), 'export const again = 2;\n');
  commitAll(repo, 'touch covered code again');

  // A dead glob is a covers gate failure (exit 1), not a manifest error, and
  // freshness still runs for the other documents.
  const unmatched = await runCli(['check', '--root', repo, '--base', 'HEAD~1']);
  assert.equal(unmatched.status, 1, unmatched.output);
  assert.match(unmatched.stderr, /PASS manifest/);
  assert.match(unmatched.stderr, /FAIL covers\n    - docs\/concepts\.md: covers "src\/nope\/\*\*" matches no tracked file/);
  assert.doesNotMatch(unmatched.stderr, /covers "src\/cli\/\*\.js"/);
  assert.match(unmatched.stderr, /FAIL freshness/);
  assert.match(unmatched.stderr, /docs\/getting-started\.md is stale/);

  // build and MCP are not blocked by it.
  const build = await runCli(['build', '--root', repo, '--out', path.join(scratch(t), 'site')]);
  assert.equal(build.status, 0, build.output);
});

test('freshness counts the old path of a renamed file', async (t) => {
  const repo = fixtureRepo(t, 'valid');
  writeFileSync(path.join(repo, 'src', 'cli', 'helper.js'), 'export const helper = 1;\n');
  editManifest(repo, (manifest) => {
    manifest.documents[0].covers = ['src/cli/*.js'];
    delete manifest.documents[2].covers;
  });
  commitAll(repo, 'covers by glob');
  mkdirSync(path.join(repo, 'lib'));
  git(repo, ['mv', 'src/cli/main.js', 'lib/main.js']);
  commitAll(repo, 'move main.js out of the covered directory');
  const result = await runCli(['check', '--root', repo, '--base', 'HEAD~1']);
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /FAIL freshness \(2 changed files since HEAD~1\)/);
  assert.match(result.stderr, /docs\/getting-started\.md is stale: covered files changed since HEAD~1 \(src\/cli\/main\.js\)/);
});

test('anchors use GitHub slugs from github-slugger (a superscript is dropped)', async () => {
  const result = await runCli(['check', '--root', fixture('valid')]);
  assert.equal(result.status, 0, result.output);
  assert.match(readFileSync(path.join(fixture('valid'), 'docs', 'concepts.md'), 'utf8'), /## Area in m² units[\s\S]*\(#area-in-m-units\)/);
});
