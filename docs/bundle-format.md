# Bundle and products.json formats

Two JSON files connect product sites to the hub and to the MCP server. `corpus build` writes `docs-bundle.json` next to each product site. The hub repository maintains `products.json`.

## docs-bundle.json

Schema v2 adds `purpose` and `builtOn` from the manifest. The MCP reader and hub accept both v1 and v2 bundles; v1 has no purpose metadata. A v1 manifest still builds a v1 bundle. `list_products` includes both new fields for v2 bundles. `via` is a string or a non-empty array of package/CLI strings grouped under a declared product id. Package-to-product ownership and product ids are not verified offline. A building block may include `"evidence": "cli"`; the manifest check verifies its `via` command in package scripts or workflow run steps and keeps the reason in `for`. An optional bare `bin` string names a CLI executable differing from the `via` package name; it is invocation evidence, not verified package-to-bin ownership. This metadata is preserved in the bundle and accepted by MCP readers. Other evidence values are configuration errors.

The content digest algorithm remains unchanged; it identifies document content, not product metadata.

```json
{
  "schemaVersion": 2,
  "purpose": "Make process and execution state visible to users.",
  "builtOn": [],
  "product": "flow",
  "title": "Flow",
  "tagline": "Process transparency for agentic work",
  "repo": "kontourai/flow",
  "sha": "<git rev-parse HEAD at build time>",
  "builtAt": "2026-10-10T12:00:00.000Z",
  "siteUrl": "https://kontourai.github.io/flow/",
  "digest": "<sha256 hex>",
  "documents": [
    { "source": "README.md", "section": null, "title": "Flow", "landing": true, "url": "https://kontourai.github.io/flow/index.html", "repoPath": "README.md", "lineOffset": 0, "markdown": "# Flow\n..." },
    { "source": "docs/getting-started.md", "section": "Start Here", "title": "Getting started", "landing": false, "url": "https://kontourai.github.io/flow/docs/getting-started.html", "repoPath": "docs/getting-started.md", "lineOffset": 4, "markdown": "# Getting started\n..." }
  ],
  "topics": [
    { "id": "workflows", "title": "Workflows", "source": "docs/concepts.md#workflows", "url": "https://kontourai.github.io/flow/docs/concepts.html#workflows", "markdown": "## Workflows\n..." }
  ]
}
```

- `documents[0]` is the landing page, with `landing: true` and `section: null`. The listed documents follow in manifest order, with `landing: false`. A document's `title` is the `title` set on its `documents` entry in `corpus.json`, if any. Otherwise it is its first Markdown H1 outside blockquotes and lists, then the text of the first raw-HTML `<h1>` that has text, then a simple front-matter `title:`, then the file name without `.md`. `markdown` is the source file as written, minus a leading YAML front-matter block.
- Each document's `url` is the page `build` generates: `index.html` for the landing page, otherwise the source path with `.md` replaced by `.html`, under `siteUrl`. A [bundle-only document](../README.md#bundle-only-documents) (`"publish": false`) has no page, so its `url` is `https://github.com/<repo>/blob/<sha>/<path>` (`HEAD` in place of `<sha>` when `mcp` serves a directory outside git), and its `markdown` has relative links made absolute (images and other embedded files to `https://raw.githubusercontent.com/<repo>/<sha>/<path>`), as are topics taken from it. Published documents keep their Markdown as written. Redirect stubs from the manifest's `redirects` are not listed; the bundle has no field for them.
- `repoPath` and `lineOffset` (since 0.6.0) say where `markdown` sits in the repository: `repoPath` is the source path from the git top level (it differs from `source` only when `--root` is a subdirectory), and `lineOffset` is the number of front-matter lines stripped before `markdown`'s first line, so line N of `markdown` is line N + `lineOffset` of the file. The MCP [`locate`](../README.md#mcp-server) tool uses them for file line numbers and GitHub links. Both are optional for readers: a bundle built before 0.6.0 has neither, and `locate` then assumes no front matter and says so. Neither is part of `digest`.
- A topic's `markdown` is a heading section: it runs from the anchor heading up to the next top-level heading of the same or a higher level. Deeper headings stay in the section. A topic without an anchor gets the whole document.
- `tagline` is `""` when the manifest omits it.
- `digest` is the SHA-256 (hex) of `JSON.stringify({documents, topics})`. Documents are reduced to `{source, section, title, landing, markdown}` and topics to `{id, title, source, markdown}`, in manifest order, with `markdown` as written (before bundle-only link rewriting, which embeds the sha and site URL). URLs, `sha`, and `builtAt` are left out, so the digest identifies the content alone.
- The hub's `thin` state and the MCP `docCount` count only documents with `landing: false`.

`mcp --repo` and `mcp --workspace` build the same object in memory on every tool call. Outside a git checkout, their `sha` is `null`. They add `dirty: true` when the working tree has uncommitted changes. The MCP server validates every bundle down to each document and topic; a malformed one is reported as unavailable.

## products.json

The hub's product list, validated strictly. An unknown key is refused, and each `product` must equal the repository name in its `repo`:

```json
{
  "schemaVersion": 1,
  "products": [
    { "product": "flow", "repo": "kontourai/flow" }
  ]
}
```

`corpus hub` copies it next to `index.html`. `corpus mcp --hub <url>` reads `<url>/products.json` and then `<url>/<product>/docs-bundle.json` for each product.
