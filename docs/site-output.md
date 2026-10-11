# What the generated site contains

`docs-kit build --out dist-pages` replaces the output directory with a static site that GitHub Pages can serve as is.

## Pages

| Output | From |
| --- | --- |
| `index.html` | the `landing` Markdown, followed by cards for every document, grouped by section |
| `<source>.html` | each listed document, at its source path with `.md` replaced by `.html` (`docs/guide.md` becomes `docs/guide.html`) |
| `docs-kit.css` | the shared stylesheet, with light and dark themes that follow `prefers-color-scheme` |
| images and media | every local image, and every file embedded with `src`, `srcset`, or `poster`, that a published page references, copied to its repository path; only git-tracked files up to 25 MB, never `.git/` |
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
| any other repository file or directory | `https://github.com/<repo>/blob/<sha>/<path>`, or `tree` for directories |
| `http(s):` and `mailto:` | unchanged |
| other schemes, such as `javascript:` | `#` |

The same rewriting applies to `href`, `src`, `srcset`, and `poster` attributes in raw HTML, in any quoting style. Raw HTML is tokenized with htmlparser2, so comments and quoting follow the HTML tokenizer, and `srcset` is parsed per the HTML spec. References to untracked, ignored, or `.git/` files fail `check` and `build`. `check` and `build` use one shared extractor for them.

## Sanitization

Every product site shares the `https://kontourai.github.io` origin, so a script in one product's docs could act on every other product's pages. The rendered Markdown is passed through `sanitize-html` with a GitHub-like allowlist. `script`, `style`, `iframe`, and `on*` attributes are removed, and URLs are limited to `http(s)`, `mailto`, and `data:` images. Heading `id`s, anchor links, images, tables, `details`/`summary` (including `open`), `video`/`source` with their media attributes, and task-list checkboxes are kept.

## Mermaid diagrams

A fenced code block whose info string starts with `mermaid` renders as `<pre class="mermaid">` holding the escaped diagram source, not as a code block. A page with at least one such block loads Mermaid from `https://cdn.jsdelivr.net/npm/mermaid@<version>/dist/mermaid.min.js`, pinned to an exact version with an SRI `integrity` hash and `crossorigin="anonymous"`, and calls `mermaid.initialize` with `startOnLoad: true`, `securityLevel: 'strict'`, and the `dark` or `default` theme, chosen from `prefers-color-scheme` when the page loads. Pages without a mermaid block load no script. The script is part of the page template, not of the document content, so a `script` written in Markdown is still removed. `docs-bundle.json` keeps the Markdown as written.

## Generated-site check

After rendering, `build` scans every generated `href`, `src`, and `srcset` with the same extractor and fails if an internal target or `#fragment` is missing. `check` already validates the sources, so this catches what rendering changes. For example, a `name` anchor on a non-`<a>` element passes `check`, but the sanitizer removes it, so links to it break on the site.
