import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { UsageError } from './errors.mjs';
import { validateProducts } from './manifest.mjs';
import { BASE_CSS, escapeHtml } from './site-template.mjs';

const HUB_CSS = `${BASE_CSS}
main { max-width: 1100px; margin: 0 auto; padding: 2rem 1.5rem 3rem; }
h1 { font-size: 2.1rem; line-height: 1.2; margin: 0 0 .5rem; }
.lede { color: var(--muted); font-size: 1.1rem; max-width: 70ch; margin: 0 0 1.5rem; }
.legend { display: flex; flex-wrap: wrap; gap: .5rem 1.25rem; padding: 0; margin: 0 0 1.5rem; list-style: none; color: var(--muted); font-size: .9rem; }
.products { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); padding: 0; margin: 0; list-style: none; }
.product { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); padding: 1rem 1.1rem; display: flex; flex-direction: column; gap: .4rem; }
.product h2 { font-size: 1.15rem; margin: 0; display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
.product h2 a { color: var(--fg); text-decoration: none; }
.product h2 a:hover { text-decoration: underline; }
.product .tagline { margin: 0; color: var(--muted); font-size: .95rem; }
.product .meta { margin: 0; color: var(--muted); font-size: .85rem; }
.product .links { margin: auto 0 0; font-size: .9rem; display: flex; gap: 1rem; }
.state { display: inline-block; font-size: .75rem; font-weight: 700; letter-spacing: .03em; text-transform: uppercase; padding: .1rem .5rem; border-radius: 999px; border: 1px solid currentColor; }
.state-current { color: var(--ok); }
.state-behind { color: var(--warn); }
.state-thin { color: var(--info); }
.state-unpublished { color: var(--bad); }
.state-unknown, .state-checking { color: var(--muted); }
section.install { margin-top: 2.5rem; max-width: 80ch; }
section.install h2 { margin-bottom: .5rem; }
`;

/**
 * Client-side status: the bundle comes from the same origin (the hub must be
 * served at the origin root, e.g. https://kontourai.github.io/), and the
 * default-branch HEAD from the GitHub API, cached in localStorage for 10
 * minutes to stay under the anonymous rate limit. Precedence: unpublished, behind, thin, current; "unknown" when the
 * main commit could not be read and nothing else applies.
 */
const HUB_SCRIPT = `
(function () {
  var products = JSON.parse(document.getElementById('products-data').textContent);
  var TTL = 10 * 60 * 1000;
  function ago(iso) {
    var then = Date.parse(iso);
    if (!isFinite(then)) return 'at an unknown time';
    var s = Math.max(0, (Date.now() - then) / 1000);
    var units = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]];
    for (var i = 0; i < units.length; i++) {
      var n = Math.floor(s / units[i][1]);
      if (n >= 1) return n + ' ' + units[i][0] + (n === 1 ? '' : 's') + ' ago';
    }
    return 'just now';
  }
  function getJson(url, init) {
    return fetch(url, init).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }
  function mainCommit(repo) {
    var key = 'docs-kit-hub:head:' + repo;
    try {
      var hit = JSON.parse(localStorage.getItem(key) || 'null');
      if (hit && Date.now() - hit.at < TTL) return Promise.resolve(hit.value);
    } catch (e) {}
    return getJson('https://api.github.com/repos/' + repo + '/commits/HEAD', { headers: { Accept: 'application/vnd.github+json' } }).then(function (c) {
      var value = { sha: c.sha, date: c.commit && c.commit.committer ? c.commit.committer.date : null };
      try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), value: value })); } catch (e) {}
      return value;
    });
  }
  function settle(p) {
    return p.then(function (v) { return { ok: true, value: v }; }, function (e) { return { ok: false, error: e }; });
  }
  function text(el, value) { el.textContent = value; }
  products.forEach(function (p) {
    var card = document.getElementById('product-' + p.product);
    var badge = card.querySelector('.state');
    var tagline = card.querySelector('.tagline');
    var meta = card.querySelector('.meta');
    Promise.all([
      settle(getJson('/' + p.product + '/docs-bundle.json', { cache: 'no-cache' })),
      settle(mainCommit(p.repo))
    ]).then(function (r) {
      var bundle = r[0].ok && r[0].value && r[0].value.schemaVersion === 1 ? r[0].value : null;
      var main = r[1].ok ? r[1].value : null;
      var state, detail;
      if (!bundle) {
        state = 'unpublished';
        detail = 'No docs bundle is published at /' + p.product + '/docs-bundle.json.';
      } else {
        var docs = (bundle.documents || []).filter(function (d) { return !d.landing; }).length, topics = (bundle.topics || []).length;
        var counts = docs + ' doc' + (docs === 1 ? '' : 's') + ', ' + topics + ' topic' + (topics === 1 ? '' : 's');
        var built = 'built ' + ago(bundle.builtAt) + ' from ' + String(bundle.sha || '').slice(0, 7);
        if (bundle.tagline) text(tagline, bundle.tagline);
        if (main && main.sha && bundle.sha !== main.sha) {
          state = 'behind';
          detail = counts + '; ' + built + '; HEAD is ' + main.sha.slice(0, 7) + (main.date ? ', committed ' + ago(main.date) : '') + '.';
        } else if (docs < 3) {
          state = 'thin';
          detail = counts + '; ' + built + '. Fewer than 3 documents.';
        } else if (main && main.sha) {
          state = 'current';
          detail = counts + '; ' + built + ', matching HEAD.';
        } else {
          state = 'unknown';
          detail = counts + '; ' + built + '. Could not read the default branch from GitHub to compare.';
        }
      }
      badge.className = 'state state-' + state;
      text(badge, state);
      text(meta, detail);
      card.setAttribute('data-state', state);
    });
  });
})();
`;

