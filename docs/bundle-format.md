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
    { "source": "docs/getting-started.md", "section": "Start Here", "title": "Getting started", "url": "https://kontourai.github.io/flow/docs/getting-started.html", "markdown": "# Getting started\n..." }
  ],
  "topics": [
    { "id": "workflows", "title": "Workflows", "source": "docs/concepts.md#workflows", "url": "https://kontourai.github.io/flow/docs/concepts.html#workflows", "markdown": "## Workflows\n..." }
  ]
}
```

- `documents` follow manifest order. A document's `title` is its first top-level H1. If it has none, the title is the file name without `.md`. `markdown` is the source file, unmodified.
- Each document's `url` is the page `build` generates: the source path with `.md` replaced by `.html`, under `siteUrl`.
- A topic's `markdown` is a heading section: it runs from the anchor heading up to the next top-level heading of the same or a higher level. Deeper headings stay in the section. A topic without an anchor gets the whole document.
- `tagline` is `""` when the manifest omits it.
- `digest` is the SHA-256 (hex) of `JSON.stringify({documents, topics})`. Documents are reduced to `{source, section, title, markdown}` and topics to `{id, title, source, markdown}`, in manifest order. URLs, `sha`, and `builtAt` are left out, so the digest identifies the content alone.
- The landing page is not a bundle document. Point a topic at a landing-page heading, as in `"README.md#install"`, to give agents its content.

`mcp --repo` and `mcp --workspace` build the same object in memory. Outside a git checkout, their `sha` is `null`.

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
