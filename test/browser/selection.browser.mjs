// Headless Chromium checks of page layout, the selection toolbar, and WebMCP
// tools against a built fixture site. Run with `npm run test:browser`; it needs a Chromium for
// playwright-core (`npx playwright-core install chromium`). A missing browser
// fails the run: it is never reported as a pass.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { FIXTURES, commitAll, git, runCli } from '../helpers.mjs';

const SCREENSHOT_DIR = process.env.DOCS_KIT_SCREENSHOT_DIR ?? path.join(tmpdir(), 'docs-kit-selection-screenshots');
const ISSUE_URL_MAX = 8000;
const MOBILE_IDENTIFIER = 'corpus_record_identifier_'.repeat(12) + 'record_end';
const MOBILE_URL = 'https://example.invalid/' + 'documentationsegment'.repeat(12);
const MOBILE_CODE = 'corpus locate --record ' + 'unbroken_code_'.repeat(20) + 'code_end';
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };

let work;
let sha;
let server;
let origin;
let browser;

async function buildSite(repo, out) {
  const result = await runCli(['build', '--root', repo, '--out', out]);
  assert.equal(result.status, 0, result.output);
}

before(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'docs-kit-browser-'));
  const repo = path.join(work, 'sample');
  cpSync(path.join(FIXTURES, 'selection'), repo, { recursive: true });
  git(repo, ['init', '-q']);
  sha = commitAll(repo, 'fixture');
  await buildSite(repo, path.join(work, 'site', 'sample'));
  // The same docs with the challenge-issue primary action, served at /challenge/.
  const manifestFile = path.join(repo, 'corpus.json');
  writeFileSync(manifestFile, JSON.stringify({ ...JSON.parse(readFileSync(manifestFile, 'utf8')), selectionActions: { primary: 'challenge-issue' } }));
  commitAll(repo, 'challenge primary');
  await buildSite(repo, path.join(work, 'site', 'challenge'));

  const columns = Array.from({ length: 12 }, (_, index) => `Column ${index + 1}`);
  writeFileSync(path.join(repo, 'docs', 'mobile.md'), [
    '# Mobile content', '',
    `Identifier: \`${MOBILE_IDENTIFIER}\``, '',
    `Link: [${MOBILE_URL}](${MOBILE_URL})`, '',
    '```text', MOBILE_CODE, '```', '',
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    `| ${columns.map((_, index) => `Value ${index + 1}`).join(' | ')} |`, '',
  ].join('\n'));
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  manifest.documents.push({ source: 'docs/mobile.md', section: 'Guide' });
  writeFileSync(manifestFile, JSON.stringify(manifest));
  commitAll(repo, 'mobile overflow fixture');
  await buildSite(repo, path.join(work, 'site', 'mobile'));

  const root = path.join(work, 'site');
  server = createServer((request, response) => {
    const file = path.join(root, decodeURIComponent(new URL(request.url, 'http://x').pathname));
    try {
      if (!file.startsWith(root) || !statSync(file).isFile()) throw new Error('not a file');
      response.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      response.end(readFileSync(file));
    } catch {
      response.writeHead(404);
      response.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  try {
    browser = await chromium.launch();
  } catch (error) {
    throw new Error(`cannot launch Chromium for playwright-core; run "npx playwright-core install chromium". ${error.message.split('\n')[0]}`);
  }
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
});

after(async () => {
  await browser?.close();
  server?.close();
  if (work) rmSync(work, { recursive: true, force: true });
});

/**
 * A fresh page with clipboard permission, window.open recorded instead of
 * navigating, and every console error and uncaught exception collected.
 */
async function openPage(t, { url = '/sample/docs/guide.html', init = [], context: contextOptions = {}, colorScheme = 'light' } = {}) {
  const context = await browser.newContext({ colorScheme, ...contextOptions });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  t.after(() => context.close());
  await context.addInitScript(() => {
    window.__opened = [];
    window.open = (href) => {
      window.__opened.push(String(href));
      return null;
    };
  });
  for (const script of init) await context.addInitScript(script);
  const page = await context.newPage();
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`${origin}${url}`);
  t.after(() => assert.deepEqual(errors, [], 'no console errors or uncaught exceptions'));
  return page;
}

