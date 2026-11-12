# Corpus Store

`@kontourai/corpus-store` owns transactional, file-backed mutable records. Its
purpose is to give hosts one implementation of record identity, links,
provenance, mutations and recoverable publication. Immutable docs bundles are
separate. The docs CLI does not depend on this package and needs no build.

The extraction preserved Station semantics at
`2479f38b1ab062e2d9cd6df9f8fa2cdbeee1d136`; its only codec change preserves text
scalars from old Knowledge Kit writers. Later changes implement the owner's
decisions one at a time; see [Owner decisions](#owner-decisions). Version
`0.1.0-next.5` is intended for the `next` npm dist-tag through the
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

- **Erase a record with `purge`; erase a proposal with `purgeProposal`.**
  *(2026-11-02; this
  reverses the earlier rule that no operation deletes a record.)* `purge(ids,
  {agent, rationale, note?})` is an explicit, audited, privileged operation, and
  supersede stays the default for ordinary change. The owner's conditions: it is
  explicit and audited, it is privileged, supersede remains the default, and the
  tombstone keeps no plain content hash.

  - **Privileged.** The store cannot tell who may erase. `purge` is on a separate
    type, `KnowledgeStorePurger`, and an adapter refuses it with `READ_ONLY`
    before any I/O unless the host built it with `allowPurge: true`, which a host
    sets only after its own authorization. `agent` and `rationale` are required.
    The agent, rationale and note are retained as audit evidence: never put erased text in them.
  - **Targets.** Exact record ids only, never aliases or prefixes. Every id must
    exist (`NOT_FOUND`) or nothing is written. An identifiable proposal id gets
    a `purgeProposal` hint under the same code. Purging a tombstone again is a
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
  - **Cascade.** Erasing a source also erases affected records that have no other
    remaining support. Records with other support stay; review them for leftover text.
    `cascaded` lists records erased with the requested records; `survivors` lists
    records kept because they have other support. A record's support is `provenance.source_ids` plus the targets of
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
    can reject it to prevent application, but rejection leaves its text stored. Use
    `purgeProposal` if that text must be erased. `proposeCreate` refuses such a candidate up front, and also a candidate whose
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

- **A create proposal can be erased by its own id (2026-11-04).** Decided by the
  delivery orchestrator for [corpus#62](https://github.com/kontourai/corpus/issues/62)
  under the owner's standing direction; the owner may override it. `purge` reaches a
  proposal only through the records it rests on, so a pending or rejected proposal
  with no sources, or with sources nobody is erasing, kept its candidate text.
  `purgeProposal(proposalId, { agent, rationale, note? })` closes that. It is on
  `KnowledgeStorePurger` next to `purge` and returns a `ProposalPurgeResult`
  (`proposalId`, `alreadyErased`, and `record` for an applied proposal).
  - **Host call.** Check `assertAdapterBoundTo(adapter, authorizedRoot)`, authorize the
    actor, then call `purgeProposal(proposalId, { agent: <actor>, rationale, note })`
    on an adapter built with `allowPurge: true`. Without it the call is `READ_ONLY`
    before any I/O, even for an unknown id. The store cannot tell who may erase; it
    records the actor you pass. `agent` and `rationale` are required and bounded
    exactly as for `purge` (`MISSING_EVIDENCE`), because they are copied into the
    proposal. The proposals directory is derived from the adapter's own root, so an
    adapter bound to one root cannot reach another root's proposal.
  - **Ids.** Proposal ids only. An unknown id, a path-like id, or a record id is
    `NOT_FOUND`, and `purge` still takes record ids only. To find proposals, use
    `listProposals`; an erased one has `erasure` set (there is no new `erased` state:
    the existing `erasure` marker that a record purge writes is the one signal, so
    `listProposals({ state })` and the state union are unchanged).
  - **What it writes.** Exactly what a record purge writes to a proposal: the candidate
    becomes a stub that keeps its type, `provenance.agent`, `session_id`, `source_ids`
    and link targets and kinds, with title `[purged]`, empty body, category `purged`,
    and no tags, aliases, expiry, link labels, provenance `note` or `source_refs`;
    `evidence.proposal` becomes `[purged]`; `erasure` holds `at`, `agent`, `rationale`
    and `note`. It keeps `id`, `state`, `proposer_id`, `evidence.agent`, `proposed_at`,
    the settlement identity and times, and `record_id`. **No content hash is kept**, and
    a keyed proposal's input digest is removed. Both code paths share one function
    (`erasedOf`), so a record purge and `purgeProposal` cannot drift apart. It builds the
    erased proposal field by field, so a field the store does not know does not survive,
    and an *erased* proposal that carries one is corrupt, not reported as done.
    The evidence is read once, before the call waits for the store lock, so a caller that
    changes the object (or an accessor on it) afterwards cannot change what is written.
  - **By state.** *Pending*: settled `rejected` by the erasing agent with the erasure
    rationale, so it can never apply. *Rejected*: the reviewer's rationale becomes
    `[purged]` and the reviewer stays. *Applied*: the content also lives in the record
    it created, so `purgeProposal` purges that record in the same transaction, cascade,
    survivors and referrers included, and returns the record purge's result as
    `record` for the host to review. The proposal keeps `state: applied`. If the record
    is already a tombstone, or `record_id` names no record or is not a safe, bounded id
    (a hand-edited proposal), only the proposal is erased and `record` is absent. If the
    record's file is gone, the default layout rebuilds its alias and graph indexes in the
    same transaction, since they still named it, unless another live record still links to
    the missing one or cites it as a source: a link can carry a label with the erased
    title, and a record that rests on it alone is one a purge would cascade, and only a
    record purge does either, so it refuses with a corruption error and writes nothing
    (restore the record and the erasure purges it properly; a record id named like an
    `Object.prototype` property, such as `constructor`, still fails in the graph helpers
    even then, [#66](https://github.com/kontourai/corpus/issues/66)). Tombstones that refer to it
    do not count. A vault always
    refuses the same way, because its path index lists a note that is missing.
    A host that wants to erase the proposal but not its record must not call this on an
    applied proposal.
  - **Idempotent.** An erased proposal, whether erased by this call or a record purge,
    returns `alreadyErased: true` and writes nothing, so the first marker (who, when,
    why) is never overwritten and a repeat or racing call is harmless.
  - **Request keys.** A retry with the key of an erased proposal is refused with
    `REQUEST_KEY_CONFLICT` (a typed error, not the tombstone's id), whatever its input.
    This is the 2026-11-03 "refuse all retries after purge" rule, now also reached by
    `purgeProposal`: the key hash stays so the key cannot be reused, the digest goes,
    and nothing is compared with the erased content. Returning the tombstone would
    tell a retrying client its content was accepted. A caller that retries *without* a
    key makes a new proposal, which is a new request and not a resurrection.
  - **Concurrent settlement.** Every operation takes the store lock, so erase and
    apply or reject are serialized. Erase first: `applyCreate` and `rejectCreate` are
    refused with `MISSING_EVIDENCE` (the proposal is `rejected`), no record is created.
    Apply first: the erase finds an applied proposal and purges the record it made.
    Reject first: the erase removes the reviewer's rationale. Two erasures: one writes,
    the other reports `alreadyErased`. In every order nothing of the candidate remains
    and no live record comes of an erased proposal.
  - **Interrupted erasure.** One journaled transaction with the purge's `erasure`
    option, so it is applied whole or rolled back whole (an applied proposal's record,
    indexes and proposal included). A crash before every file is published rolls back
    on the next locked operation: the proposal and its key are as they were, and the
    erasure can be retried. A crash after every file is published is applied on
    recovery, which also removes the folders the erasure emptied (a vault routes a
    record into a folder named for its category, which can name the data subject), as
    the erasure would have after a clean commit. Folders are removed before the journal
    that names them, so a second crash during that cleanup is finished by the next
    recovery, including through a folder an interrupted pass already removed. (Removing
    them is best effort: a folder that is not empty, or whose path is a symlink, is
    left alone.) A journal left after the commit marker
    holds none of the erased content.
    *Deferred, as for `purge`:* between the first journal write and the commit marker
    the journal holds the pre-erasure proposal, because rollback needs it, and a
    committed journal still lists the file paths it touched (a vault note's path
    contains its title slug) until the next locked operation, including any read,
    recovers it. This is the same window `purge-journal-in-flight` lists; it is not
    closed here.
  - **Failure.** A corrupt target proposal (unreadable, an `erasure` marker over intact
    content, an invalid candidate shape) stops the call before anything is written. A
    corrupt *other* proposal does not block a pending or rejected erasure, but does
    block an applied one, because the record purge judges every proposal first.
    A vault that opens read-only (`kit-v1`) refuses with `READ_ONLY`. One that holds
    `.corpus-store-migration/manifest.json` or `kit-v1-path-index.json` refuses every
    proposal, as `purge` refuses every record:
    the migration manifest keeps a sha256 of each file it saw, proposal files included,
    and a digest of a whole proposal file can be checked against a guess at its content.
    Delete those files (the directory) once the migration is verified, then erase. An id longer than
    a proposal id can be (200 characters) is `NOT_FOUND`.
  - **Not covered.** As for `purge`: copies outside the store's transaction, and the
    retained identities above (`proposer_id`, agents, session id, source ids, link
    targets). Those are the same identity references a record tombstone keeps.

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
  - `purge` reaches proposals; see the purge decision above. `purgeProposal` erases
    one by its own id; see its decision above.

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
private directory, not a host home path. Where Unix ownership and permissions are
available, it must be owned by the current user and inaccessible to other users;
mode `0700` provides the required access. Windows does not use this Unix mode check.
The package preserves the hashed
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
(`ttl_seconds`, `confidence`, supersede evidence `superseded_count`) as numbers
only when the source scalar is unquoted. Quoted numeric TTL remains corruption,
matching Station. A quoted `confidence` (`confidence: "0.5"`) is also corruption. Unknown fields use core-schema types when conversion is lossless: `3`,
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
The default store creates `records/` and the two indexes on the first write, not
at construction. Constructing it over an existing root, and read-only calls such
as `get` and the list methods on a root with no `records/`, create and change
nothing inside the root, so a host's dry run can read an empty root safely. The
constructor still creates the coordination directory the host passes in; keep it
outside the root for that guarantee. The `corpus-store` CLI's default
coordination directory is inside the root (under its migration directory), so
CLI runs write there unless `--coordination-directory` points elsewhere. A root that does not
exist yet is the exception: the constructor creates the directory and its
`.corpus-root-id` marker, because the root binding is a synchronous identity
fixed at construction. A host whose dry run must create nothing should not
construct the store over a missing root.
Vault layout: category-routed notes, `people/`, archives, `path-index.json`,
`graph-index.json`, `alias-index.json`, and collision-safe body sentinels.
Graph and alias indexes can be rebuilt; vault path mappings remain authoritative.

## Reviewed confidence updates

`reviewedConfidenceSnapshot(exactId)` returns the record, its root binding and a
`record-rev1:` revision read together under the store lock. The revision identifies
the exact stored bytes of that record and root, not the whole store. A byte change
changes the revision; returning to exactly the same bytes returns the same revision.
The root binding is an identity, not an authorization secret. Moving or replacing
the bound root changes the binding and invalidates prior revisions.

The host constructs a candidate with `rootBinding`, `recordId`, `revision`,
`oldConfidence` (`null` means absent), `newConfidence`, and a non-empty, sorted
array of unique evidence `{ id, revision }` pairs. IDs are exact and the target
cannot be its own evidence. Call `reviewedConfidenceCandidateDigest(candidate)`
to bind those fields. After authenticating and authorizing an independent human,
the host verifies that the decision names that exact candidate, rejects self-review,
and calls `applyReviewedConfidence` with the candidate, its `candidateDigest`, an
opaque `authorizationDigest`, a `requestKey`, and the acting `agent`. Neither the
digest nor an actor string proves the reviewer is human. The host must repeat its
authorization before every call, including retries. Enable the operation explicitly
with `allowReviewedConfidence: true` only for that host path; without it the adapter
refuses with `READ_ONLY` before reading the request or store.

Under the existing mutation lock, apply checks the bound root and each exact target
and evidence record. Historical records are refused; evidence revisions must still
match. A first application also checks the target revision and old confidence, then
writes the score and its receipt in one transaction. A matching retry returns the
original receipt without writing the score again, even if a later write changed the
target; the receipt records a past operation and does not say the current score is
still in place. Reusing a target-scoped key for a different request is
`REQUEST_KEY_CONFLICT`. A stale revision is `STALE_REVISION`; missing records are
`NOT_FOUND`. A changed or erased evidence record prevents replay. A record purge
retires receipt content for that target or any evidence record it erases; later use
of that key is refused. The key identity remains to prevent reuse. The agent and
request key must not contain content to be erased. As for other erasures, a prepared
in-flight journal can temporarily retain before-images until recovery completes.

Candidate and authorization digests must be lower-case `sha256:` values. Corpus
checks its candidate digest against the score and evidence fields; the host owns the
meaning and verification of the opaque authorization digest. The helper hashes the
UTF-8 JSON serialization of the array `['corpus-reviewed-confidence-candidate-v1',
rootBinding, recordId, revision, oldConfidence, newConfidence, [[id, revision], ...]]`
using JavaScript `JSON.stringify` number and string encoding. Inputs are bounded:
apply IDs at most 200 characters, at most 256 evidence records, and agent and request key
at most 1024 UTF-8 bytes. Digests and revisions are identifiers, not permission.

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
  (including `KnowledgeStorePurger`, `PurgeEvidence`, `PurgeResult`, `PurgePreview`, `ProposalPurgePreview` and `PurgeOptions`), service
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

The delivery orchestrator, under owner direction (owner may override), decided in [#45](https://github.com/kontourai/corpus/issues/45) that `proposeCreate(candidate, proposerId, evidence, { requestKey })` optionally deduplicates retries. Matching input returns the original proposal ID in pending, applied or rejected state; different input fails with `REQUEST_KEY_CONFLICT` without writing. The key identity and input digest share the proposal transaction. In this delivery lane on 2026-11-03, the owner chose “Refuse all retries after purge” so erasure removes the content digest and every later use of that key is refused with `REQUEST_KEY_CONFLICT`, regardless of input; the retained key identity prevents reuse. This supersedes the issue decision’s matching-retry rule after purge. To apply the same privacy rule to content-changing partial scrubs, the implementation also sets `request_key_retired: true` and removes the digest when a partial scrub changes the candidate or evidence. A partial scrub can leave a pending proposal applicable, so a caller recovering a lost receipt should not blindly retry with a new key: compute the SHA-256 hex digest of the original UTF-8 key, find its `request_key_hash` in `listProposals()`, and inspect that proposal’s state. Real purge integration and retry ordering are covered by conformance vectors; key lookup precedes the purge source guard. Completed full and partial scrubs remove the prior content digest; the separate in-flight purge journal limitation above still applies. A caller that loses a response retries with the same key. Omitting the key retains the original behavior. Keys must be well-formed Unicode strings, not empty or whitespace-only, and at most 1024 UTF-8 bytes.

Request keys are scoped to the whole store, not the proposer: callers sharing a store should namespace their keys and use opaque keys that do not encode content. The stored key hash is unsalted and can reveal a guessable key. The input digest detects mismatched stored content but is not authentication: a writer able to alter the file can recompute it. Keyed requests scan retained proposals under the mutation lock, so lookup cost grows with proposal count. A corrupt proposal causes keyed requests to fail closed because the store cannot establish whether the key is unused. Digest version 1 identifies the candidate projection and canonicalization; future changes must preserve retry comparison for stored versions.

### Decision: record confidence ([#68](https://github.com/kontourai/corpus/issues/68))

A record can carry `confidence`: how sure the writer was, as a number from 0 (not sure) to 1 (certain). Pass it when you create or propose a record, for example `store.create({ ...input, confidence: 0.75 })`, and change it later with `update`. It is saved in the note's frontmatter as `confidence: 0.75`. The store checks that the number is in range and keeps it as given. It does not sort, filter, rank or lower records by confidence; what the number means is up to the writer. Any record type can carry it.

- **Refused, never clamped.** `create`, `proposeCreate` and `update` refuse a value below 0 or above 1, `NaN`, an infinity, and anything that is not a number (text, a boolean, an array, an object, a bigint) with `MISSING_EVIDENCE` (the store's input-validation error code), and nothing is written. `0` and `1` are accepted, and `0` is a value, not an absence. `-0` is stored as `0`. `null` is not a number, so it is refused on create and in a candidate; on `update` it clears the field (as for `ttl_seconds`), and `undefined` means "not supplied". The error names the field and the range, and shows the value when it is a number, or its type when it is not. A proposal is checked when it is staged, so `applyCreate` cannot be the first to refuse a confidence.
- **Exact.** The number you read back is exactly the number you wrote, including very small values such as `1e-7` and long ones such as `0.30000000000000004`.
- **Read as well as written.** A note whose `confidence` is not a number in range (above 1, text, `.nan`, a quoted number) is corruption when read, as for `ttl_seconds`. Before this change `confidence` was an unknown field that a note could hold as any text; a hand-written note that holds `confidence: high` is now unreadable until it is fixed. A vault `dimensions` entry named `confidence` is now refused at construction, because it would overwrite the field.
- **Update.** `update(id, { confidence })` sets, changes or (with `null`) clears it, and other updates keep it. The mutation log names the field in `evidence.fields`, never the number.
- **Request keys.** `confidence` is part of the candidate, so it is part of the request digest. A retry with the same candidate and the same confidence returns the original proposal id, in any state, including after `applyCreate`. A retry that changes the confidence, adds it, or drops it is a different request and fails with `REQUEST_KEY_CONFLICT` without writing. Returning the original id instead would hand the caller a record whose confidence is not the one it just sent.
- **Purge.** Purging a record erases its `confidence` along with its title, body, tags and expiry; the tombstone left behind has no `confidence`. The same happens to records removed by a cascade and to a proposal erased with `purgeProposal`. A record the cascade leaves in place, because other sources still support it, keeps its `confidence` and its other content, except link labels that name an erased source. The update log keeps the field *name* `confidence` but never the number. The in-flight purge journal limitation above applies to this field as to every other.

### Decision: purge preview and revision ([#69](https://github.com/kontourai/corpus/issues/69))

A purge is permanent, so show the person what it will remove before they confirm. `previewPurge(ids)` and `previewPurgeProposal(proposalId)` return exactly what the erasure would return, without doing it: the records erased (`purged`), the records that fall with them because they rested only on those (`cascaded`), the records that keep other support (`survivors`), the records that only link to them (`referrers`), the proposals rejected, scrubbed or blocked, and, for a proposal, the record it created. They return ids and states, never content, change nothing, and work on any adapter, even one built without `allowPurge`. When the person confirms, pass the preview's `revision` to `purge` as `expectedRevision`: if anything changed since, the purge throws `STALE_REVISION` and writes nothing, so they never approve one list and get another.

```ts
const preview = await store.previewPurge(['rec-1']);          // read-only
// show preview.purged, .cascaded, .survivors, .referrers, .proposalsRejected ... to the person
try {
  await store.purge(['rec-1'], { agent, rationale }, { expectedRevision: preview.revision });
} catch (error) {
  if ((error as { code?: string }).code !== 'STALE_REVISION') throw error;
  // The store changed after the preview. Preview again, show the new lists, and ask again.
}
```

`previewPurgeProposal(proposalId)` and `purgeProposal(proposalId, evidence, { expectedRevision })` work the same way for a create proposal.

**If you implement `KnowledgeStorePurger` yourself** (hosts that use the bundled adapters need do nothing), this is a breaking change in this `next` prerelease: add `previewPurge(ids)` and `previewPurgeProposal(proposalId)`, and make `purge` and `purgeProposal` accept `{ expectedRevision }` and throw `STALE_REVISION`, writing nothing, when it no longer matches the store. The `purge-preview-*` conformance vectors check all of it.

- **One plan, not two.** `purge` and the previews run the same planning code, and one function builds both the preview and the committed result, so the lists cannot differ unless the store changed between the two calls. The tests compare them for a cascade, a support cycle, shared support, referrers, pending, rejected and applied proposals, records that are already tombstones, and an erased proposal. Splitting purge into plan and commit changed one thing: when two different things are broken at once (a corrupt proposal and a corrupt index, or an invalid clock, say), which one is reported first can differ from before. Each is still refused with the error it always was.
- **What you get.** `PurgePreview` is a `PurgeResult` plus `revision`. `ProposalPurgePreview` is a `ProposalPurgeResult` plus `revision`, the proposal's `state` now (a `pending` one is settled `rejected` by the erasure), and `recordId`, the record an applied proposal created. Its `record` holds the plan for erasing that record, with its cascade.
- **Read-only.** A preview writes no record, proposal or index. Like every read of the store, it first finishes a transaction that an earlier crash left half done. It refuses what the erasure would refuse: an unknown id is `NOT_FOUND`; a vault that holds migration artifacts or opens read-only is `READ_ONLY`; a vault with a corrupt graph or alias index, or any store with a corrupt proposal, stops a record preview just as it stops `purge`. A pending or rejected proposal's own plan parses only that proposal, but the preview's revision also checks every reviewed-confidence receipt; a corrupt receipt can block the preview or revision-checked erasure. The previews are declared on `KnowledgeStorePurger`, not on the ordinary adapter type, so code typed against the ordinary adapter does not see them. That is a type boundary only: the methods exist on every adapter object, and they reveal only ids that `get` and `listProposals` already return.
- **No content.** A preview that succeeds holds ids, states and the revision, and the `STALE_REVISION` message names no record or proposal. When a note or proposal is malformed, the error names that file, as it does for every other read of the store; in a vault the path includes the note's category and title. (A proposal too large to read is reported without its name.)
- **The revision** is an opaque token for the whole store as the preview saw it: a keyed digest of the raw bytes of every record note, every proposal file, and every reviewed-confidence receipt. It changes on any write to a record, proposal or receipt, including a receipt retired by erasure, and on an edit made outside the store to a note or a readable proposal. A matching request-key retry writes nothing and leaves it unchanged. Record notes and proposals are not parsed for the revision, but receipts are validated; a corrupt receipt refuses it. A vault also reads its `path-index.json`, so a corrupt index refuses it. The store keeps no revision counter. A proposal file too large to read is listed by name only, so changes to its content do not move the revision; they cannot affect any plan. The key is the root's binding (its path and identity marker), so a token cannot be checked against a guess at the content without the marker, and two stores with identical notes get different tokens. A root with no identity marker (an existing directory that was never initialized) has no key: its previews and `expectedRevision` fail with `ROOT_BINDING_MISMATCH` until the host runs `initializeRootBinding`, while `purge` without `expectedRevision` works as before.
- **STALE_REVISION.** With `expectedRevision`, `purge` and `purgeProposal` compare it with the store's revision under the same lock, before anything is written. A mismatch throws `StaleRevisionError` (`code: 'STALE_REVISION'`) and writes nothing; preview again, show the new lists, and pass the new revision. A malformed `expectedRevision` (empty, or not a string) or non-object options are `MISSING_EVIDENCE`. Without it, both verbs behave as before.
- **What it is not.** The revision covers the whole store, not only the records affected, so an unrelated write also makes a preview stale; the cost is one more preview. It is not a lock: other writes can still happen between the preview and the erasure, and the revision only makes the erasure refuse if one did. It is not an authorization, so the host still decides who may erase. Use a revision once, for the confirmation it was shown with; any later write makes it stale anyway. It does not cover the derived graph and alias indexes: one that is corrupt when the erasure commits is refused as corruption, not as stale. A vault checks both when it plans, so its preview refuses first; the default profile rebuilds a corrupt index while committing, so its preview cannot see a rebuild that will fail (for example, hand-edited conflicting aliases beside a corrupt alias index).
- **Cost.** A preview and a revision check read every record, proposal and reviewed-confidence receipt. Receipt scanning grows with retained history.

### Owner decision: structured source references (2026-11-03)

The orchestrator decided in [#46](https://github.com/kontourai/corpus/issues/46), subject to owner override, that optional `provenance.source_refs` carries attribution only. It neither authorizes reading `transcript_ref` nor constitutes review evidence; `note` remains free text and must not be parsed. The currently validated kind is `session-transcript`: `harness`, `session_id`, and `transcript_ref` are required, `sitting_id` and `range` are optional. A range is an inclusive one-based `{ start, end }` line range. Unknown fields and kinds are refused. Strings are nonempty and at most 4096 UTF-8 bytes; at most 256 references are accepted. Validation snapshots the array length before copying, including for proxy inputs. An empty array is preserved as supplied; optional fields set to `undefined` are treated as absent. In hand-edited vault frontmatter, plain YAML scalars in source-reference string fields are read as strings, consistent with other store string fields. The kind registry can grow through a future validated contract change. References can identify sensitive resources; they do not grant access. Real-purge conformance and integration tests verify their removal from purged records and erased proposals; the separate in-flight purge-journal limitation remains.

### Owner decision: adapter root binding (2026-11-03)

The orchestrator decided in [#47](https://github.com/kontourai/corpus/issues/47), subject to owner override, that each bundled adapter exposes `rootBinding()` and a host may call `assertAdapterBoundTo(adapter, root)` to compare it with its authorized root. A mismatch throws `ROOT_BINDING_MISMATCH`. The binding hashes the canonical root path and a random identity marker (`.corpus-root-id`) scaffolded in the root. Symlink aliases resolve to the same binding; a newly scaffolded root at the same path has a different identity. A pre-created empty directory is also unmarked and requires initialization. For a legacy root without a marker, initialization is explicit: call `await initializeRootBinding(storeOptions)` and construct a new adapter. Opening an unmarked or malformed legacy root does not modify its marker; binding checks fail closed while record reads remain available. Initialization is an explicit host-authorized write, including on a kit-v1 vault, and does not migrate that vault or enable its record mutations. Concurrent first constructors may observe an unbound root during marker publication. Call `initializeRootBinding(options)` to complete or recover scaffolding, then reconstruct the adapter before binding it. Initialization publishes without replacing an existing marker and can remove a matching scaffold temporary left by a crash. Extra hard links to the marker, including from hard-link snapshots, make binding checks fail closed; remove the extra links and reconstruct the adapter to restore binding. The helper only compares identity: the host owns root authorization and tenancy, and Corpus performs no ambient discovery.