function productCard({ product, repo }) {
  return `<li class="product" id="product-${escapeHtml(product)}" data-state="checking">
  <h2><a href="/${escapeHtml(product)}/">${escapeHtml(product)}</a> <span class="state state-checking">checking</span></h2>
  <p class="tagline"></p>
  <p class="meta" aria-live="polite">Loading the published docs bundle…</p>
  <p class="links"><a href="/${escapeHtml(product)}/">Docs site</a><a href="https://github.com/${escapeHtml(repo)}">${escapeHtml(repo)}</a></p>
</li>`;
}

export function renderHub(products) {
  // `<` is escaped so product data can never close the script element.
  const data = JSON.stringify(products).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kontour documentation</title>
<meta name="description" content="Documentation for every Kontour building block, and one MCP server that serves all of it to agents.">
<meta name="generator" content="@kontourai/docs-kit">
<style>${HUB_CSS}</style>
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header">
  <a class="brand" href="./">Kontour docs</a>
  <nav aria-label="Site"><a href="https://github.com/kontourai">GitHub</a><a href="#install">MCP server</a></nav>
</header>
<main id="main">
  <h1>Kontour documentation</h1>
  <p class="lede">Every Kontour building block publishes its docs here from its own repository. Status compares each published bundle with the HEAD of the repository's default branch.</p>
  <ul class="legend" aria-label="Status legend">
    <li><span class="state state-current">current</span> built from the default branch HEAD</li>
    <li><span class="state state-behind">behind</span> the default branch has moved since the build</li>
    <li><span class="state state-thin">thin</span> fewer than 3 documents</li>
    <li><span class="state state-unpublished">unpublished</span> no bundle found</li>
    <li><span class="state state-unknown">unknown</span> GitHub could not be reached to compare</li>
  </ul>
  <ul class="products">
${products.map(productCard).join('\n')}
  </ul>
  <section class="install" id="install" aria-labelledby="install-heading">
    <h2 id="install-heading">Ask an agent about any building block</h2>
    <p>The docs-kit MCP server reads every published bundle listed here and answers <code>list_products</code>, <code>list_topics</code>, <code>get_topic</code>, <code>get_document</code>, and <code>search</code>. Replace <code>&lt;sha&gt;</code> with a commit of <a href="https://github.com/kontourai/docs-kit">kontourai/docs-kit</a>.</p>
    <pre><code>npx -y github:kontourai/docs-kit#&lt;sha&gt; docs-kit mcp</code></pre>
    <p>Claude Code:</p>
    <pre><code>claude mcp add kontour-docs -- npx -y github:kontourai/docs-kit#&lt;sha&gt; docs-kit mcp</code></pre>
    <p>Codex (<code>~/.codex/config.toml</code>):</p>
    <pre><code>[mcp_servers.kontour-docs]
command = "npx"
args = ["-y", "github:kontourai/docs-kit#&lt;sha&gt;", "docs-kit", "mcp"]</code></pre>
  </section>
</main>
<footer class="site-footer">Generated by <a href="https://github.com/kontourai/docs-kit">docs-kit</a> from <a href="products.json">products.json</a>.</footer>
<script type="application/json" id="products-data">${data}</script>
<script>${HUB_SCRIPT}</script>
</body>
</html>
`;
}

/** `docs-kit hub`: validate products.json strictly, write index.html and a copy of products.json. */
export function runHub({ products: productsFile, out }) {
  let text;
  try {
    text = readFileSync(productsFile, 'utf8');
  } catch (error) {
    throw new UsageError(`cannot read ${productsFile}: ${error.code === 'ENOENT' ? 'file not found' : error.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`${productsFile} is not valid JSON: ${error.message}`);
  }
  const { products, errors } = validateProducts(raw);
  if (errors.length > 0) throw new UsageError(`${productsFile} is invalid:\n${errors.map((error) => `  - ${error}`).join('\n')}`);
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'index.html'), renderHub(products));
  writeFileSync(path.join(out, 'products.json'), text);
  return `docs-kit hub: ${products.length} products -> ${out}`;
}
