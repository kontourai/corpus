export const HUB_URL = 'https://kontourai.github.io/';

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Shared palette and type for product sites and the hub. Light and dark follow the OS. */
export const BASE_CSS = `:root {
  color-scheme: light dark;
  --bg: #fbfaf7; --surface: #ffffff; --fg: #1b1f24; --muted: #59636e;
  --border: #d9dde2; --accent: #0b5cad; --accent-fg: #ffffff; --code-bg: #f1f2f4;
  --ok: #1a7f37; --warn: #9a6700; --bad: #b42318; --info: #5a4ab5;
  --radius: 10px;
  --font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0e1116; --surface: #161b22; --fg: #e6edf3; --muted: #9da7b3;
    --border: #30363d; --accent: #6cb6ff; --accent-fg: #0e1116; --code-bg: #1f252d;
    --ok: #56d364; --warn: #e3b341; --bad: #ff7b72; --info: #b8a8ff;
  }
}
* { box-sizing: border-box; }
html { background: var(--bg); color: var(--fg); font: 16px/1.6 var(--font); }
body { margin: 0; }
a { color: var(--accent); text-underline-offset: 2px; }
a:focus-visible, button:focus-visible, [tabindex]:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
.skip-link { position: absolute; left: -999px; top: 0; background: var(--accent); color: var(--accent-fg); padding: .5rem 1rem; z-index: 10; }
.skip-link:focus { left: 1rem; top: 1rem; }
.site-header { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem 1.5rem; padding: .85rem 1.5rem; border-bottom: 1px solid var(--border); background: var(--surface); }
.brand { font-weight: 700; font-size: 1.1rem; color: var(--fg); text-decoration: none; }
.brand small { font-weight: 500; color: var(--muted); margin-left: .5rem; font-size: .85rem; }
.site-header nav { display: flex; gap: 1.25rem; margin-left: auto; flex-wrap: wrap; }
.site-header nav a { color: var(--muted); text-decoration: none; font-weight: 500; }
.site-header nav a:hover { color: var(--fg); text-decoration: underline; }
code, pre { font-family: var(--mono); font-size: .9em; }
:not(pre) > code { background: var(--code-bg); padding: .1em .35em; border-radius: 4px; }
pre { background: var(--code-bg); padding: 1rem; border-radius: var(--radius); overflow-x: auto; line-height: 1.45; }
footer.site-footer { color: var(--muted); font-size: .875rem; border-top: 1px solid var(--border); padding: 1.25rem 1.5rem; }
`;

export const SITE_CSS = `${BASE_CSS}
.shell { display: grid; grid-template-columns: minmax(0, 1fr); max-width: 1180px; margin: 0 auto; }
@media (min-width: 900px) { .shell { grid-template-columns: 250px minmax(0, 1fr); } }
.site-nav { padding: 1.25rem 1.5rem; border-bottom: 1px solid var(--border); }
@media (min-width: 900px) { .site-nav { border-bottom: 0; border-right: 1px solid var(--border); position: sticky; top: 0; align-self: start; max-height: 100vh; overflow-y: auto; } }
.site-nav h2 { font-size: .75rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 1.25rem 0 .4rem; }
.site-nav h2:first-child { margin-top: 0; }
.site-nav ul { list-style: none; margin: 0; padding: 0; }
.site-nav li a { display: block; padding: .25rem .5rem; margin-left: -.5rem; border-radius: 6px; color: var(--fg); text-decoration: none; font-size: .95rem; }
.site-nav li a:hover { background: var(--code-bg); }
.site-nav li a[aria-current="page"] { background: var(--code-bg); color: var(--accent); font-weight: 600; }
main.content { padding: 1.5rem; min-width: 0; }
@media (min-width: 900px) { main.content { padding: 2rem 3rem; } }
.doc { max-width: 78ch; }
.doc h1 { font-size: 2rem; line-height: 1.25; margin-top: 0; }
.doc h2 { margin-top: 2.25rem; padding-bottom: .3rem; border-bottom: 1px solid var(--border); }
.doc h1, .doc h2, .doc h3, .doc h4 { scroll-margin-top: 1rem; }
.doc .anchor { margin-left: .4rem; color: var(--muted); text-decoration: none; opacity: 0; font-weight: 400; }
.doc :is(h1, h2, h3, h4, h5, h6):hover .anchor, .doc .anchor:focus { opacity: 1; }
.doc img { max-width: 100%; height: auto; }
.doc pre.mermaid { background: transparent; text-align: center; }
.doc blockquote { margin: 1rem 0; padding: .25rem 1rem; border-left: 4px solid var(--border); color: var(--muted); }
.doc table { border-collapse: collapse; width: 100%; }
.doc th, .doc td { border: 1px solid var(--border); padding: .45rem .7rem; text-align: left; vertical-align: top; }
.doc th { background: var(--code-bg); }
.table-scroll { overflow-x: auto; margin: 1rem 0; }
.doc-meta { color: var(--muted); font-size: .875rem; margin-top: 2.5rem; padding-top: 1rem; border-top: 1px solid var(--border); }
.hero { margin-bottom: 2rem; }
.hero .tagline { font-size: 1.15rem; color: var(--muted); margin: .25rem 0 0; }
.section-cards { max-width: 78ch; margin-top: 2.5rem; }
.section-cards > h2 { margin: 0 0 .5rem; padding-bottom: .3rem; border-bottom: 1px solid var(--border); }
.section-cards h3 { font-size: 1rem; margin: 1.25rem 0 .6rem; color: var(--muted); }
.cards { display: grid; gap: .75rem; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); }
.card { display: block; padding: .9rem 1rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: var(--fg); text-decoration: none; }
.card:hover { border-color: var(--accent); }
.card strong { display: block; color: var(--accent); margin-bottom: .2rem; }
.card span { color: var(--muted); font-size: .9rem; }
`;

