# Corpus store conformance

Version `0.1.0-next.3` is intended for the `next` dist-tag alongside Corpus Store
through the [workspace publish workflow](../../README.md#publishing-the-store-workspaces).
This package has no dependencies; Store uses it only for development tests,
so neither package requires the other to be published first.

These vectors describe expected results from the public Knowledge Kit store contract and Station's public documentation/contracts, with owner-approved decisions below. They are not snapshots of any implementation's behavior. No mutable store is shipped here.

- Proposals, application, and rejection may target any record type.
- List and search default to the working set. `includeHistory: true` is the single history flag, including retired and superseded records.
- Whitespace-only bodies are rejected with `MISSING_EVIDENCE`.
- Compiled records must link a raw source at creation. Other compiled fixtures have a raw-source precondition.
- Expiry is `created_at + ttl_seconds`; explicit `expires_at` takes precedence.
- Request keys (`create-request-key-*` vectors) check same-input retries, conflict refusal, settled receipts, and unkeyed calls. Storage crash recovery requires an adapter-specific harness.
- `purge` tombstones records and everything that rests only on them (2026-11-02). The `purge-*` vectors cover the tombstone shape, the cascade and its cycle rule, survivors, every read path, the bytes on disk (no content and no digest of it, before and after rebuilding the derived indexes), refusal of any mutation that would revive a tombstone, input validation and the transaction journal. They call `purge` on the adapter, so an adapter under test must be built with purge enabled (`allowPurge: true` in Corpus Store); an adapter that does not implement `purge` fails them rather than skipping.

- Create proposals (`create-proposal-*` vectors): `proposeCreate` stages a `pending` proposal and creates no record; `applyCreate(proposalId, reviewerId)` creates it, linked back to the proposal; the proposer applying is refused with `SELF_APPROVAL`; `rejectCreate(proposalId, reviewerId, rationale)` keeps the proposal as `rejected`; pending and rejected proposals stay out of `get` and every list, and are read through `listProposals({ state })`. A store that does not implement them lists the vectors as expected failures.

- Proposal erasure (`purge-proposal-erase-*`, `purge-proposal-store-bytes`, `purge-proposal-journal-erasure`, `purge-proposal-concurrent-settlement`, `root-binding-after-purge-proposal`): `purgeProposal(proposalId, evidence)` erases one create proposal by its own id, in any state, leaving the candidate stub and `erasure` marker that a record purge writes; a pending proposal is settled `rejected`, an applied one is erased with the record it created, a repeat is a no-op, and a request-key retry afterwards is refused with `REQUEST_KEY_CONFLICT`. Like `purge`, they need an adapter built with purge enabled and fail rather than skip when `purgeProposal` is missing. `purge-store-bytes` accepts `"subject": "proposal"` to skip its record assertion. The journal and concurrency probes need the adapter-specific harness described above.

- Record confidence (`confidence-*` vectors, [#68](https://github.com/kontourai/corpus/issues/68)): a number from 0 to 1 survives create, propose, apply, read and update exactly (including `0`, `1`, values that need an exponent, and `-0` read back as `0`); anything else is refused with `MISSING_EVIDENCE` on create, `proposeCreate` and `update` without being clamped; `null` clears it on update; a request-key retry that changes, adds or drops it is `REQUEST_KEY_CONFLICT`; and a purged record, a cascaded record and an erased proposal keep none of it on disk. `confidence-purge-record` and `confidence-purge-proposal` use the `purge-store-bytes` probe.

The original study's non-public vectors and implementation-source citations were excluded. Contract-only replacements cover compiled-source rejection, TTL anchoring, and absolute-expiry precedence. Conflicting alternatives were replaced with the decisions above. Storage fault and read-facade vectors still require adapter-specific harnesses; their expectations are not waived.

```js
import { runConformance } from '@kontourai/corpus-conformance';
const report = await runConformance(async (vector) => {
  const adapter = await openFreshStore();
  return { adapter, dispose: () => adapter.close(), specials: storageProbes };
});
if (!report.passed) throw new Error(JSON.stringify(report.results));
```

Each vector has a scope. Most are store vectors (no `scope` field, or
`"scope": "store"`), which a store adapter must pass alone. A vector with
`"scope": "host"` needs host-owned behavior, such as search over the working
set, that a store library does not implement. The package exports `vectors`
(all), `storeVectors` and `hostVectors`, plus `vectorScope(vector)`, which
throws on an unknown scope. A store package qualifies with
`runConformance(factory, { cases: storeVectors })`; a host that mounts a store
runs every vector, including `hostVectors`, through its own surfaces. An
unknown `scope` value fails at import.

The factory runs once per vector and must provide an isolated store. Adapter calls use the public method names and arguments in `vectors.json`; `create` returns an id string. Errors expose their contract code as `error.code`. Results are cloned when saved so later mutations cannot rewrite earlier observations. `cases` optionally selects vectors; report that selection when claiming conformance.

A factory may return the adapter directly, or `{adapter, dispose, specials}`. Special probes receive `{adapter, operation, values}` and return saved observations (usually `{check: true}` after their own assertions). The runner implements TTL anchoring and short-prefix resolution itself. Other probes must perform the real storage action and assert the cited contract: front-matter separation; purged content and its digests absent from every stored byte and path (`purge-store-bytes` runs `present`, `absent` and `rebuilt` modes, and `present` must see the content so the scan is proven to reach it); journal erasure and rollback of an interrupted purge; reindex after lost/corrupt/idempotent indexes; preserving future fields; legacy label sanitation; concurrent creates/updates; interrupted writes; traversal and physical-id collision prevention; symlink refusal; graph integrity; identity paths; and real writable population for read-facade fixtures. `read-fixture` returns `a` and `b` ids, honoring `operation.retired`.

Missing methods/probes, malformed expected entries (neither `equals`, `length`, nor `absent: true`), unresolved references, unexpected errors, incorrect results, and cleanup failures all fail the vector. No result from a missing prerequisite counts as success. Providing a probe that returns success without exercising and asserting its contract invalidates conformance evidence.

JSON cannot write `NaN`, an infinity or `-0`, so a vector argument or expected value may be `{"$number": "NaN"}`, `"Infinity"`, `"-Infinity"` or `"-0"`, which the runner replaces with that number anywhere in a value. Any other token fails the vector.

Field-clearing assertions use `absent: true` to distinguish a removed field from a stored null. Embedded body text is literal; vector references are whole argument values only.

## Decision-record vectors

`decision-records.json` (exported as `@kontourai/corpus-conformance/decision-records`) holds vectors for the [decision record format](../../docs/decisions.md), independent of the store vectors and the runner. Each vector is a whole registry: `records` lists each file's `slug` (its name without `.md`), its `markdown` text, its `frontmatter` as JSON (`null` when the block cannot be read), and `expected`, the sorted rule codes it must fail (empty means valid). Relation rules resolve slugs within the vector. A validator that receives parsed fields rather than files can use `frontmatter` and skip the `frontmatter` rule. The rule codes are listed in `rules`; Corpus itself is tested against every vector, every code has at least one rejecting vector, and each of the six secret-shaped literal detectors has a vector that only it refuses. Index freshness and the ADR freeze depend on a repository and are not covered.

Root binding (`root-binding-*`) vectors require a harness `root-binding` probe for `match`, `mismatch`, `alias`, `rescaffold`, `legacy`, and `purge` modes; it must exercise the adapter and host helper against real roots.
