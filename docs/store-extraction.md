# Store extraction evidence

This package-only change implements adjusted phase 3 steps 1–2. It does not
publish, merge, migrate consumers or apply the deferred owner decisions.
Station source: `2479f38b1ab062e2d9cd6df9f8fa2cdbeee1d136` (`origin/main`).
Corpus base: `8e82ec4` (`origin/main`).

## Module mapping

Paths at left are under Station `src-server/knowledge-store/`.

| Station source | Corpus destination |
| --- | --- |
| `adapters/default-store.ts` | `packages/store/src/default-store.ts` |
| `adapters/obsidian-store.ts` | `packages/store/src/obsidian-store.ts` |
| `adapters/shared/category.ts` | `packages/store/src/shared/category.ts` |
| `adapters/shared/freshness.ts` | `packages/store/src/shared/freshness.ts` |
| `adapters/shared/frontmatter.ts` | `packages/store/src/shared/frontmatter.ts` |
| `adapters/shared/graph-index.ts` | `packages/store/src/shared/graph-index.ts` |
| `adapters/shared/identity.ts` | `packages/store/src/shared/identity.ts` |
| `adapters/shared/record-schema.ts` | `packages/store/src/shared/record-schema.ts` |
| `adapters/shared/wikilinks.ts` | `packages/store/src/shared/wikilinks.ts` |
| `adapters/shared/file-transactions.ts` | `packages/store/src/shared/file-transactions.ts` |
| `adapters/shared/observation-file.ts` | `packages/store/src/shared/observation-file.ts` |
| `errors.ts` | `packages/store/src/errors.ts` |
| `adapters/__tests__/contract-suite.ts` | `packages/store/test/contract-suite.ts` |
| `adapters/__tests__/default-store.contract.test.ts` | `packages/store/test/default-store.contract.test.ts` |
| `adapters/__tests__/obsidian-store.contract.test.ts` | `packages/store/test/obsidian-store.contract.test.ts` |
| `adapters/__tests__/file-transactions.test.ts` | `packages/store/test/file-transactions.test.ts` |
| `adapters/__tests__/persistence-corruption.test.ts` | `packages/store/test/persistence-corruption.test.ts` |
| `adapters/__tests__/wikilinks.test.ts` | `packages/store/test/wikilinks.test.ts` |
| `adapters/__tests__/fixtures/knowledge-file-transaction-child.ts` | `packages/store/test/fixtures/knowledge-file-transaction-child.ts` |

Additional seams: Station `packages/contracts/src/knowledge-store.ts` record,
evidence, error and adapter interfaces → `packages/store/src/contracts.ts`;
`src-server/knowledge-index/path-safety.ts` predicate → `src/path-safety.ts`;
`src-server/utils/is-record.ts` predicate → `src/is-record.ts`. Root registry,
provider and descriptors stay host-owned. `services.ts`, `standalone-lock.ts`,
`index.ts` and `observation.ts` compose/export the extracted owners.

The Station-only source-scan test for host document services and vault onboarding
`validateRoot` tests were not ported: those host owners are outside the package.
All 123 remaining behavioral tests are executed, not merely copied. Logger mocks
become injected diagnostics; transaction fixtures receive an isolated coordination
directory. The Station lock itself is neither copied nor moved.

## Conformance interpretation

The runner executes every public vector for both profiles. It preserves raw
negative results and adjudicates them against the explicit expected-fail list.
Expected failures await versioned working-set/history, expiry, compiled-source,
any-type proposal or host search implementation; they do not mean full semantic
conformance. The list fails on an unexpected pass or wrong failure pattern.

Two existing vector defects were corrected: wikilink body `$b` was a literal,
not an interpolated reference; the fixture now supplies an explicit target ID.
Expiry clearing removes the field, so its assertion now uses `absent: true`
instead of requiring a stored null. The runner tests absence rejection.

Storage probes exercise real subprocess concurrency, crash points (prepared,
first/final publication, commit marker), traversal (including safe opaque-ID
acceptance), physical-ID collisions without indexes/after archival/mismatched
frontmatter, symlink refusal, lost/corrupt derived indexes and disk graph integrity.
The vault path index is authoritative, so derived-index loss probes preserve it.

## Evidence

Execution receipts and fault-injection outcomes are recorded here after the
final implementation is qualified. Local evidence is distinct from hosted CI.

## Plan disagreements and limits

REASONED: the brief's extraction-only scope wins over design suggestions for
public storage, capabilities, moving the Station lock, dual vault formats and
immediate semantic convergence. Search vectors remain an expected host-level
failure because retrieval is deliberately outside this library. No ranked
search, hosted CI, mixed Station/standalone lock or deployment qualification is
inferred from the package tests.
