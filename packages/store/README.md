# Corpus Store

`@kontourai/corpus-store` owns transactional, file-backed mutable records. Its
purpose is to give hosts one implementation of record identity, links,
provenance, mutations and recoverable publication. Immutable docs bundles are
separate. The docs CLI does not depend on this package and needs no build.

The extraction preserved Station semantics at
`2479f38b1ab062e2d9cd6df9f8fa2cdbeee1d136`; its only codec change preserves text
scalars from old Knowledge Kit writers. Later changes implement the owner's
decisions one at a time; see [Owner decisions](#owner-decisions). Version
`0.1.0-next.0` is the first npm candidate, published only after owner bootstrap
and trusted-publisher setup through the
[workspace publish workflow](../../README.md#publishing-the-store-workspaces).

## Owner decisions

The [conformance vectors](../conformance/README.md) encode the owner's
2026-10-13 decisions. A decision not yet implemented is an explicit entry in
[the expected-fail list](test/expected-fails.json), never silent behavior.

- **Proposals may target any record type.** `propose`, `apply` and `reject`
  accept a target of every type, not only `concept`. The target and proposer
  must exist (`NOT_FOUND`), evidence fields are still required
  (`MISSING_EVIDENCE`), and `apply` and `reject` still require the proposer's
  `proposes` link to the target. Mutation-log evidence keeps its stored
  `concept_id` key.

- **Lists return the working set.** `listByType` and `listByCategory` omit
  retired and superseded records unless `includeHistory: true` is passed. Both
  profiles share one predicate: a record is historical when its status is
  `retired`, when it carries a `superseded-by` mutation-log entry, or (vault)
  when its note is archived. `implemented` records stay in the working set.
  The vault's history walks archived notes. `includeRetired` is a deprecated
  alias, translated to `includeHistory: true`, so it now also returns superseded
  records; removing the alias is a separate, owner-approved change. `get` and
  `getLinks` always reach history.

- **One expiry rule and an expiry-only stale filter.** A record expires at its
  explicit `expires_at`, otherwise `ttl_seconds` after `created_at`; a record
  with neither never expires. The TTL anchor is creation, so an update never
  extends it, and a record is expired from its expiry instant onward. List
  option `stale: true` keeps only expired records and `stale: false` only
  unexpired ones; without `stale` there is no expiry filter. `now` (epoch
  milliseconds) defaults to the injected `clock`. A non-boolean `stale` or a
  non-finite `now` is refused with `MISSING_EVIDENCE`. The filter composes with
  the working set. This is record expiry only: no `stale` status is stored,
  and maintenance age and trust freshness are separate signals.

- **A compiled record must link a raw source when it is created.** `create`
  with `type: 'compiled'` requires at least one link of kind `source` to an
  existing `raw` record; otherwise it throws `MISSING_EVIDENCE` and writes
  nothing. `provenance.source_ids`, `related` links and body wikilinks do not
  count. Only creation is checked: existing compiled records without a source
  stay readable, listable and updatable.

Every decision is implemented, and the expected-fail list is empty.

## Host composition

```js
import { KitDefaultStoreAdapter, KitObsidianStoreAdapter } from '@kontourai/corpus-store';
const store = new KitDefaultStoreAdapter({
  storeRoot: '/private/records',
  coordinationDirectory: '/private/host/coordination/knowledge-file-transactions',
  lock: hostFileMutationLock,
  coordinationIdentity: hostCoordinationIdentity,
  clock: () => Date.now(),
  ids: () => crypto.randomUUID(),
  diagnostics: { warn(message, fields) { console.warn(message, fields); } },
  transactionObserver(operation, outcome) { /* host metrics */ },
});
const id = await store.create({
  type: 'raw', title: 'Source', body: 'Observed content', category: 'engineering',
  provenance: { agent: 'operator' },
});
await store.get(id);
```

Vault construction uses `KitObsidianStoreAdapter` with the same options plus
optional `sourcesDir` (default `sources`). Constructors prepare directories;
locked reads may repair derived indexes or recover a journal. Lists return the
working set; `includeHistory: true` adds retired and superseded records, and
category lists also take `prefix` (see [Owner decisions](#owner-decisions)).
Retired and superseded records are always gettable. Vault superseded files move
to `archive/`. Lists also take an expiry filter, `{stale, now}`. No search,
capabilities object or public storage API is claimed by this package.

The lock function has Station's `FileMutationLock` shape:
`(lockPath: string) => release | Promise<release>`, where release returns void or
Promise<void>. Station keeps its own implementation. All three of `lock`, `coordinationDirectory` and `coordinationIdentity` are required. Opening without them, or with an identity factory that does not return a recheck, throws before filesystem I/O. Every cooperating writer
must inject the same lock protocol and coordination directory. Pass the final
private directory, not a host home path. The package preserves the hashed
realpath/device/inode `.lock` name and `.station-knowledge-transaction.json` v1
journal, including recovery and publication ordering.

The explicitly selected `standaloneFileMutationLock` is **standalone only and does not
interoperate with Station's lock**. It uses a filesystem bakery directory at the
lock path, unique PID/UUID participants and atomic ticket publication, waiting
for live owners and ignoring dead processes. Every host supplies its own absolute private coordination directory; omission is rejected. It is intended for
same-host processes on a local filesystem. PID reuse can conservatively delay
acquisition until timeout. Inject the host services for shared stores; no mixed
Station/standalone co-writer qualification is claimed.

Diagnostics and transaction observer exceptions cannot change storage outcomes.
Host roots, tenancy, authorization, notifications, HTTP/MCP and retrieval remain
host responsibilities. `provenance.agent` records attribution, not authority.

## Codec and format

The reader preserves Station's known string fields and reads its numeric fields
(`ttl_seconds`, supersede evidence `superseded_count`) as numbers only when the
source scalar is unquoted. Quoted numeric TTL remains corruption, matching
Station. Unknown fields use core-schema types when conversion is lossless: `3`,
`true` and `null` become number, boolean and null; `1.10` and a bare `-` remain
text. Unknown quoted strings stay strings.

The codec retains original tokens only for unchanged, top-level, single-line
plain scalars whose core-schema conversion would be lossy (`1.10`, `1e3`,
`0x10`, `~`). Every retained token must re-parse as the same string under the
package's failsafe scalar reader. Invalid legacy text such as a bare `-` is
quoted. Block scalars, flow collections, sequences, mappings, nested fields and
multiline text go through normal serialization from their parsed values. No
collection fragments are copied into a different indentation context. Station's
serializer remains the writer for changed fields and new records. Station-written
fixtures include all mutation evidence shapes and round-trip byte for byte.

Default layout: `records/<id>.md`, `graph-index.json`, `alias-index.json`.
Vault layout: category-routed notes, `people/`, archives, `path-index.json`,
`graph-index.json`, `alias-index.json`, and collision-safe body sentinels.
Graph and alias indexes can be rebuilt; vault path mappings remain authoritative.

## Vault index and migration

`path-index.json` is the canonical vault path index. The vault adapter selects
the index on every operation:

- `path-index.json` alone: the vault is read and written normally.
- `.graph-index.json` alone (`kit-v1`, written by the Knowledge Kit's vault
  adapter, with the same payload): the vault opens **read-only**. Reads work;
  every mutation, including `reindex`, throws `READ_ONLY` and names
  `corpus-store migrate`.
- Both files: refused as a conflict (`KnowledgeStoreCorruptionError`); the
  package does not choose one.
- Neither file: an empty root, or one with only plain notes, opens as a new
  vault. A root that already holds store data (a `graph-index.json` or
  `alias-index.json`, or a markdown note whose frontmatter has an `id` or a
  `type`) is refused rather than read as empty. Unreadable frontmatter or an
  exceeded scan bound also refuses.

The package's `corpus-store` bin converts a `kit-v1` vault offline:

```sh
corpus-store migrate <vault-root> --check     # validate and report; changes no vault file
corpus-store migrate <vault-root>             # convert, then verify
corpus-store migrate <vault-root> --reverse   # restore the Kit index
```

Stop every writer first. The migration's lock (by default under
`<vault-root>/.corpus-store-migration/coordination`, or
`--coordination-directory <dir>`) only excludes other migration runs. `--check`
creates only that lock directory. It
validates the Kit index as exact mappings (consistent `by_id`/`by_path`,
contained paths, `archived` matching an `archive/` location, every note present
with that frontmatter `id`) and refuses with every problem listed if any check
fails. In one journaled transaction of the store's own transaction engine it
hashes every other file under the root, saves the original index as
`.corpus-store-migration/kit-v1-path-index.json`, writes
`.corpus-store-migration/manifest.json`, writes `path-index.json` with the same
mappings, and removes `.graph-index.json`. It then re-hashes every file, opens
every indexed record through the vault adapter, re-hashes again, and marks the
manifest `verified`.

If the process stops after committing the conversion, rerunning `migrate`
resumes verification against the recorded hashes and leaves the manifest
`migrated` on refusal. `--check` refuses an incomplete verification and directs
the caller to rerun the conversion command. A verified migration remains
`already-migrated` even after ordinary store writes.

Only the index file changes; markdown files the Kit index
did not list (for example a default store's `records/` sharing the root) are
listed in the manifest and left alone. `--reverse` restores the saved index only
while `path-index.json` and every hashed file are byte-for-byte as the manifest
recorded, so it never overwrites a later edit. stdout is one JSON result,
including the manifest's sha256; exit 0 means success or nothing to do, 1 a
refusal, 2 a usage error.

## Public exports

The vault constructor accepts `dimensions`, an ordered list of names for category
segments after the domain. For example, `['territory', 'customer', 'initiative']`
projects `sales.east.acme.renewal` as those three frontmatter fields. Each write
recomputes them from `category`; shortening a category removes obsolete fields.
They stay out of returned records. Names must be unique identifiers and may not
replace record fields. Omit the option to preserve ordinary unknown frontmatter.

- `@kontourai/corpus-store`: constructors, record/evidence/interface types,
  service option types, reindex result type and standalone lock.
- `@kontourai/corpus-store/errors`: the unchanged domain and persistence error
  constructors/classifier. Persistence errors do not gain new codes here.
- `@kontourai/corpus-store/observation`: construction-free bounded filesystem
  observation, including `observeExactKnowledgeRecordFile(root, coordinationDirectory, exactId)`.
  It refuses journal/lock artifacts and returns a recheck; hosts must retain
  non-atomic/unknown-transaction semantics and enforce authorization separately.
- `@kontourai/corpus-store/package.json`: metadata.
- `corpus-store` bin: `migrate`, described in
  [Vault index and migration](#vault-index-and-migration).

Deep source/dist imports and `/storage` are not exports. ESM only, Node >=22.
Runtime dependency: js-yaml, retained for Station-identical writing.

## Development and evidence

The development harness pins Vitest 4.1.11. Vitest and its mock/worker tooling
are development dependencies; the published store runtime does not depend on
them. The lockfile retains the existing Vite and Rollup versions. Build the
store before testing or packing so consumers exercise compiled entry points.

```sh
npm ci
npm run build --workspace=@kontourai/corpus-store
npm run test --workspace=@kontourai/corpus-store
npm run conformance --workspace=@kontourai/corpus-store
npm run verify:pack --workspace=@kontourai/corpus-store
```

Builds emit package-local ESM JS and declarations. No root prepare/build step
is added. Pack verification installs tarballs in isolated JS and TS consumers,
checks exports and declarations, executes every store conformance vector on
both profiles against installed code, and runs the installed docs CLI without a
build. CI runs this on Node 22 and 24.

[The expected-fail list](test/expected-fails.json) is keyed by public vector ID,
profile, deferred owner decision and either an exact failing assertion or a specific error pattern. Unknown failures,
missing probes and listed vectors that pass fail the run. Vectors with
`"scope": "host"` (today only `search-working-set`) need search, which this
package does not implement: the runner skips them, refuses to select them, and
fails if the expected-fail list names one. Every host that mounts this store
must run `hostVectors` from `@kontourai/corpus-conformance` and pass them. [The extraction record](../../docs/store-extraction.md)
contains source mapping and executed evidence. The ported transaction suite
retains internal crash hooks; the conformance crash subprocesses use those
existing internal hooks without adding a public storage seam.

## Coordination identity

Every host supplies `coordinationIdentity`, a factory that
captures that home and returns a recheck. It must validate the home with
`observeDirectoryChain(home)` (including strict realpath/no-symlink checks),
then reject if the current runtime-home resolver returns a different absolute
path. The package calls the captured recheck before transaction I/O. Pass the
same factory as the fourth argument to
`observeExactKnowledgeRecordFile(root, coordinationDirectory, id, coordinationIdentity)`;
its returned recheck repeats the home/namespace check before returning source.
Filesystem identity checks alone cannot detect a host resolver selecting another
home, so hosts with that policy must inject the resolver check. Standalone hosts
with a fixed directory must explicitly provide a factory that captures and
rechecks their selected private parent directory (which must exist before opening). No Station home resolver is imported.


For example, a standalone identity can use the public observation helper:

```js
import { observeDirectoryChain } from '@kontourai/corpus-store/observation';
const coordinationIdentity = () => observeDirectoryChain('/private/host');
```

The same identity is required on the construction-free observation port. Hosts
with a runtime-home resolver must additionally check that resolver against the
captured home. Record data remains identical on re-read; whitespace/style may
normalize except for the approved top-level lossy plain tokens.
