import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { commitAll, fixtureRepo, git, runCli, scratch, withoutToolbarScript } from './helpers.mjs';

async function buildValid(t, extraArgs = []) {
  const repo = fixtureRepo(t, 'valid', { as: 'sample' });
  const out = path.join(scratch(t), 'site');
  const result = await runCli(['build', '--root', repo, '--out', out, ...extraArgs]);
  assert.equal(result.status, 0, result.output);
  const sha = git(repo, ['rev-parse', 'HEAD']);
  const read = (file) => readFileSync(path.join(out, file), 'utf8');
  return { repo, out, sha, read, result };
}

test('build renders the landing page, one page per document, assets and .nojekyll', async (t) => {
  const { out, read } = await buildValid(t);
  for (const file of ['index.html', 'docs/getting-started.html', 'docs/concepts.html', 'docs/reference/cli.html', 'docs-kit.css', '.nojekyll', 'docs/assets/diagram.svg', 'docs-bundle.json'])
    assert.ok(existsSync(path.join(out, file)), `${file} is generated`);
  assert.ok(!existsSync(path.join(out, 'docs/plans/roadmap.html')), 'excluded docs are not published');

  const index = read('index.html');
  assert.match(index, /<h1 id="sample" data-src-line="1-1">Sample/);
  assert.match(index, /href="https:\/\/kontourai\.github\.io\/">All Kontour docs</, 'links back to the hub');
  assert.match(index, /href="https:\/\/github\.com\/kontourai\/sample">GitHub</, 'links to the repo');
  assert.match(index, /<img src="docs\/assets\/diagram\.svg" alt="Architecture"/);

  const nav = read('docs/concepts.html').match(/<nav class="site-nav"[\s\S]*?<\/nav>/)[0];
  const order = [...nav.matchAll(/<h2>([^<]+)<\/h2>/g)].map((match) => match[1]);
  assert.deepEqual(order, ['Overview', 'Start Here', 'Understand Sample', 'Reference'], 'sections in manifest order');
  assert.match(nav, /<a href="concepts\.html" aria-current="page">Concepts<\/a>/);
  assert.match(nav, /<a href="reference\/cli\.html">CLI reference<\/a>/);
});

test('build rewrites links between published docs and sends unpublished files to GitHub at the sha', async (t) => {
  const { read, sha } = await buildValid(t);
  const gettingStarted = read('docs/getting-started.html');
  assert.match(gettingStarted, /<a href="reference\/cli\.html#sample-run">CLI reference<\/a>/);
  assert.match(gettingStarted, /<a href="concepts\.html#workflows">workflows<\/a>/);
  assert.match(gettingStarted, /<a href="\.\.\/index\.html">overview<\/a>/, 'a link to the landing page goes to index.html');
  assert.match(gettingStarted, /<a href="#run-it-1">jump<\/a>/);
  assert.match(gettingStarted, /<h2 id="run-it-1" data-src-line="\d+-\d+">/);

  const cli = read('docs/reference/cli.html');
  assert.ok(cli.includes(`<a href="https://github.com/kontourai/sample/blob/${sha}/src/cli/main.js">main source</a>`), 'repo file -> blob');
  assert.ok(cli.includes(`<a href="https://github.com/kontourai/sample/blob/${sha}/docs/plans/roadmap.md">roadmap</a>`), 'excluded doc -> blob');

  const index = read('index.html');
  assert.ok(index.includes(`<a href="https://github.com/kontourai/sample/blob/${sha}/CONTRIBUTING.md">CONTRIBUTING</a>`));
  assert.ok(index.includes(`<a href="https://github.com/kontourai/sample/tree/${sha}/src/cli">source tree</a>`), 'directory -> tree');
  assert.match(index, /<a href="docs\/concepts\.html#workflows">concepts<\/a>/);
});