/** Select `text` inside the first element matching `selector`, as a user would, by setting the document selection. */
async function select(page, selector, text) {
  await page.evaluate(
    ([selector, text]) => {
      const element = document.querySelector(selector);
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let all = '';
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        nodes.push([node, all.length]);
        all += node.data;
      }
      const start = all.indexOf(text);
      if (start === -1) throw new Error(`"${text}" not found in ${selector}`);
      const end = start + text.length;
      const at = (offset, isEnd) => {
        for (const [node, from] of nodes) if (offset < from + node.data.length || (isEnd && offset === from + node.data.length)) return [node, offset - from];
        throw new Error('offset out of range');
      };
      const range = document.createRange();
      range.setStart(...at(start, false));
      range.setEnd(...at(end, true));
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    },
    [selector, text],
  );
  await page.locator('.dk-toolbar').waitFor({ state: 'visible' });
}

const clipboard = (page) => page.evaluate(() => navigator.clipboard.readText());
const opened = (page) => page.evaluate(() => window.__opened);

async function copied(page, action) {
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.locator(`.dk-toolbar button[data-action="${action}"]`).click();
  await page.locator('.dk-toast.dk-visible').waitFor();
  return clipboard(page);
}

test('selecting a paragraph with the mouse shows the toolbar, and Ask copies a prompt with exact provenance', async (t) => {
  const page = await openPage(t);
  await page.locator('p[data-src-line="8-9"]').click({ clickCount: 3 });
  await page.locator('.dk-toolbar').waitFor({ state: 'visible' });
  const prompt = await copied(page, 'ask');
  assert.ok(prompt.includes(`Source: docs/guide.md:8-9@${sha}`), prompt);
  assert.ok(prompt.includes('Product: Sample (sample), repository kontourai/sample'));
  assert.ok(prompt.includes('Section: Guide'));
  assert.ok(prompt.includes(`Page: ${origin}/sample/docs/guide.html#guide`));
  // The source line break renders as a space, so the copied text is one line.
  assert.ok(prompt.includes('\n> The guide explains how Sample runs a workflow end to end, and why each step records its evidence.\n'), prompt);
  assert.match(prompt, /kontour-docs MCP `locate` tool with product "sample"/);
  assert.match(prompt, /read the actual source code/);
  assert.ok(prompt.endsWith('\nQuestion: '), 'ends with the question slot');
  const toast = page.locator('.dk-toast');
  assert.equal(await toast.getAttribute('aria-live'), 'polite');
  assert.equal(await toast.getAttribute('role'), 'status');
  assert.match(await toast.textContent(), /^Copied ask prompt for “The guide explains how Sample/);
});

test('Ask resolves a list item, a code block, and a selection across list items', async (t) => {
  const page = await openPage(t);
  const cases = [
    ['li[data-src-line="14-15"]', 'sample init in your repository', '14-15', 'Setup', '#setup'],
    ['pre[data-src-line="26-29"]', 'sample report', '26-29', 'Setup', '#setup'],
    ['main article', 'Install the CLI with npm.\nRun sample init in your repository.\nThe command writes a starter config.\nCommit the config', '13-16', 'Setup', '#setup'],
    ['blockquote', 'never times out', '31-32', 'Setup', '#setup'],
    ['h2#hostile-text', 'Hostile', '34-34', 'Hostile text', '#hostile-text'],
  ];
  for (const [selector, text, lines, heading, anchor] of cases) {
    await select(page, selector, text);
    const prompt = await copied(page, 'ask');
    assert.ok(prompt.includes(`Source: docs/guide.md:${lines}@${sha}`), `${text}: ${prompt}`);
    assert.ok(prompt.includes(`Section: ${heading}\n`), `${text}: section`);
    assert.ok(prompt.includes(`docs/guide.html${anchor}\n`), `${text}: anchor`);
  }
});

