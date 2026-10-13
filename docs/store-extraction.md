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

The Station-only source scan for host document services and vault onboarding
`validateRoot` tests were not ported: those host owners are outside the package.
The 123 ported behavioral tests were executed, not merely copied; round 1 also restores a derived package-wide raw-fs guard. Logger mocks
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

## Initial extraction evidence (before round 1)

EXECUTED on macOS, Node `22.22.2` and `24.19.0`:

- Package-local TypeScript build succeeds, producing ESM and declarations.
- Store suite: 134/134 tests (123 ported behavior tests, 9 codec regressions,
  2 injected-service/observation tests), seven files, on both Node versions.
- Root docs/conformance-runner suite: 138/138 tests on Node 24.
- Built and installed-tarball conformance: all 124 vectors per profile execute;
  104 pass and 20 are the explicitly listed deferred decisions, for both default
  and vault. No unexpected failures or unexpected passes.
- Isolated JS consumer imports all public subpaths, creates/reads both profiles,
  and proves source and storage deep imports are rejected.
- Isolated TS consumer compiles declarations with strict NodeNext and executes
  the emitted JS against the installed package with a real create/read.
- Installed packed docs CLI checks this repository without building docs or
  importing store sources. The installed root has no prepare or build script.
- Packed store SHA-256 on **both** Node versions:
  `e492f8678cfa88bab42789bb76ad28f0d5c54af8028579bc1d8a5d6bf9ae49e6`.
  Store source is identical to extraction commit
  `d71564d361e21dd7a96d02c6d0c29b293296534b`; executable TS pack fixture is
  recorded in `f964bf1f0eee628f6a1cc3fbca235e2c1a3e7421`.
- Docs dogfood and committed-range whitespace checks pass.

EXECUTED fault proofs at clean committed baseline
`d71564d361e21dd7a96d02c6d0c29b293296534b`, Node `24.19.0`:

| Injection | Baseline | Injected | Restored |
| --- | --- | --- | --- |
| Skip injected lock acquisition in the transaction owner | exit 0 | exit 1: subprocess create/update conflicts, failed storage invariants | exit 0 |
| Restore typed YAML loading and remove legacy-dash repair | exit 0 | exit 1: `1.10`, `null`, `true`, `-` fixtures and unknown-text metadata fail | exit 0 |
| Add passing `create-roundtrip` to expected-fail list | exit 0 | exit 1: expected-fail vector passed, remove it from the list | exit 0 |

Each mutation was restored byte for byte, rebuilt, and rerun. The fault driver
asserts a clean tree before and after, writes separate negative logs, and can be
reproduced from a committed worktree with:

```sh
npm run proof:faults --workspace=@kontourai/corpus-store -- <output-directory>
```

The fault driver writes diagnostic receipts to the caller-selected output
directory. CI repeats build, contracts and packed qualification on Linux
Node 22/24. Local results are distinct from hosted CI. No Windows or mixed-host
qualification is inferred from these executions.

## Round 1 corrections

The independent review exposed numeric supersede evidence that the original
empty-log byte fixtures missed. The field inventory is: record strings
(id/type/title/category/status/timestamps/expiry/sentinel), tags/aliases,
provenance strings and source IDs, link target/kind/label, log op/time/agent/note
and supersession rationale/new ID; update evidence fields (string array), link
added evidence (link array), propose/apply/reject/retire/superseded-by evidence
strings; numeric TTL and supersede evidence count. No Station-written boolean
record field exists. Unknown extension scalars follow the orchestrator's lossless
core-schema rule, with source slices retained for unchanged values.

Round 1 also requires explicit lock/coordination options; adds injected host-home
identity rechecks; binds 6 of the 20 expected failures to ref/kind/expected/actual assertions
and 14 to specific error patterns, and adjudicates selected vectors; restores held-owner PID/liveness and raw-fs
publication guards; removes machine-private paths; and hides the existing
internal transaction field from enumeration. Origin main was merged, including
#13's dependency and instruction changes. Package/root CI is rerun after this
merge. Each correction has a targeted negative control recorded below after
execution.

## Round 1 executed qualification

EXECUTED at source revision `9ec0bed` on macOS:

- Node 22.22.2 and 24.19.0: package build and 166/166 store tests.
- Node 24.19.0: 231/231 root tests, including main #13's builtOn gate tests and
  the new public-document path guard.