test('build writes docs-bundle.json with the contract fields', async (t) => {
  const { read, sha } = await buildValid(t);
  const bundle = JSON.parse(read('docs-bundle.json'));
  assert.deepEqual(Object.keys(bundle), ['schemaVersion', 'product', 'title', 'tagline', 'repo', 'sha', 'builtAt', 'siteUrl', 'digest', 'documents', 'topics']);
  assert.equal(bundle.schemaVersion, 1);
  assert.equal(bundle.product, 'sample');
  assert.equal(bundle.tagline, 'A fixture product for docs-kit tests');
  assert.equal(bundle.repo, 'kontourai/sample');
  assert.equal(bundle.sha, sha);
  assert.ok(!Number.isNaN(Date.parse(bundle.builtAt)) && bundle.builtAt.endsWith('Z'));
  assert.equal(bundle.siteUrl, 'https://kontourai.github.io/sample/');

  assert.deepEqual(
    bundle.documents.map(({ source, section, title, landing, url }) => ({ source, section, title, landing, url })),
    [
      { source: 'README.md', section: null, title: 'Sample', landing: true, url: 'https://kontourai.github.io/sample/index.html' },
      { source: 'docs/getting-started.md', section: 'Start Here', title: 'Getting started', landing: false, url: 'https://kontourai.github.io/sample/docs/getting-started.html' },
      { source: 'docs/concepts.md', section: 'Understand Sample', title: 'Concepts', landing: false, url: 'https://kontourai.github.io/sample/docs/concepts.html' },
      { source: 'docs/reference/cli.md', section: 'Reference', title: 'CLI reference', landing: false, url: 'https://kontourai.github.io/sample/docs/reference/cli.html' },
    ],
  );
  assert.equal(bundle.documents[2].markdown, readFileSync(path.join(import.meta.dirname, 'fixtures/valid/docs/concepts.md'), 'utf8'));

  const workflows = bundle.topics.find((topic) => topic.id === 'workflows');
  assert.equal(workflows.url, 'https://kontourai.github.io/sample/docs/concepts.html#workflows');
  assert.equal(workflows.markdown, '## Workflows\n\nA workflow is an ordered list of steps.\n\n### Steps\n\nEach step names its evidence.\n', 'section stops at the next same-level heading and keeps deeper ones');
  const install = bundle.topics.find((topic) => topic.id === 'install');
  assert.equal(install.url, 'https://kontourai.github.io/sample/index.html#install');
  assert.ok(install.markdown.startsWith('## Install\n') && !install.markdown.includes('# Sample'));
  const whole = bundle.topics.find((topic) => topic.id === 'getting-started');
  assert.equal(whole.markdown, bundle.documents[1].markdown, 'a topic without an anchor is the whole document');

  const canonical = JSON.stringify({
    documents: bundle.documents.map(({ source, section, title, landing, markdown }) => ({ source, section, title, landing, markdown })),
    topics: bundle.topics.map(({ id, title, source, markdown }) => ({ id, title, source, markdown })),
  });
  assert.equal(bundle.digest, createHash('sha256').update(canonical).digest('hex'));
});

test('build honors --base-url and keeps the digest independent of it', async (t) => {
  const first = await buildValid(t);
  const second = await buildValid(t, ['--base-url', 'https://docs.example.test/sample']);
  const a = JSON.parse(first.read('docs-bundle.json'));
  const b = JSON.parse(second.read('docs-bundle.json'));
  assert.equal(b.siteUrl, 'https://docs.example.test/sample/');
  assert.equal(b.documents[1].url, 'https://docs.example.test/sample/docs/getting-started.html');
  assert.equal(a.digest, b.digest);
});

test('build fails when the generated site would contain a broken link (exit 1)', async (t) => {
  const repo = fixtureRepo(t, 'broken-generated-link');
  const check = await runCli(['check', '--root', repo]);
  assert.equal(check.status, 0, 'the Markdown gates pass; only the generated site is broken');
  const out = path.join(scratch(t), 'site');
  const result = await runCli(['build', '--root', repo, '--out', out]);
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /generated site has 1 broken internal link/);
  assert.match(result.stderr, /docs\/a\.html: href="#legacy-anchor" - missing anchor #legacy-anchor/);
});