test('Challenge copies a verification prompt, and its issue action opens a prefilled issue under the length cap', async (t) => {
  const page = await openPage(t);
  await select(page, 'li[data-src-line="14-15"]', 'sample init in your repository');
  const prompt = await copied(page, 'challenge');
  assert.ok(prompt.includes(`Is this accurate? Verify the claim against the implementation at ${sha} and current main. If it's wrong or unclear, propose a doc fix (or a code fix if the doc describes intended behaviour).`));
  assert.ok(prompt.includes(`Source: docs/guide.md:14-15@${sha}`));

  await page.locator('.dk-toolbar button[data-action="challenge-issue"]').click();
  const [short] = await opened(page);
  const url = new URL(short);
  assert.equal(`${url.origin}${url.pathname}`, 'https://github.com/kontourai/sample/issues/new');
  assert.equal(url.searchParams.get('labels'), 'docs-challenge');
  assert.equal(url.searchParams.get('title'), 'Docs challenge: docs/guide.md:14-15');
  const body = url.searchParams.get('body');
  assert.ok(body.includes('\n```text\nsample init in your repository\n```\n'), body);
  assert.ok(body.includes(`- Source: \`docs/guide.md:14-15@${sha}\``));
  assert.ok(body.startsWith('Is this accurate?'));

  // The long passage is about 9,000 characters: the quote is cut with an ellipsis to fit.
  const long = await page.locator('p[data-src-line="44-44"]').textContent();
  assert.ok(long.length > ISSUE_URL_MAX, 'the fixture passage is longer than the cap');
  await page.locator('p[data-src-line="44-44"]').click({ clickCount: 3 });
  await page.locator('.dk-toolbar').waitFor({ state: 'visible' });
  await page.locator('.dk-toolbar button[data-action="challenge-issue"]').click();
  const capped = (await opened(page))[1];
  assert.ok(capped.length <= ISSUE_URL_MAX, `issue URL is ${capped.length} characters`);
  assert.ok(capped.length > ISSUE_URL_MAX - 200, 'and keeps as much of the quote as fits');
  const cappedBody = new URL(capped).searchParams.get('body');
  assert.match(cappedBody, /\n```text\nLong start: evidence [^\n]*…\n```\n/);
  assert.ok(cappedBody.includes(`- Source: \`docs/guide.md:44-44@${sha}\``), 'the provenance survives truncation');
});

test('the issue body fences the quote, so selected @names and #numbers stay inert, even with backticks in the text', async (t) => {
  const page = await openPage(t, { url: '/sample/docs/twins.html' });
  await select(page, 'p[data-src-line="11-11"]', 'Ping @octocat about ```fences``` in #123');
  await page.locator('.dk-toolbar button[data-action="challenge-issue"]').click();
  const body = new URL((await opened(page))[0]).searchParams.get('body');
  assert.ok(body.includes('\n````text\nPing @octocat about ```fences``` in #123\n````\n'), body);
  assert.ok(!body.includes('> Ping'), 'not a blockquote');
});

test('Edit opens the source on GitHub at the manifest branch and the first line', async (t) => {
  const page = await openPage(t);
  await select(page, 'tr[data-src-line="24-24"]', 'Print what would change');
  await page.locator('.dk-toolbar button[data-action="edit"]').click();
  assert.deepEqual(await opened(page), ['https://github.com/kontourai/sample/edit/trunk/docs/guide.md#L24']);
});

test('keyboard: Alt+A asks, Alt+C challenges, Alt+T focuses the toolbar, arrows move, Escape closes', async (t) => {
  const page = await openPage(t);
  await select(page, 'p[data-src-line="8-9"]', 'runs a workflow end to end');
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.keyboard.press('Alt+KeyA');
  await page.locator('.dk-toast.dk-visible').waitFor();
  assert.match(await clipboard(page), /Source: docs\/guide\.md:8-9@[\s\S]*Question: $/);
  await page.keyboard.press('Alt+KeyC');
  await page.waitForFunction(async () => (await navigator.clipboard.readText()).includes('Is this accurate?'));

  await page.keyboard.press('Alt+KeyT');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.action), 'ask');
  assert.equal(await page.locator('.dk-toolbar button[data-action="ask"]').getAttribute('aria-keyshortcuts'), 'Alt+A');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.action), 'edit');
  await page.keyboard.press('Enter');
  assert.deepEqual(await opened(page), ['https://github.com/kontourai/sample/edit/trunk/docs/guide.md#L8']);
  await page.keyboard.press('Escape');
  await page.locator('.dk-toolbar').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => document.activeElement.id), 'main');
});

