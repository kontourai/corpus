# Bundle and products.json formats

Two JSON files connect product sites to the hub and to the MCP server. `docs-kit build` writes `docs-bundle.json` next to each product site. The hub repository maintains `products.json`.

## docs-bundle.json

```json
{
  "schemaVersion": 1,
  "product": "flow",
  "title": "Flow",
  "tagline": "Process transparency for agentic work",
  "repo": "kontourai/flow",
  "sha": "<git rev-parse HEAD at build time>",
  "builtAt": "2026-10-10T12:00:00.000Z",
  "siteUrl": "https://kontourai.github.io/flow/",
  "digest": "<sha256 hex>",
  "documents": [
    { "source": "README.md", "section": null, "title": "Flow", "landing": true, "url": "https://kontourai.github.io/flow/index.html", "markdown": "# Flow\n..." },
    { "source": "docs/getting-started.md", "section": "Start Here", "title": "Getting started", "landing": false, "url": "https://kontourai.github.io/flow/docs/getting-started.html", "markdown": "# Getting started\n..." }
  ],
  "topics": [
    { "id": "workflows", "title": "Workflows", "source": "docs/concepts.md#workflows", "url": "https://kontourai.github.io/flow/docs/concepts.html#workflows", "markdown": "## Workflows\n..." }
  ]
}
```

- `documents[0]` is the landing page, with `landing: true` and `section: null`. The listed documents follow in manifest order, with `landing: false`. A document's `title` is the `title` set on its `documents` entry in `docs-kit.json`, if any. Otherwise it is its first Markdown H1 outside blockquotes and lists, then the text of the first raw-HTML `<h1>` that has text, then the file name without `.md`. `markdown` is the source file, unmodified.
- Each document's `url` is the page `build` generates: `index.html` for the landing page, otherwise the source path with `.md` replaced by `.html`, under `siteUrl`.
- A topic's `markdown` is a heading section: it runs from the anchor heading up to the next top-level heading of the same or a higher level. Deeper headings stay in the section. A topic without an anchor gets the whole document.
- `tagline` is `""` when the manifest omits it.
- `digest` is the SHA-256 (hex) of `JSON.stringify({documents, topics})`. Documents are reduced to `{source, section, title, landing, markdown}` and topics to `{id, title, source, markdown}`, in manifest order. URLs, `sha`, and `builtAt` are left out, so the digest identifies the content alone.
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

`docs-kit hub` copies it next to `index.html`. `docs-kit mcp --hub <url>` reads `<url>/products.json` and then `<url>/<product>/docs-bundle.json` for each product.
