# Corpus Store

`@kontourai/corpus-store` owns transactional, file-backed mutable records. Its
purpose is to give hosts one implementation of record identity, links,
provenance, mutations and recoverable publication. Immutable docs bundles are
separate. The docs CLI does not depend on this package and needs no build.

This extraction preserves Station semantics at
`2479f38b1ab062e2d9cd6df9f8fa2cdbeee1d136`. The only planned codec change in this
release preserves text scalars from old Knowledge Kit writers. Future working-set,
expiry, compiled-source and proposal decisions are explicit expected failures,
not implemented behavior. Version `0.1.0-next.0` is the first npm candidate,
published only after owner bootstrap and trusted-publisher setup through the
[workspace publish workflow](../../README.md#publishing-the-store-workspaces).

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
locked reads may repair derived indexes or recover a journal. List options remain
`includeRetired` and category `prefix`; retired records are gettable. Default
superseded files remain listed; vault superseded files are archived. No
`includeHistory`, stale filter, search, capabilities object, alternate vault
index format or public storage API is claimed by this extraction.

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
`path-index.json` is the sole vault index format. Kit vault migration and refusal
of occupied unindexed vaults belong to the later adjusted programme step 6.
Graph and alias indexes can be rebuilt; vault path mappings remain authoritative
in this preserved implementation.

## Public exports

- `@kontourai/corpus-store`: constructors, record/evidence/interface types,
  service option types, reindex result type and standalone lock.
- `@kontourai/corpus-store/errors`: the unchanged domain and persistence error
  constructors/classifier. Persistence errors do not gain new codes here.
- `@kontourai/corpus-store/observation`: construction-free bounded filesystem
  observation, including `observeExactKnowledgeRecordFile(root, coordinationDirectory, exactId)`.
  It refuses journal/lock artifacts and returns a recheck; hosts must retain
  non-atomic/unknown-transaction semantics and enforce authorization separately.
- `@kontourai/corpus-store/package.json`: metadata.

Deep source/dist imports and `/storage` are not exports. ESM only, Node >=22.
Runtime dependency: js-yaml, retained for Station-identical writing.

## Development and evidence

```sh
npm ci
npm run build --workspace=@kontourai/corpus-store
npm run test --workspace=@kontourai/corpus-store
npm run conformance --workspace=@kontourai/corpus-store
npm run verify:pack --workspace=@kontourai/corpus-store
```

Builds emit package-local ESM JS and declarations. No root prepare/build step
is added. Pack verification installs tarballs in isolated JS and TS consumers,
checks exports and declarations, executes all conformance vectors on both
profiles against installed code, and runs the installed docs CLI without a
build. CI runs this on Node 22 and 24.

[The expected-fail list](test/expected-fails.json) is keyed by public vector ID,
profile, deferred owner decision and either an exact failing assertion or a specific error pattern. Unknown failures,
missing probes and listed vectors that pass fail the run. Search is a host
integration obligation. [The extraction record](../../docs/store-extraction.md)
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