- Packed JS and strict TS consumers execute successfully on both Node versions.
  TS also rejects missing lock/directory configurations at compile time.
- All 124 vectors per default/vault profile execute against installed tarballs:
  104 pass, 20 expected failures, with no unexpected result. Six are assertion-bound and fourteen are specific-error-pattern-bound. Selected
  vectors receive the same adjudication.
- Packed docs CLI executes without a build, including the merged builtOn gate.
- Both Node versions produce store tarball SHA-256
  `1db0ff939d4caf08adda171d920d17573724e0f26a60df3455e4f57806ce335f`.

EXECUTED negative controls at clean baseline
`862b17c6c5fd53f83790f503dc19e3d1eaec4dd6`, Node 24.19.0:

| Control | Injected regression | Baseline | Injected | Restored |
| --- | --- | --- | --- | --- |
| B1 | Leave numeric supersede count as text | 0 | 1 | 0 |
| B2-read | Disable lossless unknown-scalar conversion | 0 | 1 | 0 |
| B2-source | Drop retained unknown-field source ranges | 0 | 1 | 0 |
| B3 | Restore silent lock/directory fallback | 0 | 1 | 0 |
| M1 | Skip injected writer/observation home-identity rechecks | 0 | 1 | 0 |
| M2-assertion | Excuse a different assertion in a listed vector | 0 | 1 | 0 |
| M2-selected | Bypass expected-fail adjudication for selected vectors | 0 | 1 | 0 |
| M3-publication | Import raw file publication into an adapter | 0 | 1 | 0 |
| M3-owner | Publish parent PID instead of actual lock holder PID | 0 | 1 | 0 |
| L1 | Restore a machine-private path to the public document | 0 | 1 | 0 |
| L2 | Make the transaction field enumerable again | 0 | 1 | 0 |
| L3 | Restore unconditional quoted numeric-field coercion | 0 | 1 | 0 |
| B3-types | Make required coordination options optional in declarations | 0 | 1 | 0 |
| B4-packed-dependency | Drop the merged npm-package-arg dependency from the packed docs CLI | 0 | 1 | 0 |

The derived publication guard was separately proved with the same 0 → 1 → 0
sequence at `9ec0bed`. Each completed control restored the exact original bytes
and confirmed a clean worktree. The first quoted-TTL control was corrected
because removing only the plain-style condition still left core-schema typing
intact; the completed control actually restores the original unconditional
coercion. That diagnostic did not count as successful fault proof.

```sh
npm run proof:round1 --workspace=@kontourai/corpus-store -- <output-directory>
```

These are local execution receipts. Hosted CI status is reported on the PR for
its exact pushed head; local results do not stand in for hosted checks.

## Plan disagreements and limits

REASONED: the brief's extraction-only scope wins over design suggestions for
public storage, capabilities, moving the Station lock, dual vault formats and
immediate semantic convergence. Search vectors remain an expected host-level
failure because retrieval is deliberately outside this library. No ranked
search, hosted CI, mixed Station/standalone lock or deployment qualification is
inferred from the package tests.


## Round 2 policy and data preservation

The current rule replaces round 1's broad source-slice preservation. Only an
unchanged top-level, single-line plain scalar whose core conversion is lossy may
retain its original token, and that token must be valid YAML that re-parses as
the same failsafe string. Collections, block scalars, nested or multiline data
use the normal serializer. Invalid bare-dash text is always quoted. This avoids
copying missing line separators or obsolete indentation into new YAML.

The package preserves parsed values and following keys across updates for
Station-written `|` and `|-`, externally authored `>` accepted by Station,
Kit-style unindented log sequences, and flow collections. Station's serializer
uses `lineWidth: -1` and does not emit folded `>`; the folded fixture therefore
starts with a Station-written envelope and deliberately models an external edit.
`coordinationIdentity` is now mandatory for stores and exact observation; its
factory/recheck shape is validated before directory preparation. Fixed-directory
standalone hosts must also opt in to an explicit identity.

6 of the 20 expected failures are bound to ref/kind/expected/actual, and 14 to
specific error patterns. This is a diagnostic extraction with deferred owner
decisions, not a claim of complete semantic conformance.

Station comparison and negative-control receipts follow once executed at the
committed round-2 baseline.