/**
 * Mermaid for pages with a ```mermaid fence, pinned to one exact file by SRI.
 * The integrity hash is sha384 of
 * https://cdn.jsdelivr.net/npm/mermaid@12.1.0/dist/mermaid.min.js, which is
 * byte-identical to dist/mermaid.min.js in the npm tarball. Changing the
 * version means recomputing the hash from the fetched file.
 */
export const MERMAID_VERSION = '12.1.0';
export const MERMAID_SRC = `https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.min.js`;
export const MERMAID_INTEGRITY = 'sha384-EbBpjO7rlR6eqZEcG7GaPpyk9H9WrMyPWX4d3KvPYltgt8Z8l0z6R56B1qP40pR4';

/**
 * The template's own scripts, outside the sanitized document content.
 * securityLevel 'strict' keeps diagram labels from carrying HTML or click
 * handlers; the theme is chosen once from prefers-color-scheme at load.
 */
const MERMAID_SCRIPTS = `<script src="${MERMAID_SRC}" integrity="${MERMAID_INTEGRITY}" crossorigin="anonymous"></script>
<script>mermaid.initialize({ startOnLoad: true, securityLevel: 'strict', theme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default' });</script>
`;

/** One page of a product site. `toRoot` is the relative prefix back to the site root. */
export function sitePage({ manifest, title, description, navHtml, content, toRoot, sha, mermaid = false }) {
  const repoUrl = `https://github.com/${manifest.repo}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${description ? `<meta name="description" content="${escapeHtml(description)}">\n` : ''}<meta name="generator" content="@kontourai/docs-kit">
<link rel="stylesheet" href="${toRoot}docs-kit.css">
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header">
  <a class="brand" href="${toRoot}index.html">${escapeHtml(manifest.title)}${manifest.tagline ? `<small>${escapeHtml(manifest.tagline)}</small>` : ''}</a>
  <nav aria-label="Site">
    <a href="${HUB_URL}">All Kontour docs</a>
    <a href="${escapeHtml(repoUrl)}">GitHub</a>
  </nav>
</header>
<div class="shell">
  <nav class="site-nav" aria-label="Documentation">
${navHtml}
  </nav>
  <main id="main" class="content">
${content}
  </main>
</div>
<footer class="site-footer">
  Built from <a href="${escapeHtml(`${repoUrl}/commit/${sha}`)}"><code>${escapeHtml(sha.slice(0, 7))}</code></a> of
  <a href="${escapeHtml(repoUrl)}">${escapeHtml(manifest.repo)}</a> with docs-kit.
  Part of the <a href="${HUB_URL}">Kontour documentation hub</a>.
</footer>
${mermaid ? MERMAID_SCRIPTS : ''}</body>
</html>
`;
}