test('build refuses to build when check fails', async (t) => {
  const repo = fixtureRepo(t, 'broken-link');
  const out = path.join(scratch(t), 'site');
  const result = await runCli(['build', '--root', repo, '--out', out]);
  assert.equal(result.status, 1, result.output);
  assert.match(result.stderr, /refusing to build until check passes/);
  assert.ok(!existsSync(path.join(out, 'index.html')));
});

test('build refuses an --out that would delete the sources', async (t) => {
  const repo = fixtureRepo(t, 'valid');
  for (const out of [repo, path.join(repo, 'docs')]) {
    const result = await runCli(['build', '--root', repo, '--out', out]);
    assert.equal(result.status, 2, result.output);
    assert.match(result.stderr, /refusing to delete it/);
  }
  assert.ok(existsSync(path.join(repo, 'docs', 'concepts.md')));
});

test('build rejects a non-http --base-url (exit 2)', async (t) => {
  const repo = fixtureRepo(t, 'valid');
  const result = await runCli(['build', '--root', repo, '--out', path.join(scratch(t), 'site'), '--base-url', 'ftp://example.test/']);
  assert.equal(result.status, 2, result.output);
  assert.match(result.stderr, /--base-url must be an http\(s\) URL/);
});

test('build neutralizes javascript: links', async (t) => {
  const repo = fixtureRepo(t, 'valid');
  writeFileSync(path.join(repo, 'docs', 'concepts.md'), `${readFileSync(path.join(repo, 'docs', 'concepts.md'), 'utf8')}\n[click](javascript:alert(1))\n`);
  const out = path.join(scratch(t), 'site');
  const result = await runCli(['build', '--root', repo, '--out', out]);
  assert.equal(result.status, 0, result.output);
  const html = readFileSync(path.join(out, 'docs/concepts.html'), 'utf8');
  assert.doesNotMatch(html, /javascript:/);
});

test('build --out only replaces directories it created (marker), and never tracked files or .git', async (t) => {
  const repo = fixtureRepo(t, 'valid');
  mkdirSync(path.join(repo, 'site'));
  writeFileSync(path.join(repo, 'site', 'keep.txt'), 'tracked\n');
  writeFileSync(path.join(repo, 'site', '.docs-kit-build'), JSON.stringify({ generator: '@kontourai/docs-kit', files: ['keep.txt'] }));
  commitAll(repo, 'tracked file in site/');

  const tracked = await runCli(['build', '--root', repo, '--out', path.join(repo, 'site')]);
  assert.equal(tracked.status, 2, tracked.output);
  assert.match(tracked.stderr, /contains 2 git-tracked file\(s\)/);
  assert.ok(existsSync(path.join(repo, 'site', 'keep.txt')));

  const insideGit = await runCli(['build', '--root', repo, '--out', path.join(repo, '.git', 'pages')]);
  assert.equal(insideGit.status, 2, insideGit.output);
  assert.match(insideGit.stderr, /inside a \.git directory/);

  // Outside any git checkout: a non-empty directory without the marker survives.
  const outside = path.join(scratch(t), 'mine');
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'precious.txt'), 'not docs-kit output\n');
  const foreign = await runCli(['build', '--root', repo, '--out', outside]);
  assert.equal(foreign.status, 2, foreign.output);
  assert.match(foreign.stderr, /non-empty directory without a valid \.docs-kit-build manifest/);
  assert.ok(existsSync(path.join(outside, 'precious.txt')));

  // The same rule holds for a git-ignored directory.
  writeFileSync(path.join(repo, '.gitignore'), 'dist-pages/\n');
  mkdirSync(path.join(repo, 'dist-pages'));
  writeFileSync(path.join(repo, 'dist-pages', 'notes.txt'), 'ignored but not ours\n');
  const ignored = await runCli(['build', '--root', repo, '--out', path.join(repo, 'dist-pages')]);
  assert.equal(ignored.status, 2, ignored.output);
  assert.match(ignored.stderr, /without a valid \.docs-kit-build manifest/);
  assert.ok(existsSync(path.join(repo, 'dist-pages', 'notes.txt')));

  // A new directory is fine, and a docs-kit output is replaced on the next build.
  const fresh = path.join(scratch(t), 'fresh');
  for (let i = 0; i < 2; i++) {
    const result = await runCli(['build', '--root', repo, '--out', fresh]);
    assert.equal(result.status, 0, `build ${i + 1}: ${result.output}`);
  }
  const marker = JSON.parse(readFileSync(path.join(fresh, '.docs-kit-build'), 'utf8'));
  assert.equal(marker.generator, '@kontourai/docs-kit');
  assert.ok(marker.files.includes('index.html') && marker.files.includes('docs/assets/diagram.svg') && marker.files.includes('.nojekyll'));
  assert.ok(!marker.files.includes('.docs-kit-build'));

  // A file added by hand to a docs-kit output is not in the manifest: refuse and name it.
  mkdirSync(path.join(fresh, 'notes'));
  writeFileSync(path.join(fresh, 'notes', 'handwritten.md'), 'mine\n');
  const handAdded = await runCli(['build', '--root', repo, '--out', fresh]);
  assert.equal(handAdded.status, 2, handAdded.output);
  assert.match(handAdded.stderr, /contains notes\/handwritten\.md, which the previous docs-kit build did not write; refusing to delete it/);
  assert.ok(existsSync(path.join(fresh, 'notes', 'handwritten.md')));
});

