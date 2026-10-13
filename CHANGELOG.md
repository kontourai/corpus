# Changelog

## Unreleased — Corpus

- The MCP initialization response's `serverInfo.name` is now `corpus` (previously `docs-kit`), under both CLI bins. In this repository, only the MCP server-identity test keys on that name; production tool lookup uses the unchanged tool names. External clients that explicitly match `serverInfo.name === "docs-kit"` must update that match; arbitrary external consumers have not been audited. Station's shared MCP connection code records the negotiated name as metadata rather than using it to route docs tools.
- The root package is `@kontourai/corpus`, with `corpus` and compatible `docs-kit` bins. Preferred v2 `corpus.json` manifests add required purpose and public-contract building blocks; v1 manifests and bundles remain supported. This repo keeps its own v1 `docs-kit.json` with `docs-kit` product/repo identity until the repository rename and org workflow pin upgrade, then migrates in a follow-up.
- Public store conformance vectors require `MISSING_EVIDENCE` for duplicate IDs, including reuse after retirement. The runner rejects malformed expected entries without `equals` or `length`.

## 0.6.0

Additive: v0.5.0 manifests stay valid, `products.json` is unchanged, and the bundle gains two optional per-document fields.

- **Select text, then ask, challenge, or edit.** Every page now loads `docs-kit.js`, a static template script with no dependencies, and its CSS in `docs-kit.css`. Selecting text in the page content shows a toolbar: **Ask** (Alt+A) and **Challenge** (Alt+C) copy a prompt for your agent with the product, repository, `path:start-end@sha`, section heading, page URL and anchor, and the quoted selection, telling the agent to call the MCP `locate` tool and read the source code. **Open issue** opens a prefilled `issues/new` URL, labelled `docs-challenge`, with the quote in a code fence (so selected `@names` notify no one) and capped at 8,000 characters by truncating the quote. **Edit** opens `edit/<branch>/<path>#L<start>`. Alt+T focuses the toolbar. It has an `aria-live` toast, a selectable-textarea dialog when the clipboard is unavailable, touch placement below the selection, light and dark themes, and no animation under `prefers-reduced-motion`. Selected text is only ever set as text, never as HTML. Pages without content changes now contain this one script tag.
- **Source provenance in the HTML.** `<main>` carries `data-src-path`, `data-src-sha`, `data-repo`, `data-product`, `data-title`, `data-branch`, and `data-selection-primary`. Top-level paragraphs, headings, code blocks, and blockquotes, each item of a top-level list, and each row of a top-level table carry `data-src-line="<start>-<end>"`: 1-based source-file lines, still correct after front matter is stripped. The sanitizer allows exactly `data-src-line`, and docs-kit removes it from a document's raw HTML, so provenance comes only from the build.
- **Manifest fields.** Optional `branch` (a valid git branch name, default `main`) for Edit links, and optional `selectionActions: { "primary": "ask" | "challenge-issue" }` for the leading toolbar action. Both are validated strictly (exit 2).
- **MCP `locate` tool.** `locate {product, quote, source?}` finds a quoted passage in a product's documents, tolerating whitespace, Markdown formatting, and punctuation, and returns the source path, file line range, sha, enclosing heading and anchor, surrounding Markdown, a GitHub blob URL with `#Lstart-Lend`, a `confidence`, and, when the quote is ambiguous, `matchCount` and up to 10 `alternatives`. Text in code is matched as the page shows it.
- **Bundle.** Each document gains `repoPath` (its path from the git top level) and `lineOffset` (front-matter lines stripped), so `locate` reports file lines. Both are optional for readers, and `digest` is unchanged.
- **Optional WebMCP tools.** Where the browser exposes `document.modelContext` (or the older `navigator.modelContext`), the page registers `get_selection_context`, `search_docs`, and `get_topic`, with an `AbortSignal`, and does nothing when the API is absent or fails. WebMCP is a Chromium-only draft.
- **Tests.** `npm run test:browser` drives the toolbar and the WebMCP tools in headless Chromium through `playwright-core` (a dev dependency). It needs a Chromium for playwright-core and is not part of `npm test`.

## 0.5.0

Additive: v0.4.0 manifests stay valid, and the bundle and `products.json` formats are unchanged.

- **Redirect stubs keep the URL fragment.** A meta refresh drops `#fragment`, so `old.html#section` used to land at the top of the new page. Each stub now has a small inline script, before the meta refresh, that calls `location.replace` with the target plus the incoming fragment. A target that has its own `#anchor` keeps it, and the incoming fragment is ignored. The meta refresh, `rel="canonical"`, `noindex`, and the visible link stay, so a browser without JavaScript still redirects (without the fragment). The target is embedded with `JSON.stringify`, with every `<` escaped as `\u003c` and U+2028 and U+2029 as `\u2028` and `\u2029`, so no target can close the script element. Stubs are no longer script-free; a site with a Content Security Policy that forbids inline script falls back to the meta refresh.
- **Generated-site check covers the stub script.** `build` fails (exit 1) when a redirect stub lacks exactly one redirect script, or when the script's target is missing or differs from the meta refresh URL.