test('selected text reaches the page only as text: the toast and the clipboard fallback dialog never parse it as HTML', async (t) => {
  const literal = '<img src=x onerror="window.__xss=1">';
  const page = await openPage(t, {
    init: [() => Object.defineProperty(Navigator.prototype, 'clipboard', { get: () => undefined, configurable: true })],
  });
  await select(page, 'p[data-src-line="36-36"]', `The literal text ${literal} appears`);
  await page.keyboard.press('Alt+KeyA');
  const dialog = page.locator('dialog.dk-dialog');
  await dialog.waitFor({ state: 'visible' });
  const value = await dialog.locator('textarea').inputValue();
  assert.ok(value.includes(`> The literal text ${literal} appears`), value);
  assert.ok(value.includes(`Source: docs/guide.md:36-36@${sha}`));
  assert.equal(await page.evaluate(() => document.activeElement.tagName), 'TEXTAREA');
  assert.equal(await page.evaluate(() => getSelection().toString().length > 0), true, 'the prompt is selected for copying');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'clipboard-fallback-dialog.png') });
  await dialog.locator('button').click();
  await dialog.waitFor({ state: 'hidden' });

  // With a clipboard, the toast quotes an excerpt of the selection.
  const withClipboard = await openPage(t);
  await select(withClipboard, 'p[data-src-line="36-36"]', literal);
  await withClipboard.keyboard.press('Alt+KeyA');
  const toast = withClipboard.locator('.dk-toast.dk-visible');
  await toast.waitFor();
  assert.ok((await toast.textContent()).includes(literal));
  assert.equal(await toast.evaluate((element) => element.children.length), 0, 'the toast holds text only');
  for (const target of [page, withClipboard]) {
    await target.waitForTimeout(100);
    assert.equal(await target.evaluate(() => window.__xss), undefined, 'the selection was never parsed as HTML');
    assert.equal(await target.evaluate(() => document.querySelectorAll('body img').length), 0);
  }
});

test('touch: a selection on a phone shows the toolbar below it, and a tap on Ask copies the prompt', async (t) => {
  const page = await openPage(t, { context: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } });
  await select(page, 'li[data-src-line="13-13"]', 'Install the CLI with npm.');
  const box = await page.locator('.dk-toolbar').boundingBox();
  const selection = await page.evaluate(() => getSelection().getRangeAt(0).getBoundingClientRect().toJSON());
  assert.ok(box.y >= selection.bottom, `toolbar (${box.y}) sits below the selection (${selection.bottom}), clear of the native menu`);
  assert.ok(box.x >= 0 && box.x + box.width <= 390, 'toolbar stays inside the viewport');
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.locator('.dk-toolbar button[data-action="ask"]').tap();
  await page.locator('.dk-toast.dk-visible').waitFor();
  assert.ok((await clipboard(page)).includes(`Source: docs/guide.md:13-13@${sha}`));
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'toolbar-touch.png') });
});

