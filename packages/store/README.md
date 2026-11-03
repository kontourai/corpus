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
2026-10-13 and 2026-11-02 decisions. A decision not yet implemented is an
explicit entry in [the expected-fail list](test/expected-fails.json), never
silent behavior.

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

- **Purge erases records, and nothing else deletes them.** *(2026-11-02; this
  reverses the earlier rule that no operation deletes a record.)* `purge(ids,
  {agent, rationale, note?})` is an explicit, audited, privileged operation, and
  supersede stays the default for ordinary change. The owner's conditions: it is
  explicit and audited, it is privileged, supersede remains the default, and the
  tombstone keeps no plain content hash.

  - **Privileged.** The store cannot tell who may erase. `purge` is on a separate
    type, `KnowledgeStorePurger`, and an adapter refuses it with `READ_ONLY`
    before any I/O unless the host built it with `allowPurge: true`, which a host
    sets only after its own authorization. `agent` and `rationale` are required.
    Both are kept in the log, so neither may carry the erased content.
  - **Targets.** Exact record ids only, never aliases or prefixes. Every id must
    exist (`NOT_FOUND`) or nothing is written. Purging a tombstone again is a
    no-op that reports it in `alreadyPurged`.
  - **Tombstone.** Each target and each cascaded record is rewritten in place
    with `status: purged`. It keeps `id`, `type`, `created_at`, provenance
    (`agent`, `session_id`, `source_ids`), link targets and kinds, and its
    mutation log reduced to `op`, `at`, `agent` plus identity references. It ends
    with a `purged` entry holding `agent`, `rationale`, `note` and the cause:
    `requested`, or `sole-support-purged` with the support (`via`) that went. It
    drops title (now `[purged]`), body, tags, aliases, expiry, link labels,
    provenance `note`, the free-text log fields (`note`, `rationale`, proposal
    and reason text, link labels) and every unknown frontmatter field. Its
    category becomes `purged`, because a category path can name a data subject.
    **No content hash is kept**, not even of the title: for short content a hash
    lets anyone holding the tombstone confirm a guess. A keyed integrity
    reference may be added by a later, owner-approved change; today there is
    none. Surface#351 calls this retention state `deleted`; the stored
    `status: purged` is the same fact, and the id, provenance and `purged` entry
    are the erasure trace it asks for.
  - **Cascade.** A record's support is `provenance.source_ids` plus the targets of
    its `source` links. `related`, `proposes` and `supersedes` links are
    references, not support. A record is *affected* when a chain of support
    reaches a requested id. An affected record is tombstoned unless it still has
    real support: an id that is not a record in the store (an outside
    conversation id, say), a record the purge does not reach, or an affected
    record that itself survives. This is a least fixed point, so the cascade is
    transitive, and affected records that only support each other fall together
    instead of holding each other up. A record the purge does not reach is left
    alone, whatever its own support looks like.
  - **Survivors.** A record with other support survives untouched except for two
    things. Its log gains a `support-purged` entry (`agent`, `rationale`, the
    purged ids), and the labels of its links to erased records are dropped,
    because a label can repeat the erased title. A record that only links to an
    erased record gets the same label change and a `reference-purged` entry.
    `PurgeResult` lists `purged`, `cascaded`, `survivors`, `referrers` and
    `alreadyPurged`. The store does not scrub survivor *content* that may
    reproduce erased content; review those ids. Surface#351 splits the work the
    same way: the store represents the erasure, the producer removes
    reproductions.

    In a vault, a survivor or referrer is re-rendered and gains a log entry, which
    can grow a note that already sits near the vault note limit (16 MiB, see the
    note-limit decision), and every note a purge writes is held to that limit
    because a note over it breaks each later `create`. A survivor is the host's
    content, so the purge never shortens it: it first tries the entry without its
    `rationale` and `note` (`compact: true`), and if even that does not fit it
    refuses the whole purge with `MISSING_EVIDENCE`, names the record, and writes
    nothing, so the erasure waits until the host shrinks that note. A tombstone is
    different, because nothing the host does to a record changes what the
    tombstone must keep, and erasure must always be possible. A tombstone that
    would pass the limit (a note made mostly of provenance ids) falls back to a
    `purged` entry without `via` and with the rationale cut to 256 bytes as JSON
    (`compact: true`, and `rationale_truncated` and `rationale_bytes` when it was
    cut), and then to identity plus that entry with the rationale cut to 64 bytes
    and counts of what it dropped (`omitted_source_ids`, `omitted_links`,
    `omitted_log_entries`). In that last shape an agent, session id, `type` or
    `created_at` over 256 bytes as JSON is replaced (`[omitted]`, dropped, or the
    purge time) and counted (`omitted_agent_bytes`, `omitted_session_id_bytes`,
    `omitted_type_bytes`, `omitted_created_at_bytes`). A rationale is therefore
    never empty, so a consumer that needs a reason for the erasure always has
    one. The default layout has no such limit and always writes the full
    tombstone. **This is a narrow departure from "a tombstone keeps provenance,
    links and a purge entry", made so that erasure is not blocked**: it applies
    only when the full tombstone would exceed 16 MiB or cannot be written (the
    YAML writer overflows its stack on a multi-megabyte field), which needs a
    note made mostly of metadata, and what was lost is counted in the entry. A record id cannot be dropped, and the vault does not cap it as the
    default layout does ([#58](https://github.com/kontourai/corpus/issues/58)),
    so a purge of a record whose id alone fills the limit is still refused. The
    owner may prefer to refuse every such purge instead; that is a one-line
    change in `fittingTombstone`. Whether a consumer such as Surface needs a
    different bounded rationale is tracked in
    [#57](https://github.com/kontourai/corpus/issues/57).
  - **A tombstone is permanent and read-only.** `update`, `link`, `propose`,
    `apply`, `reject`, `supersede` and `retire` refuse it with `PURGED`, so do
    new `source` links, `source_ids` and compiled sources that name it, and its
    id cannot be created again. `get` returns it and `getLinks` keeps its link
    ids; lists treat it as history, so only `includeHistory: true` returns it,
    with no content.
  - **Create proposals.** A proposal holds its whole candidate in every state, in
    `.corpus-proposals/`, so a purge erases proposals itself. A proposal's support is
    its candidate's `provenance.source_ids` plus its `source` links, as for a record.
    One that rests only on erased records (support that is non-empty, entirely erased
    and including one this purge erases) is erased; a pending one is also settled as
    `rejected` by the purging agent with the purge's rationale, so it can never apply
    (`proposalsRejected`). An applied proposal is erased when the record it created
    is purged, and a rejected one when it rests only on erased records
    (`proposalsScrubbed`, which includes the rejected ones). Erasing keeps `id`,
    `state`, `proposer_id`, `evidence.agent`, the settlement identity and times, the
    candidate's type, provenance and link targets, and `record_id`; it replaces the
    title, body, category and `evidence.proposal` (and a settled rationale) with
    `[purged]`/empty, drops tags, aliases, expiry and link labels, and adds
    `erasure` (`at`, `agent`, `rationale`, `note`). A pending proposal with support
    left stays pending and is listed as `proposalsBlocked`: `applyCreate` refuses it
    with `PURGED` because its candidate still cites an erased record, and a reviewer
    should reject it. `proposeCreate` refuses such a candidate up front, and also a candidate whose
    provenance (`agent`, `session_id`, `note`, `source_ids`) or links hold anything but text,
    or a link has an empty `target_id` or `kind` (the reader refuses such a record;
    [#56](https://github.com/kontourai/corpus/issues/56) tracks `create` itself)
    (purge reads them to decide what rests on what, and `create` would quietly turn a
    number into text), so no accepted proposal can stop a later purge. The
    log entry a created record starts with keeps `proposal_id` but never the
    proposal's text once the record is erased. A candidate's own `id` is not removed
    from its support (it is not a record yet, so it counts as real support until a
    record has it). A proposal whose stored shape purge cannot judge (unreadable,
    a candidate without valid provenance or links, an `erasure` marker over intact
    content) stops the purge before anything is written. Because a pending
    proposal's rejection copies the purge's `agent` (twice), `rationale` (twice) and
    `note` into it, those are bounded as JSON: `agent` 1 KiB, `rationale` and `note`
    8 KiB each (a control character is six bytes in JSON), which fits the 64 KiB a
    stored proposal reserves for settlement.
  - **Read paths and projections.** The slug aliases leave the alias index, the
    graph index rebuilds from tombstone links, and `reindex` reproduces the same
    result. In the vault the file moves to `archive/purged/<id>.md` (so the path
    index is never empty after a purge, and a vault whose only record was purged
    still opens, lists and reindexes; the empty-vault rule of
    [#50](https://github.com/kontourai/corpus/pull/50) never applies to it), the path
    index loses the title slug, category folders the purge emptied are removed,
    and every record that linked to it is re-rendered, so no generated `[[link]]`
    section still names the erased title. The `dimensions` frontmatter is not written to a tombstone.
  - **Recoverable publication.** The transaction journal holds base64
    before-images of every file it touches so an interrupted write can roll
    back. For a purge, the commit marker drops them, so a journal left by a
    crash after the commit marker holds no erased content. A purge does not
    report success while its journal may still hold them: if the commit marker
    cannot be written, it removes the journal or throws. The next locked
    operation also removes a `.<id>.tmp` file that a crash inside the journal's
    own write left at the root, even a cut-short one, but only one that starts
    the way this engine writes a journal (a stray file with exactly that start
    would be removed too). A failure to remove it fails the operation, so a store
    stays unavailable until the file can be deleted. Emptied folders are removed
    best effort after the commit, and a path component that is a symlink stops
    the removal; as with the engine's other path checks, this assumes nothing
    else swaps a store folder for a symlink in the moment between the check and
    the removal, which the store lock cannot prevent.
    *Deferred:* between
    the first journal write and the commit marker the journal still holds the
    pre-purge files, because rollback needs them. A crash in that window leaves
    them on disk until the next locked read recovers it, and unlinking a file is
    not secure erasure. `purge-journal-in-flight` records this on the
    expected-fail list. Closing it needs a roll-forward journal, which is a
    separate change to the transaction engine.
  - **Migration artifacts.** A vault that still holds `.corpus-store-migration/`
    keeps the original Kit index (every path, so every title slug and category)
    and a sha256 of every file. `purge` refuses such a vault with `READ_ONLY`
    until the host deletes that directory, which it should do once the migration
    is verified. After a purge, `--reverse` could not run anyway.
  - **Not covered.** Copies outside the store's transaction: backups, a
    filesystem snapshot, and search or vector indexes a host built from
    `get`/lists (the host must rebuild them from the working set).

- **A vault note is limited to 16 MiB.** The vault reads each note with a
  16 MiB bound (`VAULT_NOTE_MAX_BYTES`, 16777216 bytes) when it checks a new
  record's identity, so a larger note would make every later `create` fail.
  `create` and `applyCreate` therefore refuse a record whose serialized note
  (frontmatter plus the rendered body; a `raw` body grows by the callout
  quoting) exceeds it, and `proposeCreate` refuses such a candidate up front.
  The refusal is `MISSING_EVIDENCE`, and nothing is written: a refused
  `applyCreate` leaves the proposal `pending`. `proposeCreate` sizes the note as
  `applyCreate` would write it, including the first mutation-log entry with the
  proposal's evidence, so large evidence counts. What is only known at apply
  is stood in for by its largest form (the reviewer id with the largest YAML
  expansion, the longest proposal id), and a link to the record itself renders
  as its file name. In the tested cases the estimate was never below the
  applied note and ran about 4 KiB above it for a plain reviewer, so a
  candidate that close to the limit can be refused by `proposeCreate` that
  `create` would accept. It is a margin, not a proof: a custom id generator
  with ids longer than a UUID, a link that names the id `create` will generate,
  or another record taking or renaming a destination or link target between
  propose and apply, can still move the applied note. `applyCreate` is the authoritative check: a
  proposal that passed can still be refused there for size, and then stays
  `pending`. Only creation is checked: `update` and the other writes are
  unchanged.

- **A new record can be proposed, then applied or rejected (2026-11-03).**
  Decided by the delivery orchestrator under the owner's standing direction to
  deliver flow-agents#669–#673 ([corpus#40](https://github.com/kontourai/corpus/issues/40));
  the owner may override it.
  - `proposeCreate(candidate, proposerId, evidence, { requestKey }?)` stores a `pending`
    proposal that carries the whole candidate (a `CreateInput`, provenance
    included) and `evidence` (`agent` and `proposal`, as for `propose`). It
    returns the proposal id. The candidate must have the fields `create` requires.
    **No record exists until apply**: `get` and every list return nothing for it.
  - `applyCreate(proposalId, reviewerId)` creates the record in one transaction with
    every `create` requirement, so a refusal (a source-less `compiled`
    candidate, a taken id or slug) leaves the proposal `pending` and writes
    nothing. It returns the new record id. The record's first mutation-log entry,
    `apply-create`, names the proposal, its proposer and its evidence, and the
    proposal records `record_id`. A reviewer who is the proposer is refused with
    `SELF_APPROVAL`; the identity is the `proposerId` string, so a host that
    needs more than self-comparison must authorize reviewers itself.
  - `rejectCreate(proposalId, reviewerId, rationale)` keeps the proposal as
    `rejected` with its rationale and creates nothing. A proposer may reject
    (withdraw) its own proposal. Only a `pending` proposal can be applied or
    rejected; a settled one is refused with `MISSING_EVIDENCE`.
  - Proposals are stored under `<storeRoot>/.corpus-proposals/`, outside every record
    path, index and list, so pending and rejected proposals are never in the
    working set, `get`, `getLinks` or `reindex`, with or without `includeHistory`.
    The directory's dot name cannot be a category, so a vault may still keep
    notes in a `proposals` category. The vault's record-identity scans do not
    count or read the `.json` files there, so retained proposals never reach
    their entry bounds; anything else placed in that directory is still scanned.
    A proposal over 16 MiB (less headroom for settlement), with blank evidence, or
    with an explicit id or a reviewer id over 1 KiB or a rationale over 16 KiB, is refused, so no
    accepted proposal can break `listProposals` or be left unsettleable. The size
    of the note the record becomes is checked too, as for `create` (see the vault
    note limit above): `proposeCreate` refuses a candidate that would exceed it.
    Read them with `getProposal(id)` and `listProposals({ state })`, where `state`
    is `pending`, `applied`, `rejected` or a list of them (omitted means all).
  - The create-proposal verbs are separate from the concept-proposal `apply` and
    `reject`, which take `(targetId, proposerId, evidence)` and are unchanged.
  - **The store discovers no root.** The host constructs the adapter over the
    root it authorized. A CLI default remains a CLI concern. A vault opened
    read-only (`kit-v1`) refuses `proposeCreate`, `applyCreate` and `rejectCreate`
    with `READ_ONLY`.
  - `purge` reaches proposals; see the purge decision above.

Every decision is implemented except the journal window named in the purge
decision, which is the single entry on the expected-fail list.

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
  exceeded scan bound also refuses. `reindex` on a root with no records writes
  the empty `path-index.json` beside the derived indexes it rebuilds, so the
  vault stays openable (it holds no records, only pending proposals at most);
  an existing path index is never rewritten by `reindex`.

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

- `@kontourai/corpus-store`: constructors, record/evidence/interface types
  (including `KnowledgeStorePurger`, `PurgeEvidence` and `PurgeResult`), service
  option types (including `allowPurge`), reindex result type and standalone lock.
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

### Owner decision: create request keys (2026-11-03)

The delivery orchestrator, under owner direction (owner may override), decided in [#45](https://github.com/kontourai/corpus/issues/45) that `proposeCreate(candidate, proposerId, evidence, { requestKey })` optionally deduplicates retries. Matching input returns the original proposal ID in pending, applied or rejected state; different input fails with `REQUEST_KEY_CONFLICT` without writing. The key identity and input digest share the proposal transaction. The owner decided that erasure removes the content digest and every later use of that key is refused with `REQUEST_KEY_CONFLICT`, regardless of input; the retained key identity prevents reuse. The shared proposal-write seam also sets `request_key_retired: true` and removes the digest when a partial scrub changes the candidate or evidence. Real purge integration and retry ordering are covered by conformance vectors; key lookup precedes the purge source guard. Completed full and partial scrubs remove the prior content digest; the separate in-flight purge journal limitation above still applies. A caller that loses a response retries with the same key. Omitting the key retains the original behavior. Keys must be well-formed Unicode strings, not empty or whitespace-only, and at most 1024 UTF-8 bytes.

Request keys are scoped to the whole store, not the proposer: callers sharing a store should namespace their keys and use opaque keys that do not encode content. The stored key hash is unsalted and can reveal a guessable key. Keyed requests scan retained proposals under the mutation lock, so lookup cost grows with proposal count. A corrupt proposal causes keyed requests to fail closed because the store cannot establish whether the key is unused. Digest version 1 identifies the candidate projection and canonicalization; future changes must preserve retry comparison for stored versions.

### Owner decision: structured source references (2026-11-03)

The orchestrator decided in [#46](https://github.com/kontourai/corpus/issues/46), subject to owner override, that optional `provenance.source_refs` carries attribution only. It neither authorizes reading `transcript_ref` nor constitutes review evidence; `note` remains free text and must not be parsed. The currently validated kind is `session-transcript`: `harness`, `session_id`, and `transcript_ref` are required, `sitting_id` and `range` are optional. A range is an inclusive one-based `{ start, end }` line range. Unknown fields and kinds are refused. Strings are nonempty and at most 4096 UTF-8 bytes; at most 256 references are accepted. An empty array is preserved as supplied; optional fields set to `undefined` are treated as absent. The kind registry can grow through a future validated contract change. References can identify sensitive resources; they do not grant access. Real-purge conformance and integration tests verify their removal from purged records and erased proposals; the separate in-flight purge-journal limitation remains.

### Owner decision: adapter root binding (2026-11-03)

The orchestrator decided in [#47](https://github.com/kontourai/corpus/issues/47), subject to owner override, that each bundled adapter exposes `rootBinding()` and a host may call `assertAdapterBoundTo(adapter, root)` to compare it with its authorized root. A mismatch throws `ROOT_BINDING_MISMATCH`. The binding hashes the canonical root path and a random identity marker (`.corpus-root-id`) scaffolded in the root. Symlink aliases resolve to the same binding; a newly scaffolded root at the same path has a different identity. A pre-created empty directory is also unmarked and requires initialization. For a legacy root without a marker, initialization is explicit: call `await initializeRootBinding(storeOptions)` and construct a new adapter. Opening an unmarked or malformed legacy root does not modify its marker; binding checks fail closed while record reads remain available. Initialization is an explicit host-authorized write, including on a kit-v1 vault, and does not migrate that vault or enable its record mutations. Concurrent first constructors may observe an unbound root during marker publication. Call `initializeRootBinding(options)` to complete or recover scaffolding, then reconstruct the adapter before binding it. Initialization publishes without replacing an existing marker and can remove a matching scaffold temporary left by a crash. The helper only compares identity: the host owns root authorization and tenancy, and Corpus performs no ambient discovery.
