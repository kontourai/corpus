# Changelog

## 0.2.0

Improvements from the first adoptions. Every change is additive: v0.1.0 manifests stay valid, and the bundle and `products.json` formats are unchanged.

- **Mermaid diagrams.** A fenced ` ```mermaid ` block now renders as `<pre class="mermaid">` instead of a code block. Pages that contain one load Mermaid 12.1.0 from jsDelivr with an SRI `integrity` hash and `crossorigin="anonymous"`, using `securityLevel: 'strict'` and a theme that follows `prefers-color-scheme`. Pages without one load no script. A `script` written in Markdown is still stripped, and `docs-bundle.json` keeps the Markdown as written.
- **Document title override.** A `documents[]` entry in `docs-kit.json` accepts an optional `title`, a non-empty string. It replaces the H1-derived title in the navigation, landing cards, the page `<title>`, and `docs-bundle.json` (so it changes the bundle `digest`).
- **Raw-HTML titles.** A document without a Markdown H1 takes its title from the first raw-HTML `<h1>` that has text, before falling back to the file name.
- **YAML front matter.** A leading `---` block closed by `---` or `...` within the first 200 lines is stripped before link and anchor checks, rendering, topics, and the bundle `markdown`, so Jekyll-era docs no longer render an `<hr>` and a stray heading. Check failures keep source-file line numbers. A simple `title:` in the front matter is used when the document has no Markdown or raw-HTML H1. An unclosed block is left as written.
- **Landing page `<title>`.** It is now `<title> — <tagline>` when a tagline is set, and still `<title> documentation` otherwise.
- **Docs.** The README now says what the topics gate enforces: a topic anchor must be a heading outside blockquotes and lists, at any level.

## 0.1.0

First release: `check`, `build`, `mcp`, `hub`, and `init`.
