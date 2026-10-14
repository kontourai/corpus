# What the generated site contains

`corpus build --out dist-pages` replaces the output directory with a static site that GitHub Pages can serve as is.

## Pages

| Output | From |
| --- | --- |
| `index.html` | the `landing` Markdown, followed by cards for every document, grouped by section |
| `<source>.html` | each listed document except bundle-only ones (`"publish": false`), at its source path with `.md` replaced by `.html` (`docs/guide.md` becomes `docs/guide.html`) |
| `docs-kit.css` | the shared stylesheet, with light and dark themes that follow `prefers-color-scheme` |
| `docs-kit.js` | the [selection toolbar](#selection-toolbar) and optional WebMCP tools, loaded by every page |
| images and media | every local image, and every file embedded with `src`, `srcset`, or `poster`, that a published page references, copied to its repository path; only git-tracked files up to 25 MB, never `.git/` |
| `<key>` from `redirects` | a stub that redirects to the new page or URL, keeping an incoming `#fragment` unless the target has its own anchor (an inline script, with a meta refresh as the no-JS fallback), with `rel="canonical"`, `noindex`, and a visible link; see [Redirects](../README.md#redirects) |
| `.nojekyll` | turns off Jekyll processing on GitHub Pages |
| `.docs-kit-build` | JSON list of every file the build wrote; the next `build` replaces the directory only if it holds exactly those files (a forged marker is trusted) |
| `docs-bundle.json` | the agent bundle; see [the bundle format](bundle-format.md#docs-bundlejson) |

The landing page's `<title>` is `<title> — <tagline>`, or `<title> documentation` without a tagline. Each document page's `<title>` is `<document title> · <title>`. Every page has the product title and tagline, navigation grouped by `section` in manifest order, a link to the hub, a link to the repository, and the source file at the built commit. Headings get GitHub-compatible `id`s, so anchors that work on GitHub also work on the site.

## Link rewriting

| Link in Markdown | On the site |
| --- | --- |
| a published document (`concepts.md#workflows`) | the generated page (`concepts.html#workflows`) |
| the landing page (`../README.md`) | `index.html` |
| a local image | the copied image |
| a bundle-only document (`"publish": false`), or any other repository file or directory | `https://github.com/<repo>/blob/<sha>/<path>`, or `tree` for directories |
| `http(s):` and `mailto:` | unchanged |
| other schemes, such as `javascript:` | `#` |

The same rewriting applies to `href`, `src`, `srcset`, and `poster` attributes in raw HTML, in any quoting style. Raw HTML is tokenized with htmlparser2, so comments and quoting follow the HTML tokenizer, and `srcset` is parsed per the HTML spec. References to untracked, ignored, or `.git/` files fail `check` and `build`. `check` and `build` use one shared extractor for them.

## Sanitization

Every product site shares the `https://kontourai.github.io` origin, so a script in one product's docs could act on every other product's pages. The rendered Markdown is passed through `sanitize-html` with a GitHub-like allowlist. `script`, `style`, `iframe`, and `on*` attributes are removed, and URLs are limited to `http(s)`, `mailto`, and `data:` images. Heading `id`s, anchor links, images, tables, `details`/`summary` (including `open`), `video`/`source` with their media attributes, and task-list checkboxes are kept.

## Source provenance

Every page's `<main>` names its source once: `data-src-path` (the path from the git top level), `data-src-sha` (the built commit), and `data-repo`, plus `data-product`, `data-title`, `data-branch`, and `data-selection-primary` for the toolbar. Rendered blocks carry `data-src-line="<start>-<end>"`, the 1-based lines of the source file, counted after front matter is stripped so they still match the file:

- each top-level paragraph, heading, code block (Mermaid included), and blockquote;
- each item of a top-level list;
- each row of a top-level table (the header row, then one line per body row).

Blocks nested inside a list item or a blockquote are covered by their annotated ancestor. Raw HTML blocks have no line attribute. The sanitizer keeps exactly one `data-*` name, `data-src-line`, on `p`, `h1`-`h6`, `li`, `tr`, `pre`, and `blockquote`, and corpus removes any `data-src-line` written in a document's raw HTML before rendering, so provenance only ever comes from the build.

## Selection toolbar

Selecting text inside `<main>` shows a small toolbar next to the selection (below it on touch screens, clear of the browser's own menu). It resolves the selection to the source path, the line range spanning every annotated block it touches, the commit sha, and the nearest heading at or before it with its anchor. Then:

| Button | Action |
| --- | --- |
| **Ask** (Alt+A) | Copies a prompt for your agent: the product and repository, `path:start-end@sha`, the section heading, the page URL with the heading anchor, the quoted selection, an instruction to call the kontour-docs MCP [`locate`](../README.md#mcp-server) tool and to read the source code before answering, and a `Question: ` slot. A `role="status"` `aria-live` toast confirms the copy. |
| **Challenge** (Alt+C) | Copies a prompt with the same provenance that asks the agent to verify the passage against the implementation at the built sha and on current main, and to propose a doc fix, or a code fix when the doc describes intended behaviour. |
| **Open issue** | Opens `https://github.com/<repo>/issues/new` prefilled with a title naming the path and lines, the challenge text, the quote, and the provenance, with `labels=docs-challenge` (GitHub applies a label only for users who may triage). The quote is a fenced code block, so `@names` and `#123` in the selection do not notify anyone or link issues. It is cut with an ellipsis so the whole URL stays within 8,000 characters. |
| **Edit** | Opens `https://github.com/<repo>/edit/<branch>/<path>#L<start>`, with `branch` from the manifest. GitHub's editor may not scroll to `#L<start>`, and it opens the branch head, whose lines can differ from the built sha the toolbar's line numbers refer to. |

`selectionActions.primary` in `corpus.json` chooses which action leads the toolbar and is highlighted: `ask` (the default) or `challenge-issue`. Alt+T moves focus to the toolbar, the arrow keys, Home, and End move between its buttons, and Escape closes it. Animations are off under `prefers-reduced-motion`, and the colors follow the light and dark themes.

The page never calls a model and has no backend: it hands the prompt to your agent through the clipboard, or to GitHub through a URL. Where the clipboard API is missing or refused, the prompt appears in a dialog in a selected, read-only textarea for you to copy. Selected text reaches the page only as `textContent` or a textarea value, never as HTML. The script is template output written by `build`, not document content; Markdown still cannot add scripts.

## WebMCP tools

When the browser exposes [WebMCP](https://webmachinelearning.github.io/webmcp/) (`document.modelContext`, or the older `navigator.modelContext`), `docs-kit.js` also registers three read-only tools for an in-browser agent:

| Tool | Input | Returns |
| --- | --- | --- |
| `get_selection_context` | none | the current selection with the provenance above, or `selection: null` and the page's path, sha, and URL |
| `search_docs` | `query`, `limit?` (1-50, default 10) | ranked matches over this product's `docs-bundle.json`, fetched from the same origin |
| `get_topic` | `id` | one topic from the bundle, as Markdown |

WebMCP is a draft from the W3C Web Machine Learning Community Group, implemented only in Chromium (behind a flag or an origin trial), and its API is still changing; see the [explainer and spec](https://github.com/webmachinelearning/webmcp). corpus feature-detects it and registers each tool inside `try`/`catch`. It passes an `AbortSignal` (aborted on `pagehide`) for the current draft, whose `registerTool` returns a Promise, and it handles the older synchronous `registerTool` that returned an object with `unregister()`, answering that API in MCP `content` form. Any failure leaves the page working, with no tools.

## Mermaid diagrams

A fenced code block whose info string starts with `mermaid` renders as `<pre class="mermaid">` holding the escaped diagram source, not as a code block. A page with at least one such block loads Mermaid from `https://cdn.jsdelivr.net/npm/mermaid@<version>/dist/mermaid.min.js`, pinned to an exact version with an SRI `integrity` hash and `crossorigin="anonymous"`, and calls `mermaid.initialize` with `startOnLoad: true`, `securityLevel: 'strict'`, and the `dark` or `default` theme, chosen from `prefers-color-scheme` when the page loads. Pages without a mermaid block load no script. The script is part of the page template, not of the document content, so a `script` written in Markdown is still removed. `docs-bundle.json` keeps the Markdown as written.

## Generated-site check

After rendering, `build` scans every generated `href`, `src`, and `srcset` with the same extractor, plus the meta-refresh URL of each redirect stub, and fails if an internal target or `#fragment` is missing. `check` already validates the sources, so this catches what rendering changes. For example, a `name` anchor on a non-`<a>` element passes `check`, but the sanitizer removes it, so links to it break on the site.