test('commented-out HTML is neither checked nor treated as an anchor', async (t) => {
  const repo = fixtureRepo(t, 'valid');
  writeFileSync(
    path.join(repo, 'docs', 'concepts.md'),
    `${readFileSync(path.join(repo, 'docs', 'concepts.md'), 'utf8')}\n<!-- <a href="docs/old.md">old</a> <img src="gone.png"> <a id="ghost"></a> -->\n\n<!--\n<a href='also-gone.md'>multi-line</a>\n-->\n`,
  );
  commitAll(repo, 'comments');
  const check = await runCli(['check', '--root', repo]);
  assert.equal(check.status, 0, check.output);
  const build = await runCli(['build', '--root', repo, '--out', path.join(scratch(t), 'site')]);
  assert.equal(build.status, 0, build.output);

  writeFileSync(path.join(repo, 'docs', 'concepts.md'), `${readFileSync(path.join(repo, 'docs', 'concepts.md'), 'utf8')}\n[ghost](#ghost)\n`);
  const anchor = await runCli(['check', '--root', repo]);
  assert.equal(anchor.status, 1, 'an id inside a comment is not an anchor');
  assert.match(anchor.stderr, /missing anchor #ghost/);
});

test('srcset with a data: URI parses as one candidate, and an empty raw href is allowed', async (t) => {
  const repo = fixtureRepo(t, 'valid');
  const dataUri = 'data:image/png;base64,iVBORw0KGgo=,AAAA';
  writeFileSync(
    path.join(repo, 'docs', 'concepts.md'),
    `${readFileSync(path.join(repo, 'docs', 'concepts.md'), 'utf8')}\n<img srcset="${dataUri} 1x, assets/diagram.svg 2x" alt="mixed"> <a href="">top</a>\n`,
  );
  mkdirSync(path.join(repo, 'docs', 'assets'), { recursive: true });
  writeFileSync(path.join(repo, 'docs', 'assets', 'diagram.svg'), readFileSync(path.join(import.meta.dirname, 'fixtures/valid/docs/assets/diagram.svg')));
  commitAll(repo, 'srcset data uri');
  const check = await runCli(['check', '--root', repo]);
  assert.equal(check.status, 0, check.output);
  const out = path.join(scratch(t), 'site');
  const build = await runCli(['build', '--root', repo, '--out', out]);
  assert.equal(build.status, 0, build.output);
  const html = readFileSync(path.join(out, 'docs', 'concepts.html'), 'utf8');
  assert.ok(html.includes(`srcset="${dataUri} 1x, assets/diagram.svg 2x"`), 'data URI kept whole, local candidate rewritten');
});

test('sanitizer keeps <details open> and <video>/<source> media attributes, and copies the video', async (t) => {
  const repo = fixtureRepo(t, 'valid');
  writeFileSync(path.join(repo, 'docs', 'assets', 'demo.mp4'), 'not really a video');
  writeFileSync(
    path.join(repo, 'docs', 'concepts.md'),
    `${readFileSync(path.join(repo, 'docs', 'concepts.md'), 'utf8')}\n<details open><summary>Open</summary>Body.</details>\n\n<video src="assets/demo.mp4" controls width="320" height="180" poster="https://example.com/p.png" muted loop autoplay playsinline onplay="x()"><source src="assets/demo.mp4" type="video/mp4"></video>\n`,
  );
  commitAll(repo, 'media');
  const out = path.join(scratch(t), 'site');
  const build = await runCli(['build', '--root', repo, '--out', out]);
  assert.equal(build.status, 0, build.output);
  const html = readFileSync(path.join(out, 'docs', 'concepts.html'), 'utf8');
  assert.match(html, /<details open(="")?>/);
  const video = html.match(/<video[^>]*>/)[0];
  for (const attribute of ['src="assets/demo.mp4"', 'controls', 'width="320"', 'height="180"', 'poster="https://example.com/p.png"', 'muted', 'loop', 'autoplay', 'playsinline'])
    assert.ok(video.includes(attribute), `${attribute} in ${video}`);
  assert.doesNotMatch(video, /onplay/);
  assert.match(html, /<source src="assets\/demo\.mp4" type="video\/mp4"/);
  assert.ok(existsSync(path.join(out, 'docs', 'assets', 'demo.mp4')), 'embedded media is copied');
});

test('check and build handle raw HTML href/src/srcset in every quoting style', async (t) => {
  const broken = fixtureRepo(t, 'valid');
  writeFileSync(
    path.join(broken, 'docs', 'concepts.md'),
    `${readFileSync(path.join(broken, 'docs', 'concepts.md'), 'utf8')}\n<a href='gone.md'>single</a> <img src=missing.png alt=x> <img srcset="assets/diagram.svg 1x, assets/absent.svg 2x" alt="y"> <a href="#no-such-anchor">frag</a>\n`,
  );
  const check = await runCli(['check', '--root', broken]);
  assert.equal(check.status, 1, check.output);
  assert.match(check.stderr, /docs\/concepts\.md:\d+: <\.\.\. href="gone\.md"> - missing target docs\/gone\.md/);
  assert.match(check.stderr, /<\.\.\. src="missing\.png"> - missing target docs\/missing\.png/);
  assert.match(check.stderr, /<\.\.\. srcset="assets\/absent\.svg"> - missing target docs\/assets\/absent\.svg/);
  assert.match(check.stderr, /<\.\.\. href="#no-such-anchor"> - missing anchor #no-such-anchor/);
  assert.doesNotMatch(check.stderr, /assets\/diagram\.svg"> - missing/);

  const good = fixtureRepo(t, 'valid');
  writeFileSync(
    path.join(good, 'docs', 'getting-started.md'),
    `${readFileSync(path.join(good, 'docs', 'getting-started.md'), 'utf8')}\n<a href='concepts.md#workflows'>single</a> <img src=assets/diagram.svg alt=unquoted> <img srcset="assets/diagram.svg 1x, assets/hi.svg 2x" alt="set">\n`,
  );
  copyFileSync(path.join(good, 'docs', 'assets', 'diagram.svg'), path.join(good, 'docs', 'assets', 'hi.svg'));
  commitAll(good, 'raw html');
  const out = path.join(scratch(t), 'site');
  const build = await runCli(['build', '--root', good, '--out', out]);
  assert.equal(build.status, 0, build.output);
  const html = readFileSync(path.join(out, 'docs', 'getting-started.html'), 'utf8');
  assert.match(html, /<a href="concepts\.html#workflows">single<\/a>/);
  assert.match(html, /<img src="assets\/diagram\.svg" alt="unquoted"/);
  assert.match(html, /srcset="assets\/diagram\.svg 1x, assets\/hi\.svg 2x"/);
  assert.ok(existsSync(path.join(out, 'docs', 'assets', 'hi.svg')), 'srcset-only image copied');
});

test('anchors from id/name attributes count in any quoting, in check and in the generated site', async (t) => {
  const repo = fixtureRepo(t, 'valid');
  writeFileSync(
    path.join(repo, 'docs', 'concepts.md'),
    `${readFileSync(path.join(repo, 'docs', 'concepts.md'), 'utf8')}\n<a id='single-id'></a><a name=bare-name></a>\n\n[to single](#single-id) and [to bare](#bare-name).\n`,
  );
  commitAll(repo, 'html anchors');
  const check = await runCli(['check', '--root', repo]);
  assert.equal(check.status, 0, check.output);
  const build = await runCli(['build', '--root', repo, '--out', path.join(scratch(t), 'site')]);
  assert.equal(build.status, 0, build.output);
});

test('build sanitizes rendered HTML: no script, no on* handlers, no javascript: URLs', async (t) => {
  const repo = fixtureRepo(t, 'valid');
  writeFileSync(
    path.join(repo, 'docs', 'concepts.md'),
    `${readFileSync(path.join(repo, 'docs', 'concepts.md'), 'utf8')}\n<script>alert('pwned')</script>\n\n<img src="assets/diagram.svg" onerror="alert(1)" alt="kept"> <a href="https://example.com" onclick="steal()">ok</a> <iframe src="https://evil.example"></iframe> <a href="JaVaScRiPt:alert(2)">js</a>\n\n<details><summary>More</summary>Kept.</details>\n`,
  );
  commitAll(repo, 'hostile html');
  const out = path.join(scratch(t), 'site');
  const build = await runCli(['build', '--root', repo, '--out', out]);
  assert.equal(build.status, 0, build.output);
  const html = withoutToolbarScript(readFileSync(path.join(out, 'docs', 'concepts.html'), 'utf8'));
  assert.doesNotMatch(html, /<script|pwned|onerror|onclick|<iframe|javascript:/i);
  assert.match(html, /<img src="assets\/diagram\.svg" alt="kept"/);
  assert.match(html, /<a href="https:\/\/example\.com">ok<\/a>/);
  assert.match(html, /<details><summary>More<\/summary>Kept\.<\/details>/);
  assert.match(html, /<h2 id="workflows" data-src-line="5-5">Workflows<a class="anchor" href="#workflows"/, 'heading ids and anchor links survive');
});

test('git calls ignore GIT_DIR and friends exported by a git hook, reading --root and never writing the hook repository', async (t) => {
  const root = fixtureRepo(t, 'valid');
  const other = fixtureRepo(t, 'second');
  const otherHead = git(other, ['rev-parse', 'HEAD']);
  const rootHead = git(root, ['rev-parse', 'HEAD']);
  assert.notEqual(rootHead, otherHead);
  const out = path.join(scratch(t), 'site');
  const hookEnv = { GIT_DIR: path.join(other, '.git'), GIT_INDEX_FILE: path.join(other, '.git', 'index') };
  const result = await runCli(['build', '--root', root, '--out', out], { env: hookEnv });
  assert.equal(result.status, 0, result.output);
  const bundle = JSON.parse(readFileSync(path.join(out, 'docs-bundle.json'), 'utf8'));
  assert.equal(bundle.sha, rootHead);
  assert.equal(git(other, ['rev-parse', 'HEAD']), otherHead);
});

test('assets: untracked, ignored, and .git files are unpublishable; tracked files over 25 MB stay links', async (t) => {
  const repo = fixtureRepo(t, 'valid');
  writeFileSync(path.join(repo, '.gitignore'), '.env\n');
  writeFileSync(path.join(repo, '.env'), 'API_TOKEN=secret\n');
  commitAll(repo, 'ignore .env');
  const concepts = readFileSync(path.join(repo, 'docs', 'concepts.md'), 'utf8');
  writeFileSync(path.join(repo, 'docs', 'scratch.txt'), 'untracked notes\n');
  writeFileSync(path.join(repo, 'docs', 'concepts.md'), `${concepts}\n<img src="../.env" alt="env"> ![config](../.git/config) [notes](scratch.txt)\n`);

  const check = await runCli(['check', '--root', repo]);
  assert.equal(check.status, 1, check.output);
  assert.match(check.stderr, /src="\.\.\/\.env"> - unpublishable reference: \.env is not tracked by git \(untracked or ignored\)/);
  assert.match(check.stderr, /\(\.\.\/\.git\/config\) - unpublishable reference: \.git\/config is inside \.git/);
  assert.match(check.stderr, /\(scratch\.txt\) - unpublishable reference: docs\/scratch\.txt is not tracked by git/);
  const out = path.join(scratch(t), 'site');
  const build = await runCli(['build', '--root', repo, '--out', out]);
  assert.equal(build.status, 1, build.output);
  assert.ok(!existsSync(path.join(out, '.env')) && !existsSync(path.join(out, '.git')), 'nothing secret was copied');

  // A tracked file above the cap keeps the GitHub link instead of being copied.
  writeFileSync(path.join(repo, 'docs', 'concepts.md'), `${concepts}\n![huge](assets/huge.png)\n`);
  rmSync(path.join(repo, 'docs', 'scratch.txt'));
  const huge = openSync(path.join(repo, 'docs', 'assets', 'huge.png'), 'w');
  ftruncateSync(huge, 25 * 1024 * 1024 + 1);
  closeSync(huge);
  const sha = commitAll(repo, 'huge tracked image');
  const big = await runCli(['build', '--root', repo, '--out', out]);
  assert.equal(big.status, 0, big.output);
  assert.ok(!existsSync(path.join(out, 'docs', 'assets', 'huge.png')));
  assert.ok(readFileSync(path.join(out, 'docs', 'concepts.html'), 'utf8').includes(`src="https://github.com/kontourai/sample/blob/${sha}/docs/assets/huge.png"`));
});

test('raw-HTML extraction uses a real tokenizer: <!-- inside an attribute value is not a comment', async (t) => {
  const repo = fixtureRepo(t, 'valid');
  writeFileSync(
    path.join(repo, 'docs', 'concepts.md'),
    `${readFileSync(path.join(repo, 'docs', 'concepts.md'), 'utf8')}\n<a title="see <!-- note" href="gone.md">trap</a> <a title='-->' href="also-gone.md">x</a>\n`,
  );
  const check = await runCli(['check', '--root', repo]);
  assert.equal(check.status, 1, check.output);
  assert.match(check.stderr, /href="gone\.md"> - missing target docs\/gone\.md/);
  assert.match(check.stderr, /href="also-gone\.md"> - missing target docs\/also-gone\.md/);
});

test('video poster is link-checked and copied', async (t) => {
  const repo = fixtureRepo(t, 'valid');
  const concepts = readFileSync(path.join(repo, 'docs', 'concepts.md'), 'utf8');
  writeFileSync(path.join(repo, 'docs', 'concepts.md'), `${concepts}\n<video controls poster="assets/missing-poster.png"></video>\n`);
  const check = await runCli(['check', '--root', repo]);
  assert.equal(check.status, 1, check.output);
  assert.match(check.stderr, /poster="assets\/missing-poster\.png"> - missing target docs\/assets\/missing-poster\.png/);

  copyFileSync(path.join(repo, 'docs', 'assets', 'diagram.svg'), path.join(repo, 'docs', 'assets', 'poster.svg'));
  writeFileSync(path.join(repo, 'docs', 'concepts.md'), `${concepts}\n<video controls poster="assets/poster.svg"></video>\n`);
  commitAll(repo, 'poster');
  const out = path.join(scratch(t), 'site');
  const build = await runCli(['build', '--root', repo, '--out', out]);
  assert.equal(build.status, 0, build.output);
  assert.ok(existsSync(path.join(out, 'docs', 'assets', 'poster.svg')));
  assert.match(readFileSync(path.join(out, 'docs', 'concepts.html'), 'utf8'), /poster="assets\/poster\.svg"/);
});

test('assets: committed symlinks to an ignored .env, to .git/config, or through a symlinked directory are unpublishable', async (t) => {
  const repo = fixtureRepo(t, 'valid');
  writeFileSync(path.join(repo, '.gitignore'), '.env\n');
  writeFileSync(path.join(repo, '.env'), 'API_TOKEN=secret\n');
  symlinkSync('../../.env', path.join(repo, 'docs', 'assets', 'pic.png'));
  symlinkSync('../../.git/config', path.join(repo, 'docs', 'assets', 'conf.png'));
  symlinkSync('assets', path.join(repo, 'docs', 'media'));
  writeFileSync(
    path.join(repo, 'docs', 'concepts.md'),
    `${readFileSync(path.join(repo, 'docs', 'concepts.md'), 'utf8')}\n![pic](assets/pic.png) <img src="assets/conf.png" alt="c"> ![via dir](media/diagram.svg)\n`,
  );
  commitAll(repo, 'tracked symlinks');
  assert.match(git(repo, ['ls-files', '-s', 'docs/assets/pic.png', 'docs/assets/conf.png', 'docs/media']), /^120000 /m, 'the symlinks are committed');

  const check = await runCli(['check', '--root', repo]);
  assert.equal(check.status, 1, check.output);
  assert.match(check.stderr, /\(assets\/pic\.png\) - unpublishable reference: docs\/assets\/pic\.png goes through the symlink docs\/assets\/pic\.png/);
  assert.match(check.stderr, /src="assets\/conf\.png"> - unpublishable reference: docs\/assets\/conf\.png goes through the symlink docs\/assets\/conf\.png/);
  assert.match(check.stderr, /\(media\/diagram\.svg\) - unpublishable reference: docs\/media\/diagram\.svg goes through the symlink docs\/media/);

  const out = path.join(scratch(t), 'site');
  const build = await runCli(['build', '--root', repo, '--out', out]);
  assert.equal(build.status, 1, build.output);
  for (const file of ['docs/assets/pic.png', 'docs/assets/conf.png', 'docs/media/diagram.svg'])
    assert.ok(!existsSync(path.join(out, file)), `${file} not copied`);
});

test('assets referenced only by tags the sanitizer strips are not copied', async (t) => {
  const repo = fixtureRepo(t, 'valid');
  for (const name of ['framed.svg', 'embedded.pdf', 'sound.mp3', 'captions.vtt', 'style.css', 'code.js'])
    writeFileSync(path.join(repo, 'docs', 'assets', name), 'x');
  writeFileSync(
    path.join(repo, 'docs', 'concepts.md'),
    `${readFileSync(path.join(repo, 'docs', 'concepts.md'), 'utf8')}\n<iframe src="assets/framed.svg"></iframe> <embed src="assets/embedded.pdf"> <link href="assets/style.css"> <script src="assets/code.js"></script> <audio src="assets/sound.mp3"><track src="assets/captions.vtt"></audio>\n\n![kept](assets/diagram.svg)\n`,
  );
  commitAll(repo, 'stripped tags');
  const out = path.join(scratch(t), 'site');
  const build = await runCli(['build', '--root', repo, '--out', out]);
  assert.equal(build.status, 0, build.output);
  for (const name of ['framed.svg', 'embedded.pdf', 'sound.mp3', 'captions.vtt', 'style.css', 'code.js'])
    assert.ok(!existsSync(path.join(out, 'docs', 'assets', name)), `${name} must not be copied`);
  assert.ok(existsSync(path.join(out, 'docs', 'assets', 'diagram.svg')), 'a surviving image is still copied');
});
