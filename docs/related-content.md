# Related content across repositories

`corpus content impact` answers “I changed these files; which other content
needs review?” It extends the idea behind a document's `covers` to public
websites, privacy policies and other files in separate repositories. Targets
are GitHub file URLs or public HTTPS page URLs, so their identity does not depend on a contributor's
checkout layout. This command does not fetch the targets or require a prose edit.

`corpus content check` checks the input and output bytes recorded by an explicit
review. It reads local files or GitHub file URLs. It supports arbitrary text and
binary files, including an Astro page or a generated copy inventory; these files
do not need to be published as Corpus Markdown documents.

The commands use a separate `corpus-content.json`. Existing `corpus.json`,
`covers`, `corpus check`, bundles and MCP behavior stay compatible. Veritas can
run these commands as evidence checks; Corpus owns the dependency and byte-checking
behavior. A passing byte check is not evidence that public prose is true.

## Declare review relationships

```json
{
  "schemaVersion": 1,
  "repository": "example/product",
  "relationships": [{
    "id": "public-privacy",
    "covers": ["src/server/**", "docs/privacy-policy.md"],
    "targets": ["https://github.com/example/website/blob/main/src/privacy.astro"]
  }]
}
```

Run before editing, or against committed branch changes:

```sh
corpus content impact --changed-file src/server/telemetry.ts
corpus content impact --base origin/main
```

`--changed-file` repeats and can describe working or hypothetical changes.
`--base` uses the merge-base diff to HEAD, including both sides of a rename;
it does not include uncommitted edits. Use one selection method per invocation.
Output is JSON with target URLs and the source files that selected each target.
Use a public page URL when a site's source repository is private and its name
should not appear in a public product manifest. Targets are never fetched.
An embedding tool can use `readContentManifest` and `contentImpact` from the
public `@kontourai/corpus/content` export with the same validation and matching.
Relationships are advisory and incomplete: a missing relationship is not proof
that a change has no public-content impact.

## Record and check a review

A website can keep its own manifest, with `reviews` instead of, or alongside,
`relationships`. A review names `id`, `reviewedAt` (an ISO date), `note`, `limits`,
and nonempty `inputs` and `outputs` arrays. Each file has exactly one `path`
(repository-relative, local) or `url` (GitHub HTTPS blob URL), and `sha256`
(the full SHA-256 of its reviewed bytes). Remote files also carry `revision`,
the full commit SHA inspected by the reviewer. Unknown fields are refused.

```json
{
  "schemaVersion": 1,
  "repository": "example/website",
  "reviews": [{
    "id": "public-privacy",
    "reviewedAt": "2026-11-05T00:00:00Z",
    "note": "Compared the public disclosure with the declared data flows.",
    "limits": "Source review only; provider retention and deployment unverified.",
    "inputs": [{
      "url": "https://github.com/example/product/blob/main/docs/privacy-policy.md",
      "revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "sha256": "<64 hex characters from the reviewed input>"
    }],
    "outputs": [{
      "path": "src/privacy.astro",
      "sha256": "<64 hex characters from the reviewed public page>"
    }]
  }]
}
```

Replace the example hashes with the reviewed bytes before running the command:

```sh
corpus content check
corpus content check --manifest content/station-source-review.json
corpus content check --checkout example/product=/any/location/product
```

The default is remote verification; no sibling checkout is required. Branch or
tag refs in GitHub URLs are resolved once per repository/ref to a full commit.
Every file for that ref is read at that observed commit, which the report names.
An exact-commit URL stays fixed and therefore does not track future changes;
use a branch URL when checking ongoing freshness. Encode a slash in a ref as
`%2F`. `revision` retains review context; byte equality, not commit age, decides
freshness. The check does not establish that a declared hash came from that
historical revision or that an agent actually performed the stated review.

Private repositories require a `GITHUB_TOKEN` with contents access. Tokens go
only to `api.github.com`; redirects are refused and requests time out after
20 seconds. Files must be available through GitHub's base64 contents response;
large files, submodules and symlink responses that do not return ordinary file
bytes are unavailable. Local `--checkout owner/repo=directory` mappings use
working bytes explicitly and report that limitation; they are not remote-head
or committed-byte evidence. Mappings are optional and are never stored in the
manifest. A local path or symlink resolving outside its root is refused.

Exit `0` means the declared files match. Exit `1` names changed inputs or
outputs. Exit `2` means invalid configuration or unavailable evidence, including
missing files, authentication failures and network errors. It must not be
interpreted as freshness. Impact exits `0` for a valid advisory report, even
when it selects targets, and `2` when its configuration or diff is unavailable.

## Keep it running

### Scope a JSON review to its owning value

A file reference can add `"pointer": "/products/station"` to bind only that
JSON value. This is useful when one metadata file contains several products:
another product's release should not invalidate an unchanged Station review.
Pointers follow RFC 6901 (`~0` for `~`, `~1` for `/`). An empty pointer selects
the whole parsed JSON value. Missing values, malformed pointers and invalid
UTF-8 JSON are unavailable, not a matching null or a passing check.
Selected numbers must be finite, and integers must be within JavaScript's
safe range; use JSON strings for larger identifiers or exact decimal records.

The digest is SHA-256 of `JSON.stringify` after recursively sorting object keys;
array order is preserved. Formatting and object-key order therefore do not
affect the value digest. Without `pointer`, the existing raw-byte digest stays
unchanged. `contentDigest(bytes, pointer)` from `@kontourai/corpus/content`
computes the same digest for a review; it does not record or approve one.

Several different pointers in one file may appear in a review. This precision
applies to `content check`; the offline `covers` freshness gate still requires
whole-file input and document bindings, so a partial value cannot approve
unreviewed changes elsewhere in a covered file.

### Review an unchanged covering document

`corpus check --base <ref>` accepts a local review in `corpus-content.json` as
an alternative to editing a covering document's prose. The review must be new
or changed in the same branch range. Its local `inputs` must include every
changed file matched by that document's `covers`, and its local `outputs` must
include the document. Every recorded input and output hash must match the
current bytes. The note explains why the document remains accurate and records
the review's limits. A review already on the base, an unrelated review edit,
stale hashes, incomplete inputs, or remote-only references cannot clear freshness.

This path is offline and shares the existing content-review manifest. It is not
an approval signature or a semantic proof. It cannot acknowledge deleted inputs:
update the owning explanation when removing a covered source. Existing
`covers` and same-range prose updates remain supported. A false review statement
is still a code-review concern; automatic checks cannot decide whether prose is true.

### Scheduled checks

Run `content check` in the website's pull-request and deployment checks, and on
a daily schedule: product changes can land without any website commit. On
failure, inspect changed claims and callers, update or justify the public copy,
and then record the reviewed hashes and note. There is no automatic hash-refresh
command. Review outputs are bound too, so later copy edits require review.

Keep screenshot capture provenance and actual publication checks separate. This
feature does not infer new dependencies, edit prose, approve legal/store
classifications, certify releases or verify a deployed page. Changing a manifest
can weaken its coverage; protect review-manifest changes through code review.