## 0.4.0

Additive for manifests: v0.3.0 manifests stay valid. A new gate can fail a repository that passed before, and the bundle gains documents that have no page.

- **Bundle-only documents.** A `documents[]` entry accepts `"publish": false` (a boolean). The document gets no page, navigation entry, or landing card, but stays in `docs-bundle.json`, so the MCP server serves it and topics may point at it. Its bundle `url` is the GitHub blob URL at the built sha, and its `markdown`, and topic Markdown taken from it, has relative links made absolute: published targets go to their page URL, images and other embedded files (`src`, `srcset`, `poster`) to `raw.githubusercontent.com`, anything else to its GitHub blob page. Published pages that link to it get the blob URL. Every `check` gate still applies to it, and reachability counts it as listed. A redirect to it fails the `redirects` gate. The bundle `digest` is computed over the Markdown as written, so it still ignores the sha and base URL.
- **`paths` gate.** `check` (and therefore `build`) fails with exit 1 on absolute home-directory paths (`/Users/<name>/`, `/home/<name>/`, `C:\Users\<name>\`) anywhere in the landing page or a listed document, bundle-only ones included, and reports each as `file:line`. `/Users/Shared/` and `/home/runner/` are not personal and are exempt. The optional top-level `allowLocalPaths` lists exact document paths to skip; a glob, a path that is not a document, or a repeat is a manifest error (exit 2).
- **Topic error wording.** A topic whose source is not listed now says "is not listed" rather than "is not published", since a bundle-only document is a valid topic source.

## 0.3.0

Additive: v0.2.0 manifests stay valid, and the bundle and `products.json` formats are unchanged.

- **Redirects.** An optional top-level `redirects` object in `docs-kit.json` maps old site-relative `.html` paths to a published source (`path` or `path#anchor`) or an absolute `https://` URL. `build` writes a stub at each old path with an immediate meta refresh, `rel="canonical"`, `noindex`, a visible link, and no script, using relative URLs from the stub's own directory. Stubs are listed in `.docs-kit-build`, and the generated-site check verifies their links and refresh URLs. Because GitHub Pages serves `x.html` for `/x`, a key also covers the extensionless URL. `docs-bundle.json` does not change.
- **`redirects` gate.** `check` fails (exit 1) when a redirect target is missing or unpublished, its anchor does not resolve, or a key repeats or collides with a page or file docs-kit generates. Malformed keys and values are manifest errors (exit 2). `build` also refuses a stub that would overwrite a copied asset. Keys are compared after Unicode NFC normalization and case folding, and an `https://` target is written in its parsed, normalized form.

## 0.2.0

Improvements from the first adoptions. Every change is additive: v0.1.0 manifests stay valid, and the bundle and `products.json` formats are unchanged.

- **Mermaid diagrams.** A fenced ` ```mermaid ` block now renders as `<pre class="mermaid">` instead of a code block. Pages that contain one load Mermaid 12.1.0 from jsDelivr with an SRI `integrity` hash and `crossorigin="anonymous"`, using `securityLevel: 'strict'` and a theme that follows `prefers-color-scheme`. Pages without one load no script. A `script` written in Markdown is still stripped, and `docs-bundle.json` keeps the Markdown as written.
- **Document title override.** A `documents[]` entry in `docs-kit.json` accepts an optional `title`, a non-empty string. It replaces the H1-derived title in the navigation, landing cards, the page `<title>`, and `docs-bundle.json` (so it changes the bundle `digest`).
- **Raw-HTML titles.** A document without a Markdown H1 takes its title from the first raw-HTML `<h1>` that has text, before falling back to the file name.
- **YAML front matter.** A leading `---` block closed by `---` or `...` within the first 2000 lines, holding at least one top-level `key:` line, is stripped before link and anchor checks, rendering, topics, and the bundle `markdown`, so Jekyll-era docs no longer render an `<hr>` and a stray heading. Check failures keep source-file line numbers. A simple `title:` in the front matter is used when the document has no Markdown or raw-HTML H1. An unclosed block, or one with no key line (a thematic break followed by prose and another `---`), is left as written. A leading UTF-8 BOM is dropped, so it no longer hides front matter or a first-line heading.
- **Landing page `<title>`.** It is now `<title> — <tagline>` when a tagline is set, and still `<title> documentation` otherwise.
- **Docs.** The README now says what the topics gate enforces: a topic anchor must be a heading outside blockquotes and lists, at any level.

## 0.1.0

First release: `check`, `build`, `mcp`, `hub`, and `init`.
