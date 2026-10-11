# What the generated site contains

`docs-kit build --out dist-pages` replaces the output directory with a static site that GitHub Pages can serve as is.

## Pages

| Output | From |
| --- | --- |
| `index.html` | the `landing` Markdown, followed by cards for every document, grouped by section |
| `<source>.html` | each listed document, at its source path with `.md` replaced by `.html` (`docs/guide.md` becomes `docs/guide.html`) |
| `docs-kit.css` | the shared stylesheet, with light and dark themes that follow `prefers-color-scheme` |
| images | every local image that a published page references, copied to its repository path |
| `.nojekyll` | turns off Jekyll processing on GitHub Pages |
| `docs-bundle.json` | the agent bundle; see [the bundle format](bundle-format.md#docs-bundlejson) |

Every page has the product title and tagline, navigation grouped by `section` in manifest order, a link to the hub, a link to the repository, and the source file at the built commit. Headings get GitHub-compatible `id`s, so anchors that work on GitHub also work on the site.

## Link rewriting

| Link in Markdown | On the site |
| --- | --- |
| a published document (`concepts.md#workflows`) | the generated page (`concepts.html#workflows`) |
| the landing page (`../README.md`) | `index.html` |
| a local image | the copied image |
| any other repository file or directory | `https://github.com/<repo>/blob/<sha>/<path>`, or `tree` for directories |
| `http(s):` and `mailto:` | unchanged |
| other schemes, such as `javascript:` | `#` |

The same rewriting is applied to `href` and `src` attributes in raw HTML.

## Generated-site check

Raw HTML is not checked by the Markdown gates; `check` covers Markdown links and images only. After rendering, `build` scans every generated `href` and `src` and fails if an internal target or `#fragment` is missing. A broken raw-HTML link therefore stops `build`, even though it passes `check`.