for (const width of [390, 320]) test(`mobile content wraps inline text and scrolls wide blocks locally at ${width}px`, async (t) => {
  const page = await openPage(t, { url: '/mobile/docs/mobile.html', context: { viewport: { width, height: 844 }, hasTouch: true, isMobile: true } });
  assert.equal(await page.locator('.doc p code').textContent(), MOBILE_IDENTIFIER);
  assert.equal(await page.locator('.doc p a').textContent(), MOBILE_URL);
  assert.equal(await page.locator('.doc pre code').textContent(), MOBILE_CODE + '\n');
  assert.equal(await page.locator('.doc tbody td').last().textContent(), 'Value 12');
  const layout = await page.evaluate(() => {
    const doc = document.querySelector('.doc');
    return { viewport: document.documentElement.clientWidth, page: document.documentElement.scrollWidth, article: doc.clientWidth, articleScroll: doc.scrollWidth };
  });
  t.diagnostic(JSON.stringify(layout));
  assert.equal(layout.viewport, width);
  assert.ok(layout.page <= width + 1, `document width ${layout.page} exceeds ${width}px viewport`);
  assert.ok(layout.articleScroll <= layout.article + 1, 'wide blocks do not overflow the article');
  for (const selector of ['.doc p code', '.doc p a']) {
    const wrapped = await page.locator(selector).evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const bounds = element.closest('.doc').getBoundingClientRect();
      const lines = [...range.getClientRects()];
      return { lines: lines.length, inside: lines.every((line) => line.left >= bounds.left - 1 && line.right <= bounds.right + 1) };
    });
    assert.ok(wrapped.lines > 1 && wrapped.inside, `${selector} wraps into readable lines inside the article`);
  }
  const headerWordLines = await page.locator('.doc th').first().evaluate((element) => {
    const range = document.createRange();
    range.setStart(element.firstChild, 0);
    range.setEnd(element.firstChild, 'Column'.length);
    return range.getClientRects().length;
  });
  assert.equal(headerWordLines, 1, 'table header words stay intact rather than wrapping into individual letters');
  for (const selector of ['.doc pre', '.doc .table-scroll']) {
    const scrolled = await page.locator(selector).evaluate((element) => {
      const overflow = element.scrollWidth - element.clientWidth;
      element.scrollLeft = element.scrollWidth;
      const last = element.matches('pre') ? element.querySelector('code').lastChild : element.querySelector('tbody td:last-child').firstChild;
      const range = document.createRange();
      range.setStart(last, Math.max(0, last.length - 8));
      range.setEnd(last, last.length);
      const end = range.getBoundingClientRect(), bounds = element.getBoundingClientRect();
      return { overflow, moved: element.scrollLeft, endVisible: end.left >= bounds.left && end.right <= bounds.right + 1 };
    });
    assert.ok(scrolled.overflow > 0 && scrolled.moved > 0 && scrolled.endVisible, `${selector} scrolls to its readable final content: ${JSON.stringify(scrolled)}`);
  }
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `mobile-content-${width}.png`), fullPage: true });
});

test('the challenge-issue primary action leads the toolbar when the manifest asks for it', async (t) => {
  const page = await openPage(t, { url: '/challenge/docs/guide.html' });
  await select(page, 'p[data-src-line="8-9"]', 'end to end');
  const actions = await page.locator('.dk-toolbar button').evaluateAll((buttons) => buttons.map((button) => [button.dataset.action, button.className]));
  assert.deepEqual(actions, [['challenge-issue', 'dk-primary'], ['challenge', ''], ['ask', ''], ['edit', '']]);
  const ask = await openPage(t);
  await select(ask, 'p[data-src-line="8-9"]', 'end to end');
  assert.equal(await ask.locator('.dk-toolbar button.dk-primary').getAttribute('data-action'), 'ask');
});

test('the toolbar stays hidden for selections outside <main> and for empty selections', async (t) => {
  const page = await openPage(t);
  await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('.site-footer'));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await page.waitForTimeout(250);
  assert.equal(await page.locator('.dk-toolbar').isVisible(), false);
  await select(page, 'p[data-src-line="8-9"]', 'end to end');
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.locator('.dk-toolbar').waitFor({ state: 'hidden' });
});

const STUB_PROMISE_API = () => {
  window.__tools = [];
  Object.defineProperty(document, 'modelContext', {
    configurable: true,
    value: {
      registerTool(tool, options) {
        window.__tools.push({ tool, options });
        return Promise.resolve();
      },
    },
  });
};

