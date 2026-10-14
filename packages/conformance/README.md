# Corpus store conformance

Version `0.1.0-next.0` is published alongside Corpus Store on the `next`
dist-tag through the [workspace publish workflow](../../README.md#publishing-the-store-workspaces).
This package has no dependencies; Store uses it only for development tests,
so neither package requires the other to be published first.

These vectors describe expected results from the public Knowledge Kit store contract and Station's public documentation/contracts, with owner-approved decisions below. They are not snapshots of any implementation's behavior. No mutable store is shipped here.

- Proposals, application, and rejection may target any record type.
- List and search default to the working set. `includeHistory: true` is the single history flag, including retired and superseded records.
- Whitespace-only bodies are rejected with `MISSING_EVIDENCE`.
- Compiled records must link a raw source at creation. Other compiled fixtures have a raw-source precondition.
- Expiry is `created_at + ttl_seconds`; explicit `expires_at` takes precedence.

The original study's non-public vectors and implementation-source citations were excluded. Contract-only replacements cover compiled-source rejection, TTL anchoring, and absolute-expiry precedence. Conflicting alternatives were replaced with the decisions above. Storage fault and read-facade vectors still require adapter-specific harnesses; their expectations are not waived.

```js
import { runConformance } from '@kontourai/corpus-conformance';
const report = await runConformance(async (vector) => {
  const adapter = await openFreshStore();
  return { adapter, dispose: () => adapter.close(), specials: storageProbes };
});
if (!report.passed) throw new Error(JSON.stringify(report.results));
```

The factory runs once per vector and must provide an isolated store. Adapter calls use the public method names and arguments in `vectors.json`; `create` returns an id string. Errors expose their contract code as `error.code`. Results are cloned when saved so later mutations cannot rewrite earlier observations. `cases` optionally selects vectors; report that selection when claiming conformance.

A factory may return the adapter directly, or `{adapter, dispose, specials}`. Special probes receive `{adapter, operation, values}` and return saved observations (usually `{check: true}` after their own assertions). The runner implements TTL anchoring and short-prefix resolution itself. Other probes must perform the real storage action and assert the cited contract: front-matter separation; reindex after lost/corrupt/idempotent indexes; preserving future fields; legacy label sanitation; concurrent creates/updates; interrupted writes; traversal and physical-id collision prevention; symlink refusal; graph integrity; identity paths; and real writable population for read-facade fixtures. `read-fixture` returns `a` and `b` ids, honoring `operation.retired`.

Missing methods/probes, malformed expected entries (neither `equals`, `length`, nor `absent: true`), unresolved references, unexpected errors, incorrect results, and cleanup failures all fail the vector. No result from a missing prerequisite counts as success. Providing a probe that returns success without exercising and asserting its contract invalidates conformance evidence.

Field-clearing assertions use `absent: true` to distinguish a removed field from a stored null. Embedded body text is literal; vector references are whole argument values only.

## Decision-record vectors

`decision-records.json` (exported as `@kontourai/corpus-conformance/decision-records`) holds vectors for the [decision record format](../../docs/decisions.md), independent of the store vectors and the runner. Each vector is a whole registry: `records` lists each file's `slug` (its name without `.md`), its `markdown` text, its `frontmatter` as JSON (`null` when the block cannot be read), and `expected`, the sorted rule codes it must fail (empty means valid). Relation rules resolve slugs within the vector. A validator that receives parsed fields rather than files can use `frontmatter` and skip the `frontmatter` rule. The rule codes are listed in `rules`; Corpus itself is tested against every vector, every code has at least one rejecting vector, and each of the six secret-shaped literal detectors has a vector that only it refuses. Index freshness and the ADR freeze depend on a repository and are not covered.
