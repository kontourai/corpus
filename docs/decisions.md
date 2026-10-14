# Decision records

A decision registry keeps one living record per decision subject, in `docs/decisions/<topic-slug>.md`, plus a generated index. When the subject's answer changes, the record is edited; when the subject moves or is folded into another, the old record becomes a tombstone that names the new one. Git history and pull request review are the record's lifecycle.

Corpus checks the registry when `corpus.json` (schema v2) declares it:

```json
"decisions": { "dir": "docs/decisions", "index": "docs/decisions/index.md", "adr": { "dir": "docs/adr" } }
```

| Key | Default | Meaning |
| --- | --- | --- |
| `dir` | `docs/decisions` | The registry directory. Every `*.md` directly in it, except the index, is a record. It need not exist yet; `corpus decisions index` creates it. |
| `index` | `<dir>/index.md` | The generated index. It must be a `.md` file directly inside `dir`. |
| `adr` | absent | Optional. Declaring it freezes the numbered ADR directory `adr.dir` (default `docs/adr`), which must exist. See [Numbered ADRs](#numbered-adrs). |

`"decisions": {}` uses every default and leaves the ADR freeze off. Paths follow the [manifest path rules](../README.md#manifest-reference): repository-relative, POSIX, normalized, and inside the repository. `adr.dir` must not overlap `dir`. Unknown keys are refused, as everywhere in the manifest.

The gate reads `dir` directly. Whether the records are listed in `documents` or matched by `exclude` does not change what it checks; those keys only decide whether the records are published.

## Record format

A record is a Markdown file whose YAML frontmatter starts at byte 0:

```markdown
---
status: current
subject: Release channels
decided: 2026-07-03
evidence:
  - kind: issue
    ref: https://github.com/kontourai/example/issues/310
  - kind: adr
    ref: docs/adr/0004-release-channels.md
---

# Release channels

The current answer, its rationale, and its boundary.
```

| Field | Required | Rule |
| --- | --- | --- |
| `status` | yes | One of the [statuses](#statuses). |
| `subject` | yes | A non-blank noun phrase naming the subject. Ideally a term from the repository's domain vocabulary; this is not checked. |
| `decided` | yes | `YYYY-MM-DD`: the date the current answer was ratified, or the date a `needs-decision` stub was recorded. |
| `evidence` | yes | A non-empty list of `{ kind, ref }`. See [Evidence](#evidence). |
| `supersedes` | no | A list of slugs of existing records whose subjects this record absorbed. |
| `superseded_by` | `superseded` only | The slug of the existing record that now carries the answer. |
| `merged_into` | `merged` only | The slug of the existing record this subject was folded into. |

No other key is allowed, at the top level or in an evidence item. The filename without `.md` is the slug: lowercase kebab-case (`^[a-z0-9]+(-[a-z0-9]+)*$`). There are no numbers. The body has no required sections; Decision, Rationale, Boundary, and Consequences are common headings.

### Statuses

| Status | Meaning |
| --- | --- |
| `current` | This record holds the live answer for its subject. |
| `superseded` | The subject moved to another slug, named by `superseded_by`. This record is a tombstone. |
| `merged` | The subject was folded into another slug, named by `merged_into`. This record is a tombstone. |
| `needs-decision` | A stub naming an open subject with no ratified answer yet. It carries provenance evidence but no live decision. |

ADR status words such as `accepted`, `proposed`, and `draft` are refused. When converting an accepted ADR into a record, use `current`.

### Relations

- `superseded_by` and `merged_into` each name one existing record, never the record itself.
- `supersedes` is a list (not a single slug) of existing records.
- `current` and `needs-decision` records carry neither `superseded_by` nor `merged_into`.
- `superseded` requires `superseded_by` and forbids `merged_into`; `merged` requires `merged_into` and forbids `superseded_by`.

### Evidence

Provenance is linked, never inlined. `kind` is one of `issue`, `pr`, `commit` (a GitHub number, URL, or SHA), `session-archive` (a path to an archived session artifact), `adr` (a frozen numbered ADR), `doc` (a repository document), or `url` (an external permalink). `ref` is a non-blank string. A ref containing a secret-shaped literal is refused: an AWS access or STS key id, a GitHub token, a private key header, a JWT, or a quoted `secret`, `password`, `token`, or `api key` assignment.

### How the frontmatter is read

The block opens with a `---` line at byte 0, with no byte order mark, and ends at the next line that is `---` once trimmed. It is parsed as YAML with the failsafe schema, so every scalar is a string: `ref: 310` is the string `"310"`, and `decided: 2026-07-03` stays a string. A block that is not a mapping, repeats a key, or uses YAML anchors, aliases, or explicit tags is refused.

This replaces an earlier line-based parser. All 97 records in the seven registries that used it read identically under both. Where they differ, the YAML reading wins:

- An unquoted ` #` starts a comment. `ref: #310` is an empty ref, which is refused, so quote it: `ref: "#310"`.
- Quoted strings are unescaped (`"a \"b\""` is `a "b"`, and `'it''s'` is `it's`).
- A plain value containing `: `, such as `subject: Release: channels`, is invalid YAML; quote it.
- Repeated keys, tab indentation, anchors, aliases, and tags are refused. The earlier parser kept the last repeated key and read the rest as literal text.
- Block scalars (`>` and `|`) and flow mappings (`- { kind: pr, ref: "#1" }`) are read as YAML.

## The index

`corpus decisions index` writes the index, and no other file:

```markdown
---
title: Decision Index
---

# Decision Index

Generated by `corpus decisions index`. Do not edit by hand.
Topic-keyed living decision records; the format is described at https://github.com/kontourai/corpus/blob/main/docs/decisions.md.
Numbered ADRs under `docs/adr/` are frozen history and are not listed here.

| Topic | Status | Decision |
| --- | --- | --- |
| [release-channels](./release-channels.md) | current | Release channels |
```

The ADR line appears only when `adr` is declared, with its directory. Rows are sorted by slug; the Decision column is the subject, with `|` escaped. Output is deterministic, so running the command twice changes nothing. The gate fails when the index is missing or differs from what the command would write. It refuses to write through a symlink.

Apart from lines 7 and 8 of the header, the index is identical to the one the earlier per-repository generator wrote, so adopting the gate changes two lines of an existing index.

## Numbered ADRs

Numbered ADR directories are frozen history. New decisions go to the registry, where existing ADRs can be cited as `adr` evidence. ADR files are never validated as records, and their numbers stay as they are.

With `adr` declared, `corpus check --base <ref>` and `corpus decisions check --base <ref>` run the **adr-freeze** gate. It lists the files added under `adr.dir` between the merge base of `<ref>` and `HEAD` (`git diff --diff-filter=A --no-renames <ref>...HEAD`) and fails, exit `1`, for each one, naming the registry path to use instead. Editing an existing ADR, for a typo or a link, passes, and so does deleting one. Renaming a file inside `adr.dir` adds a path, so it fails. Without `--base`, the gate is reported as `SKIP` with a note, because there is nothing to compare against. Uncommitted files are not seen; pull request CI, which passes `--base`, is where the freeze applies.

## Commands

```sh
corpus decisions check [--root dir] [--base <git-ref>]
corpus decisions index [--root dir]
```

`corpus decisions check` validates the manifest, then runs only the **decisions** gate (every record, then the index) and, when `adr` is declared, the **adr-freeze** gate. It reads no other document, so it is fast enough for a repository's own required lane. `corpus check` runs the same gates among the others, and `corpus build` runs the decisions gate (without the freeze). Exit codes match `check`: `0` ok, `1` a gate failed, `2` a usage or configuration error, including an invalid manifest, a `--base` that does not resolve, and a manifest without a `decisions` block.

The shared Docs gate runs `corpus check`, so it picks up the gate wherever the manifest declares `decisions`. Where that job is not a required check, keep `corpus decisions check` in the repository's required lane, for example as the `check:decisions` script.

## Schema and conformance vectors

[`schemas/decision-record.schema.json`](../schemas/decision-record.schema.json) is the JSON Schema for the frontmatter, shipped in the package as `@kontourai/corpus/schemas/decision-record.schema.json`. Corpus enforces it, plus what a schema cannot state: the filename slug, relations to other records, the index, and the freeze.

[`@kontourai/corpus-conformance`](../packages/conformance/README.md#decision-record-vectors) ships `decision-records.json`, whole-registry vectors with the expected rule codes, so another validator can be tested against the same cases.

The library exports `parseDecisionRecord(text)`, `validateDecisionRecord(slug, frontmatter, knownSlugs)`, `validateDecisions(root, decisions)`, and `renderDecisionIndex(records)`.
