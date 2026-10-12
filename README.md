# docs-kit

**Docs gate, GitHub Pages site, and docs MCP server for Kontour products.**

[![CI](https://github.com/kontourai/docs-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/kontourai/docs-kit/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-kontourai.github.io-blue)](https://kontourai.github.io/docs-kit/)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

[Documentation](https://kontourai.github.io/docs-kit/) · [Docs hub](https://kontourai.github.io/)

`@kontourai/docs-kit` gives every Kontour product the same three things from one manifest:

- **A docs gate for CI.** `docs-kit check` validates links, anchors, reachability, topics, redirects, local paths, and (on pull requests) freshness.
- **A GitHub Pages site.** `docs-kit build` renders `https://kontourai.github.io/<repo>/` and checks every link it generated.
- **A docs bundle for agents.** `build` also writes `docs-bundle.json`, and `docs-kit mcp` serves every product's bundle from one MCP server.

It is plain ESM JavaScript for Node 22 or newer, with no build step. Run it straight from git, pinned to a commit:

```sh
npx -y github:kontourai/docs-kit#<sha> docs-kit check
```

## Contents

- [Manifest reference](#manifest-reference)
- [CLI reference](#cli-reference)
- [MCP server](#mcp-server)
- [Adopting docs-kit in a repo](#adopting-docs-kit-in-a-repo)
- [Bundle and products.json formats](docs/bundle-format.md)
- [What the generated site contains](docs/site-output.md)
- [Known limits](#known-limits)
- [Contributing](AGENTS.md)

## Manifest reference

Each repository has a `docs-kit.json` at its root:

```json
{
  "schemaVersion": 1,
  "product": "flow",
  "title": "Flow",
  "tagline": "Process transparency for agentic work",
  "repo": "kontourai/flow",
  "landing": "README.md",
  "documents": [
    { "source": "docs/getting-started.md", "section": "Start Here", "covers": ["src/cli/**"] }
  ],
  "topics": [
    { "id": "workflows", "title": "Workflows", "source": "docs/concepts.md#workflows" }
  ],
  "exclude": ["docs/plans/**"],
  "branch": "main",
  "selectionActions": { "primary": "ask" },
  "redirects": {
    "gates-and-route-back.html": "docs/gates.md#route-back",
    "releasing.html": "https://example.com/releasing"
  },
  "allowLocalPaths": ["docs/install-paths.md"]
}
```

| Key | Required | Meaning |
| --- | --- | --- |
| `schemaVersion` | yes | Exactly `1`. |
| `product` | yes | Lowercase slug. It must equal the repository name in `repo`, because the site lives at `https://kontourai.github.io/<product>/` and the hub fetches `/<product>/docs-bundle.json`. |
| `title` | yes | Display name. |
| `tagline` | no | One line shown in the site header and on the hub. |
| `repo` | yes | `owner/name` on GitHub. |
| `landing` | no | Markdown rendered as the site's `index.html`. Default `README.md`. |
| `documents` | yes | Documents, in navigation order. Each entry has `source` (a `.md` path), `section` (the navigation group) and, optionally, `title`, `covers`, and `publish`. See [Bundle-only documents](#bundle-only-documents). |
| `topics` | no | Curated entry points for agents. Each has `id` (a lowercase slug), `title`, and `source`, which is either `path` or `path#anchor`. |
| `exclude` | no | Globs for `docs/**/*.md` files that are deliberately unpublished. |
| `redirects` | no | Old page URLs that moved, mapped to their new place. Each key is a site-relative `.html` path; each value is a published source (`path` or `path#anchor`) or an absolute `https://` URL. See [Redirects](#redirects). |
| `branch` | no | The default branch, for the site's **Edit** links (`https://github.com/<repo>/edit/<branch>/<path>`). Default `main`. It must be a valid git branch name (no whitespace, `..`, `~^:?*[\\`, leading `-` or `/`, or `.lock` component). |
| `selectionActions` | no | The [selection toolbar](docs/site-output.md#selection-toolbar). Its only key, `primary` (required in the object), is `"ask"` (the default) or `"challenge-issue"`: the action that leads the toolbar. |
| `allowLocalPaths` | no | Exact paths of documents (the landing page or `documents` sources) that may contain absolute home-directory paths, such as deliberate examples. The [paths gate](#check) skips them. No globs. |

The validation rules:

- Validation is strict. An unknown key at any level is refused.
- Every path is repository-relative, POSIX, and normalized. Absolute paths, `..` segments, and symlinks that resolve outside the repository are refused. Every source must exist.
- Documents are listed once. They may not repeat the landing page, and they may not match `exclude`.
- A document's title is its first Markdown H1 outside blockquotes and lists, else the text of the first raw-HTML `<h1>` that has text, else a front-matter `title`, else the file name without `.md`. A `title` on the `documents` entry overrides all of them in the navigation, the page `<title>`, and `docs-bundle.json`; it must be a non-empty string without leading or trailing whitespace.
- A topic `source` must point at the landing page or at a listed document, so it is published. Its `#anchor` must be a heading outside blockquotes and lists (any level, `#` through `######`), slugged by [github-slugger](https://github.com/Flet/github-slugger): lowercase, punctuation dropped, spaces become `-`, and repeated headings get `-1`, `-2`, and so on.
- A leading YAML front-matter block is stripped before checking, rendering, and bundling, and check failures still report the source file's line numbers. A block is front matter when line 1 is `---` (after a UTF-8 BOM, which is always dropped), a `---` or `...` line closes it within the first 2000 lines, and it holds at least one top-level key line (`key:` at column 0). Otherwise, such as a thematic break followed by prose and another `---`, the document is left as written. Only a simple `title: value` (optionally quoted) is read from it; there is no YAML parser.
- `publish`, when present, must be a boolean. It defaults to `true`.
- Each `allowLocalPaths` entry must be a normalized repository path that is exactly the landing page or a `documents` source, listed once. A glob, or any other path, is a manifest error.
- `covers` holds globs of the code a document describes; the [freshness gate](#check) uses them. A bare directory name such as `src/cli` means `src/cli/**`. A glob that matches no tracked file (`git ls-files`; every file outside git) fails the `covers` gate of `check`, because it could never mark its document stale. It does not block `build` or the MCP server.

Section names group the navigation in the order they first appear in `documents`.

### Bundle-only documents

A `documents` entry with `"publish": false` is an agent-facing document that is not published as a web page, such as an internal manual. It is still a document in every other way:

- `build` renders no page for it, and it is left out of the navigation and the landing cards. It is still in `docs-bundle.json`, so the MCP server serves it, and topics may point at it.
- Its bundle `url` is `https://github.com/<repo>/blob/<sha>/<path>` at the built commit.
- Its bundle `markdown` has every relative link made absolute, so the text stands alone for an MCP reader: a link to a published document becomes the page URL under `--base-url`, a link to anything else becomes its GitHub `blob` URL (`tree` for directories), an image or other embedded file (Markdown image, raw-HTML `src`, `srcset`, or `poster`) becomes `https://raw.githubusercontent.com/<repo>/<sha>/<path>` so it resolves to the file itself, and a `#fragment` alone gets the document's own blob URL. This covers Markdown links, images, reference definitions, and raw-HTML `href`, `src`, `srcset`, and `poster`. Code blocks and code spans are left as written. Topics taken from the document get the same rewritten Markdown, and their `url` is the blob URL plus `#anchor`.
- `check` runs every gate on it: links, anchors, topics, covers, freshness, and paths. Reachability counts it as listed.
- A published page that links to it gets its GitHub blob URL, as for any other repository file.
- A redirect cannot target it, because it has no page; that fails the `redirects` gate.

### Redirects

GitHub Pages cannot send HTTP redirects, so when a page URL changes (for example `/flow/gates-and-route-back.html` became `/flow/docs/gates-and-route-back.html` when a product moved to docs-kit), list the old path under `redirects` and `build` writes a stub page there. The stub refreshes to the target at once (`<meta http-equiv="refresh" content="0; url=...">`), names it with `<link rel="canonical">`, asks search engines not to index it (`<meta name="robots" content="noindex">`), and shows a plain link to it.

A meta refresh drops the URL fragment, so the stub also carries a small inline script, placed before the meta refresh, that redirects with `location.replace` and keeps the fragment: `old.html#section` lands on the target's `#section`. When the target names its own anchor (`docs/gates.md#route-back`), that anchor wins and the incoming fragment is dropped, because the manifest chose it and the old page's fragment may not exist on the new page. An incoming fragment applies only to a target without one, for source and `https://` targets alike. Without JavaScript, the meta refresh still redirects, without the fragment. The script is template output, not document content: the target is embedded as a JSON string with every `<`, U+2028, and U+2029 escaped, so it cannot close the script element.

- A key is the old page's path relative to the site root, such as `gates-and-route-back.html` or `adr/0001-x.html`. It must end in `.html` and must not start with `/` or contain `..`, `#`, or `?`.
- GitHub Pages serves `x.html` for a request to `/x`, so a key `x.html` also redirects the extensionless URL `/x`.
- A value is either a source path, optionally with `#anchor` (`docs/gates.md`, `docs/gates.md#route-back`), or an absolute `https://` URL, which the stub uses in its parsed, normalized form (`new URL(value).href`). A source must be the landing page or a listed document that is published (not `"publish": false`), and its `#anchor` follows the rules of the [links gate](#check): a heading slug, or an `id` or `name` in raw HTML.
- A source target becomes a relative URL from the stub's own directory, so `adr/0001-x.html` pointing at `docs/gates.md` refreshes to `../docs/gates.html`. Its canonical URL is absolute, under `--base-url`.
- A key must not be a page docs-kit generates (`index.html` or a document's `.html`), compared after Unicode NFC normalization and case folding, and must not need a directory where docs-kit writes a file, or the reverse. A key may appear only once in the file. A stub that would overwrite a copied image or media file fails `build` with exit `1`, because assets are known only after rendering.
- Malformed keys or values are manifest errors (exit `2`). A target that is missing, unpublished, or has an unresolved anchor, and a colliding or repeated key, fail the `redirects` gate (exit `1`).
- Redirects are not part of `docs-bundle.json`.

## CLI reference

```text
docs-kit <check|build|mcp|hub|init> [options]
```

Exit codes: `0` ok, `1` a gate failed, `2` a usage or configuration error. An invalid `docs-kit.json` is a configuration error (`2`), and so is a git error.

### check

```sh
docs-kit check [--root dir] [--base <git-ref>] [--advisory]
```

`check` runs the gates below and reports every failure, not only the first.

1. **manifest:** `docs-kit.json` is valid, as described above. If it is invalid, the other gates are skipped and the exit code is `2`.
2. **links:** every Markdown link and image, and every raw-HTML `href`, `src`, `srcset`, and `poster` (double-quoted, single-quoted, or unquoted), in the landing page and the listed documents (bundle-only ones included) resolves. A reference to a file under `.git/`, through a symlink, or to an untracked or git-ignored file (such as `.env`), is an unpublishable reference and fails. Raw HTML is tokenized with htmlparser2, so HTML comments are ignored, an empty raw `href=""` is allowed, and `srcset` is parsed per the HTML spec, so `data:` URIs stay whole. Relative files must exist, with exact case. A `#anchor` must match a heading slug, or an `id` or `name` attribute in raw HTML, in the target `.md`. External `http(s)` links are not fetched. A leading `/` resolves from `--root` (which is the repository root unless you point `--root` at a subdirectory).
3. **reachability:** every `docs/**/*.md` is listed in `documents` (with or without `"publish": false`), is the landing page, or is matched by `exclude`.
4. **topics:** every topic anchor resolves to a heading outside blockquotes and lists.
5. **redirects:** every [redirect](#redirects) target is published and its `#anchor` resolves, and no key repeats or collides with a file docs-kit generates.
6. **paths:** no absolute home-directory path appears in the landing page or any listed document, bundle-only ones included: `/Users/<name>/`, `/home/<name>/`, or `C:\Users\<name>\` (any drive letter, either slash). The whole Markdown body is scanned as text, so prose, code, links, and raw HTML all count; front matter is not, because it is never published. Each hit is reported as `file:line`. A path inside a URL such as `https://host/home/x/` does not match, and neither does a placeholder name such as `<name>`, `$USER`, or `{user}`. Two non-personal directories are exempt: `/Users/Shared/` (the macOS shared folder) and `/home/runner/` (the GitHub Actions runner home). List a document in `allowLocalPaths` when it needs real example paths.
7. **covers:** every `covers` glob matches at least one tracked file. This gate fails with exit `1`.
8. **freshness:** this gate runs only with `--base`. It reads the changed files from `git diff --name-only --no-renames <base>...HEAD`, which diffs from the merge base and lists both paths of a renamed file. If a document's `covers` globs match a changed file, the document's own `source` must also be in the changed set. Otherwise the document is stale. With `--advisory`, stale documents are printed as warnings and the exit code is `0`. A base that does not resolve, or a directory that is not a git checkout, gives exit `2`, never a silent pass.

### build

```sh
docs-kit build [--root dir] [--out dist-pages] [--base-url https://kontourai.github.io/<product>/]
```

`build` runs `check` without the covers and freshness gates and refuses to build if it fails. It then replaces `--out` with:

- `index.html` (the landing page), one page per published document (not [bundle-only](#bundle-only-documents) ones), and `docs-kit.css`. Every page has navigation grouped by section, a link to the hub at <https://kontourai.github.io/>, and a link to the repository. The landing page's `<title>` is `<title> — <tagline>`, or `<title> documentation` when there is no tagline.
- Links between published documents, rewritten to the generated pages, in Markdown and in raw HTML (`href`, `src`, `srcset`). Links to other repository files go to `https://github.com/<repo>/blob/<sha>/<path>`, or to `tree` for directories.
- Copies of the local images and embedded media (`src`, `srcset`, `poster`) that published documents reference. Inside git, only git-tracked files are copied, never anything under `.git/` or through a symlink, and each file is capped at 25 MB; a larger tracked file keeps its GitHub link. Assets are collected after sanitization, so a file referenced only by a stripped tag (`iframe`, `embed`, `script`, ...) is never copied.
- A selection toolbar on every page (`docs-kit.js`, a static template script): select text in the page content to copy an **Ask** or **Challenge** prompt for your agent with the source path, line range, and sha, open a prefilled GitHub issue, or open the source in GitHub's editor. Rendered blocks carry `data-src-line` with their source-file lines, and `<main>` carries the page's path, sha, and repository. Where the browser offers [WebMCP](docs/site-output.md#webmcp-tools), the script also registers in-page tools. See [the generated site](docs/site-output.md#selection-toolbar).
- Sanitized HTML. Every product site shares the `kontourai.github.io` origin, so rendered Markdown is reduced to GitHub-like output: no `script` or `style`, no `on*` attributes, and only `http(s)`, `mailto`, and image `data:` URLs.
- Mermaid diagrams. A fenced ` ```mermaid ` block becomes `<pre class="mermaid">` holding the escaped diagram source. Only pages with such a block load Mermaid, from jsDelivr, pinned to one version with an SRI `integrity` hash, with `securityLevel: 'strict'` and `htmlLabels: false` (labels are plain SVG text, so diagram HTML never bypasses the sanitizer), and a theme that follows `prefers-color-scheme`. That script is part of the page template; a `script` in the Markdown is still stripped. See [the generated site](docs/site-output.md#mermaid-diagrams).
- A redirect stub for each `redirects` key. See [Redirects](#redirects).
- `.nojekyll`, a `.docs-kit-build` marker, and `docs-bundle.json`. The bundle is described in [docs/bundle-format.md](docs/bundle-format.md#docs-bundlejson).

`build` then checks every internal `href` and `src` in the generated site, and the URL of each redirect stub's meta refresh, including `#fragments`, and exits `1` if any of them is broken. Each stub must also have exactly one redirect script whose target resolves and equals its meta refresh URL. `build` needs a git checkout because the bundle and the GitHub links carry `git rev-parse HEAD`. `--out` is resolved relative to the current directory and is deleted before each build. `build` refuses an `--out` that is the repository or a parent of it, is inside a `.git` directory, or contains git-tracked files. It also refuses any existing non-empty directory unless every file in it is listed in the `.docs-kit-build` manifest that a previous build wrote. This applies inside or outside git, whether or not the directory is ignored. A file added by hand blocks the rebuild, and the error names it. A new or empty directory is fine. A forged marker is trusted: docs-kit deletes whatever a marker lists.

### mcp

```sh
docs-kit mcp [--repo dir | --workspace dir | --hub url]
```

`mcp` starts a stdio MCP server. Give it at most one source; with none, it uses `--hub https://kontourai.github.io/`. See [MCP server](#mcp-server).

### hub

```sh
docs-kit hub [--products products.json] [--out dist-hub]
```

`hub` builds the organization hub: a self-contained `index.html` and a copy of `products.json`. It validates `products.json` strictly. Serve the output at the origin root (`https://kontourai.github.io/`), because each product card loads `/<product>/docs-bundle.json` from the same origin. Each card also loads `https://api.github.com/repos/<repo>/commits/HEAD` (the default branch), which it caches in `localStorage` for 10 minutes. Each card shows one state:

| State | Meaning |
| --- | --- |
| `unpublished` | The bundle could not be fetched. |
| `behind` | The bundle's `sha` differs from the default branch HEAD. The card shows the bundle's age and the HEAD commit's. |
| `thin` | The bundle has fewer than 3 documents, not counting the landing page. |
| `current` | The bundle's `sha` equals the default branch HEAD. |
| `unknown` | The GitHub API could not be read (for example, it was rate limited), so `current` cannot be claimed. |

If more than one state applies, the first one in the table wins.

### init

```sh
docs-kit init [--root dir]
```

`init` writes a starter `docs-kit.json`. It uses `README.md` as the landing page, lists every `docs/**/*.md`, and guesses each section from the first directory under `docs/`. It takes the product and repo from the `origin` remote, and the tagline from `package.json`. It never overwrites an existing manifest.

## MCP server

The server exposes six read-only tools. Every result carries the source commit `sha` of the bundle it came from, and `dirty: true` when a local checkout has uncommitted changes. A tool never throws: problems come back as results with `isError` set.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `list_products` | none | product, title, tagline, sha, builtAt, siteUrl, topicCount, docCount (not counting the landing page); failed products are listed as `unavailable` |
| `list_topics` | `product?` | topics with product, id, title, source, url, sha |
| `get_topic` | `product`, `id` | the topic's Markdown section |
| `get_document` | `product`, `source` | one whole document, including the landing page (`landing: true`) |
| `search` | `query`, `product?`, `limit?` (1-50, default 10) | ranked matches over topics and documents, with snippet, product, source, url, sha |
| `locate` | `product`, `quote`, `source?` | where a quoted passage lives: `source`, `repoPath`, 1-based file `startLine` and `endLine`, sha, the enclosing `heading` and `anchor`, the page `url`, the surrounding `markdown` blocks, a GitHub `blobUrl` ending in `#Lstart-Lend`, `match`, `confidence`, and, when the quote matches more than one place, `ambiguous: true`, `matchCount`, and up to 10 `alternatives` |

`locate` is what the site's Ask and Challenge prompts tell an agent to call. It compares letters and digits only, lowercased and with accents removed (NFKD), so whitespace, punctuation, and Markdown formatting (emphasis, code marks, link destinations, HTML tags, list and table markers, fence lines) do not matter. Numeric entities and `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`, and `&nbsp;` are decoded; other named entities (such as `&eacute;`) are ignored, so a quote containing their character falls back to the surrounding words. Text inside code blocks and code spans is compared as the page shows it, so `<dir>` in a code sample still matches. `match` is `verbatim` (confidence 1) when the quote also appears as written, `normalized` (0.9) when it matched only after that normalization, or `head-and-tail` (0.5) when only its first and last four words matched within a nearby window, for example across an image. With more than one candidate, the confidence is divided by their number (minimum 0.01); verbatim candidates rank before normalized ones, each in document order, and the best is returned with up to 10 others as `alternatives` and the total as `matchCount`. No match, a quote with fewer than 3 letters or digits, or an unknown `source` is an error result. Line numbers are file lines, after front matter; a bundle built before 0.6.0 does not record front matter, so `locate` adds a `note` saying it assumes none.

The server has three sources:

- `--repo dir` builds the bundle in memory from a checkout and writes nothing. It rebuilds whenever the checkout changes, so a long session sees current docs. The cache key is HEAD, a hash of `git status --porcelain`, and the mtime and size of the manifest and each published source. It needs a valid manifest and resolvable topics at startup; a later breakage is reported as unavailable.
- `--workspace dir` does the same for every immediate subdirectory that contains `docs-kit.json`. It rescans the directory on every call and rebuilds only the products that changed. A subdirectory that fails is reported as unavailable under the `product` its manifest declares (the directory name if the manifest does not parse). If two directories declare the same product, both are unavailable.
- `--hub url` fetches `<url>/products.json` and then each `<url>/<product>/docs-bundle.json`. It keeps successful fetches in memory for 10 minutes and retries failed or malformed ones after 30 seconds. A product whose fetch fails, or whose bundle is malformed, is reported as unavailable; this is not fatal.

Claude Code:

```sh
claude mcp add kontour-docs -- npx -y github:kontourai/docs-kit#<sha> docs-kit mcp
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.kontour-docs]
command = "npx"
args = ["-y", "github:kontourai/docs-kit#<sha>", "docs-kit", "mcp"]
```

To serve local checkouts while you write docs, add `--workspace ~/dev/github/kontourai` or `--repo .` after `mcp`.

## Adopting docs-kit in a repo

1. Pin a docs-kit commit. Use its full sha everywhere below as `<sha>`.
2. Scaffold and review the manifest. Order the documents, name the sections, move internal docs to `exclude`, and add `topics` and `covers`.

   ```sh
   npx -y github:kontourai/docs-kit#<sha> docs-kit init
   npx -y github:kontourai/docs-kit#<sha> docs-kit check
   ```

3. Add the gate to CI. On pull requests, `fetch-depth: 0` makes the base branch available for freshness. Drop `--advisory` once the `covers` globs are trusted.

   ```yaml
   - uses: actions/checkout@v7
     with:
       fetch-depth: 0
   - uses: actions/setup-node@v6
     with:
       node-version: 24
   - run: npx -y github:kontourai/docs-kit#<sha> docs-kit check
   - if: github.event_name == 'pull_request'
     run: npx -y github:kontourai/docs-kit#<sha> docs-kit check --base origin/${{ github.base_ref }} --advisory
   ```

4. Publish Pages from `main`. Set the repository's Pages source to GitHub Actions, then run:

   ```yaml
   - run: npx -y github:kontourai/docs-kit#<sha> docs-kit build --out dist-pages
   - uses: actions/upload-pages-artifact@v5
     with:
       path: dist-pages
   - uses: actions/deploy-pages@v5
   ```

5. Add the product to the hub's `products.json` (`{"product": "<repo>", "repo": "kontourai/<repo>"}`).

## Known limits

- External links are never fetched, so a dead `https://` link passes `check`.
- `#fragment` matching is case-sensitive.
- Headings that contain images or code spans can slug slightly differently from github.com in edge cases.
- Links cannot point above `--root`, and a leading `/` resolves from `--root`, not from the git top level.
- Freshness is file-level: any edit to a covering document in the range counts as an update.
- Topic anchors must be headings outside blockquotes and lists. A heading inside a quote or a list item does not qualify, at any heading level.
- Mermaid diagrams need JavaScript and jsDelivr. Without them the page shows the diagram source as preformatted text.
- Raw-HTML `name` attributes count as anchors in `check`, but the sanitizer keeps `name` only on `<a>`. A `name` on another element passes `check` and then fails the generated-site check in `build`. Element `id`s are not prefixed with `user-content-` as they are on GitHub.
- MCP `search` is plain term matching with no stemming or synonyms.
- The hub calls the GitHub API without authentication, which allows 60 requests per hour per IP. The 10-minute `localStorage` cache keeps normal use within that limit.
- Any asset reference that goes through a symlink, as a file or as a directory in its path, is refused as unpublishable, whatever the link points at. Commit the real file instead.
- "Tracked" means present in the git index. A local `build` publishes tracked assets with their unstaged working-tree edits. CI builds from a clean checkout, so its output matches the commit.
- Empty directories that someone adds by hand inside the output directory are removed on rebuild. Only files are checked against the `.docs-kit-build` manifest.
- In a bundle-only document, a link destination written with backslash escapes (such as `[x](a\(b\).md)`) cannot be located in the source text, so it is left relative in the bundle. A topic's Markdown does not carry reference definitions from outside its section, so `[text][ref]` links in a topic stay unresolved.
- The paths gate matches home directories by shape. It does not catch a path relative to `~`, a percent-encoded path, or a home directory outside `/Users`, `/home`, and `C:\Users`.
- The selection toolbar's line ranges cover whole annotated blocks (a top-level paragraph, list item, table row, code block, or blockquote), not the selected characters. Raw HTML blocks have no line attribute, so a selection inside one carries only the page's path and sha.
- `locate` matches letters and digits, so it cannot tell apart passages that differ only in punctuation, and text that renders differently from its source (an image's alt text, a Mermaid diagram) needs the head-and-tail fallback.
- WebMCP is a Chromium-only draft whose API is still changing; the in-page tools follow the October 2026 draft and the earlier synchronous form, and may need updating as it evolves.
- The hub's install snippet shows `<sha>` as a placeholder. It cannot know which docs-kit commit to recommend.

## License

Apache-2.0. See [LICENSE](LICENSE).
