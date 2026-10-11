# docs-kit

`@kontourai/docs-kit` gives every Kontour product the same three things from one manifest:

- **A docs gate for CI.** `docs-kit check` validates links, anchors, reachability, topics, and (on pull requests) freshness.
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
  "exclude": ["docs/plans/**"]
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
| `documents` | yes | Published pages, in navigation order. Each entry has `source` (a `.md` path), `section` (the navigation group) and, optionally, `covers`. |
| `topics` | no | Curated entry points for agents. Each has `id` (a lowercase slug), `title`, and `source`, which is either `path` or `path#anchor`. |
| `exclude` | no | Globs for `docs/**/*.md` files that are deliberately unpublished. |

The validation rules:

- Validation is strict. An unknown key at any level is refused.
- Every path is repository-relative, POSIX, and normalized. Absolute paths, `..` segments, and symlinks that resolve outside the repository are refused. Every source must exist.
- Documents are listed once. They may not repeat the landing page, and they may not match `exclude`.
- A topic `source` must point at the landing page or at a listed document, so it is published. Its `#anchor` must be a top-level heading, slugged by [github-slugger](https://github.com/Flet/github-slugger): lowercase, punctuation dropped, spaces become `-`, and repeated headings get `-1`, `-2`, and so on.
- `covers` holds globs of the code a document describes; the [freshness gate](#check) uses them. A bare directory name such as `src/cli` means `src/cli/**`. A glob that matches no tracked file (`git ls-files`; every file outside git) is a configuration error, because it could never mark its document stale.

Section names group the navigation in the order they first appear in `documents`.

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
2. **links:** every Markdown link and image, and every raw-HTML `href`, `src`, and `srcset` (double-quoted, single-quoted, or unquoted), in the landing page and the listed documents resolves. Relative files must exist, with exact case. A `#anchor` must match a heading slug, or an `id` or `name` attribute in raw HTML, in the target `.md`. External `http(s)` links are not fetched. A leading `/` resolves from `--root` (which is the repository root unless you point `--root` at a subdirectory).
3. **reachability:** every `docs/**/*.md` is listed in `documents` (or is the landing page) or is matched by `exclude`.
4. **topics:** every topic anchor resolves to a top-level heading.
5. **freshness:** this gate runs only with `--base`. It reads the changed files from `git diff --name-only --no-renames <base>...HEAD`, which diffs from the merge base and lists both paths of a renamed file. If a document's `covers` globs match a changed file, the document's own `source` must also be in the changed set. Otherwise the document is stale. With `--advisory`, stale documents are printed as warnings and the exit code is `0`. A base that does not resolve, or a directory that is not a git checkout, gives exit `2`, never a silent pass.

### build

```sh
docs-kit build [--root dir] [--out dist-pages] [--base-url https://kontourai.github.io/<product>/]
```

`build` runs `check` without freshness and refuses to build if it fails. It then replaces `--out` with:

- `index.html` (the landing page), one page per document, and `docs-kit.css`. Every page has navigation grouped by section, a link to the hub at <https://kontourai.github.io/>, and a link to the repository.
- Links between published documents, rewritten to the generated pages, in Markdown and in raw HTML (`href`, `src`, `srcset`). Links to other repository files go to `https://github.com/<repo>/blob/<sha>/<path>`, or to `tree` for directories.
- Copies of the local images that published documents reference.
- Sanitized HTML. Every product site shares the `kontourai.github.io` origin, so rendered Markdown is reduced to GitHub-like output: no `script` or `style`, no `on*` attributes, and only `http(s)`, `mailto`, and image `data:` URLs.
- `.nojekyll` and `docs-bundle.json`. The bundle is described in [docs/bundle-format.md](docs/bundle-format.md#docs-bundlejson).

`build` then checks every internal `href` and `src` in the generated site, including `#fragments`, and exits `1` if any of them is broken. `build` needs a git checkout because the bundle and the GitHub links carry `git rev-parse HEAD`. `--out` is resolved relative to the current directory and is deleted before each build. `build` refuses an `--out` that is the repository or a parent of it, is inside a `.git` directory, or contains git-tracked files or untracked files that are not git-ignored. A directory that does not exist yet, or holds only ignored files (such as a previous build in a git-ignored `dist-pages/`), is allowed.

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

The server exposes five read-only tools. Every result carries the source commit `sha` of the bundle it came from, and `dirty: true` when a local checkout has uncommitted changes. A tool never throws: problems come back as results with `isError` set.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `list_products` | none | product, title, tagline, sha, builtAt, siteUrl, topicCount, docCount (not counting the landing page); failed products are listed as `unavailable` |
| `list_topics` | `product?` | topics with product, id, title, source, url, sha |
| `get_topic` | `product`, `id` | the topic's Markdown section |
| `get_document` | `product`, `source` | one whole document, including the landing page (`landing: true`) |
| `search` | `query`, `product?`, `limit?` (1-50, default 10) | ranked matches over topics and documents, with snippet, product, source, url, sha |

The server has three sources:

- `--repo dir` builds the bundle in memory from a checkout and writes nothing. It rebuilds on every tool call, so a long session sees current docs. It needs a valid manifest and resolvable topics at startup; a later breakage is reported as unavailable.
- `--workspace dir` does the same for every immediate subdirectory that contains `docs-kit.json`, rescanning on every call. A subdirectory that fails is reported as unavailable under the `product` its manifest declares (the directory name if the manifest does not parse). If two directories declare the same product, both are unavailable.
- `--hub url` fetches `<url>/products.json` and then each `<url>/<product>/docs-bundle.json`. It keeps successful fetches in memory for 10 minutes and retries failed ones after 30 seconds. A product whose fetch fails, or whose bundle is malformed, is reported as unavailable; this is not fatal.

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
- Topic anchors must be top-level headings, not headings inside quotes or lists.
- Raw-HTML `name` attributes count as anchors in `check`, but the sanitizer keeps `name` only on `<a>`. A `name` on another element passes `check` and then fails the generated-site check in `build`. Element `id`s are not prefixed with `user-content-` as they are on GitHub.
- MCP `search` is plain term matching with no stemming or synonyms.
- The hub calls the GitHub API without authentication, which allows 60 requests per hour per IP. The 10-minute `localStorage` cache keeps normal use within that limit.
- The hub's install snippet shows `<sha>` as a placeholder. It cannot know which docs-kit commit to recommend.

## License

Apache-2.0. See [LICENSE](LICENSE).
