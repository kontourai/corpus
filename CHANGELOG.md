# Changelog

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