test('WebMCP: with document.modelContext, the tools register with an AbortSignal and answer from the page and the bundle', async (t) => {
  const page = await openPage(t, { init: [STUB_PROMISE_API] });
  const registered = await page.evaluate(() =>
    window.__tools.map(({ tool, options }) => ({
      name: tool.name,
      readOnly: tool.annotations?.readOnlyHint,
      schema: tool.inputSchema?.type,
      signal: options?.signal instanceof AbortSignal && !options.signal.aborted,
    })),
  );
  assert.deepEqual(registered, [
    { name: 'get_selection_context', readOnly: true, schema: 'object', signal: true },
    { name: 'search_docs', readOnly: true, schema: 'object', signal: true },
    { name: 'get_topic', readOnly: true, schema: 'object', signal: true },
  ]);
  const execute = (name, input) =>
    page.evaluate(([name, input]) => window.__tools.find(({ tool }) => tool.name === name).tool.execute(input, { signal: new AbortController().signal }), [name, input]);

  const nothing = await execute('get_selection_context', {});
  assert.equal(nothing.selection, null);
  assert.equal(nothing.page.path, 'docs/guide.md');

  await select(page, 'li[data-src-line="14-15"]', 'sample init in your repository');
  const { selection } = await execute('get_selection_context', {});
  assert.deepEqual(selection, {
    product: 'sample',
    title: 'Sample',
    repo: 'kontourai/sample',
    path: 'docs/guide.md',
    sha,
    branch: 'trunk',
    startLine: 14,
    endLine: 15,
    heading: 'Setup',
    anchor: 'setup',
    url: `${origin}/sample/docs/guide.html#setup`,
    text: 'sample init in your repository',
  });

  const search = await execute('search_docs', { query: 'gate evidence' });
  assert.equal(search.sha, sha);
  assert.ok(search.results.some((result) => result.source === 'docs/guide.md'), JSON.stringify(search));
  const topic = await execute('get_topic', { id: 'setup' });
  assert.match(topic.topic.markdown, /^## Setup\n/);
  const unknown = await execute('get_topic', { id: 'nope' });
  assert.deepEqual(unknown, { error: 'unknown topic "nope"', availableTopics: ['setup'] });
  const empty = await execute('search_docs', { query: '  ' });
  assert.match(empty.error, /at least one word/);

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'toolbar-light.png') });
});

test('WebMCP: the older synchronous navigator.modelContext API gets MCP-style content, and a throwing API is ignored', async (t) => {
  const legacy = await openPage(t, {
    init: [
      () => {
        window.__tools = [];
        Object.defineProperty(Navigator.prototype, 'modelContext', {
          configurable: true,
          get: () => ({
            registerTool(tool) {
              window.__tools.push({ tool });
              return { unregister() {} };
            },
          }),
        });
      },
    ],
  });
  assert.equal(await legacy.evaluate(() => window.__tools.length), 3);
  await select(legacy, 'pre[data-src-line="26-29"]', 'sample run');
  const result = await legacy.evaluate(() => window.__tools[0].tool.execute({}));
  assert.equal(result.content[0].type, 'text');
  const parsed = JSON.parse(result.content[0].text);
  assert.deepEqual([parsed.selection.startLine, parsed.selection.endLine], [26, 29]);

  const throwing = () =>
    Object.defineProperty(document, 'modelContext', {
      value: {
        registerTool() {
          throw new TypeError('changed API');
        },
      },
    });
  const rejecting = () => Object.defineProperty(document, 'modelContext', { value: { registerTool: () => Promise.reject(new DOMException('duplicate', 'InvalidStateError')) } });
  for (const stub of [throwing, rejecting]) {
    const broken = await openPage(t, { init: [stub] });
    await select(broken, 'p[data-src-line="8-9"]', 'end to end');
    assert.ok((await copied(broken, 'ask')).includes('docs/guide.md:8-9'), 'the toolbar still works');
  }
});

test('dark theme screenshot of the toolbar', async (t) => {
  const page = await openPage(t, { colorScheme: 'dark' });
  await select(page, 'p[data-src-line="8-9"]', 'runs a workflow end to end');
  const background = await page.locator('.dk-toolbar').evaluate((element) => getComputedStyle(element).backgroundColor);
  assert.equal(background, 'rgb(22, 27, 34)', 'the toolbar uses the dark surface color');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'toolbar-dark.png') });
  const light = await openPage(t, { colorScheme: 'light' });
  await select(light, 'p[data-src-line="8-9"]', 'runs a workflow end to end');
  assert.equal(await light.locator('.dk-toolbar').evaluate((element) => getComputedStyle(element).backgroundColor), 'rgb(255, 255, 255)');
});
