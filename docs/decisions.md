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

### Reachability and publishing

Once `decisions` is declared, every `*.md` directly in `dir`, records and index alike, counts as reachable for the [reachability gate](../README.md#check), so adding a record needs no `corpus.json` edit. A Markdown file in a subdirectory of `dir` is not a record and still has to be listed or excluded.

Reachable is not published. A record or the index appears on the site and in `docs-bundle.json` only when `documents` lists it, as for any other document; listing it with `"publish": false` puts it in the bundle without a page. Records are not published automatically, because that would change the site and the bundle digest of every repository that declares `decisions`, and many keep their records as contributor-facing history rather than product documentation.

A `documents` entry may name the index before it exists: `corpus decisions index` accepts that one missing file and writes it, so a repository can write its intended manifest first and generate the index second. Every other command, `corpus check` and `corpus decisions check` included, still fails on a listed index that does not exist (exit `2`), and `corpus decisions index` still refuses any other missing document.

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
| `subject` | yes | A non-blank, single-line noun phrase naming the subject, with no control characters (it becomes a cell of the index table). Ideally a term from the repository's domain vocabulary; this is not checked. |
| `decided` | yes | `YYYY-MM-DD`: the date the current answer was ratified, or the date a `needs-decision` stub was recorded. |
| `evidence` | yes | A non-empty list of `{ kind, ref }`. See [Evidence](#evidence). |
| `supersedes` | no | A list of slugs of existing records whose subjects this record absorbed. |
| `superseded_by` | `superseded` only | The slug of the existing record that now carries the answer. |
| `merged_into` | `merged` only | The slug of the existing record this subject was folded into. |

No other key is allowed, at the top level or in an evidence item. A record must be a regular file: a symlinked record is refused. The filename without `.md` is the slug: lowercase kebab-case (`^[a-z0-9]+(-[a-z0-9]+)*$`). There are no numbers. The body has no required sections; Decision, Rationale, Boundary, and Consequences are common headings.

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

This replaces an earlier line-based parser. All 97 records in the seven registries that used it read identically under both. On other input the YAML reading wins, and it differs in both directions.

Now refused, where the earlier parser accepted the text literally:

- an unquoted `#` after a space starts a comment, so `ref: #310` is an empty ref and is refused (quote it: `ref: "#310"`);
- a plain value that YAML cannot read as a plain scalar: one containing `: ` (`subject: Release: channels`), one starting with a reserved character (`` ` ``, `@`, `%`), or one starting with a quote but continuing past it (`subject: "a" and "b"`). Quote the whole value;
- a value starting with `[` or `{` that is not a valid flow collection, or one that is a mapping where a string belongs (`subject: {x}`);
- repeated keys (the earlier parser kept the last one), tab indentation, anchors, aliases, and explicit tags;
- a tab or other control character inside a subject;
- an empty `supersedes:` (the earlier parser read it as an empty list);
- a subject whose value contains a line break: a double-quoted escape (`"C:\new"`), a literal block scalar (`|-` with two lines), or any block scalar that keeps its final line break (`>` or `|` without the `-` strip indicator). A subject merely written over several lines is different; see below.

Now accepted, where the earlier parser refused the line:

- a trailing comment (`status: current # note`), a space before the colon (`status : current`), and quoted keys (`"status": current`);
- flow mappings (`- { kind: pr, ref: "#1" }`, or `evidence: [{ kind: pr, ref: "#1" }]`);
- values continued over several lines, and a blank line inside an evidence item. A plain or quoted subject continued on an indented line, or a `>-` folded block without blank lines, is folded into one line (`First line second line`), so it is a valid single-line subject;
- block scalars (`>` and `|`) in fields other than `subject`.

Quoted strings are also unescaped (`"a \"b\""` is `a "b"`, and `'it''s'` is `it's`), so an index row can read differently from the earlier generator's output for a record written that way.

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

The ADR line appears only when `adr` is declared, with its directory. Rows are sorted by slug; the Decision column is the subject, with `|` escaped. Output is deterministic, so running the command twice changes nothing. The gate fails when the index is missing or differs from what the command would write. It refuses to write through a symlink anywhere on the index path, and it refuses to replace an existing non-empty file that does not begin with the generated `title: Decision Index` frontmatter (a BOM, CRLF line endings, and leading merge-conflict markers are tolerated), so a mistaken `index` setting cannot overwrite a record.

For the 97 existing records, the index is identical to the one the earlier per-repository generator wrote except for header lines 7 and 8, provided `adr` is declared. Without `adr`, line 9 (the ADR line, which the earlier generator always wrote) is also dropped.

## Numbered ADRs

Numbered ADR directories are frozen history. New decisions go to the registry, where existing ADRs can be cited as `adr` evidence. ADR files are never validated as records, and their numbers stay as they are.

With `adr` declared, `corpus check --base <ref>` and `corpus decisions check --base <ref>` run the **adr-freeze** gate. It lists the files added under `adr.dir` between the merge base of `<ref>` and `HEAD` (`git diff --diff-filter=A --no-renames <ref>...HEAD`) and fails, exit `1`, for each one, naming the registry path to use instead. Editing an existing ADR, for a typo or a link, passes, and so does deleting one. Renaming a file inside `adr.dir` adds a path, so it fails.

Two names are exempt, so the directory can explain itself: `README.md` and `index.md`, directly in `adr.dir`, exactly as written. Any other added file fails, whatever its name or extension, including a `readme.md`, a `README.md` in a subdirectory, and a file renamed from an exempt name to an ADR name. The freeze uses this fixed list rather than freezing only files that look numbered (`NNNN-*.md`): a numbering pattern would let through every ADR added under another name (`adr-0005.md`, `0005_title.md`, a subdirectory), while the list admits two known names. An exempt file can still hold a decision, but there are two of them and both are visible in review. Renaming an existing ADR to an exempt name passes, because deleting an ADR passes; nothing new is admitted. Without `--base`, the gate is reported as `SKIP` with a note, because there is nothing to compare against. Uncommitted files are not seen; pull request CI, which passes `--base`, is where the freeze applies.

## Commands

```sh
corpus decisions check [--root dir] [--base <git-ref>]
corpus decisions index [--root dir]
```

`corpus decisions check` validates the manifest, then runs only the **decisions** gate (every record, then the index) and, when `adr` is declared, the **adr-freeze** gate. It reads no other document, so it is fast enough for a repository's own required lane. `corpus check` runs the same gates among the others, and `corpus build` runs the decisions gate (without the freeze). Exit codes match `check`: `0` ok, `1` a gate failed, `2` a usage or configuration error, including an invalid manifest, a `--base` that does not resolve (checked even when `adr` is not declared), and a manifest without a `decisions` block.

The shared Docs gate runs `corpus check`, so it picks up the gate wherever the manifest declares `decisions`. Where that job is not a required check, keep `corpus decisions check` in the repository's required lane, for example as the `check:decisions` script.

## Schema and conformance vectors

[`schemas/decision-record.schema.json`](../schemas/decision-record.schema.json) is the JSON Schema for the frontmatter, shipped in the package as `@kontourai/corpus/schemas/decision-record.schema.json`. Corpus enforces it, plus what a schema cannot state: the filename slug, relations to other records, the index, and the freeze.

[`@kontourai/corpus-conformance`](../packages/conformance/README.md#decision-record-vectors) ships `decision-records.json`, whole-registry vectors with the expected rule codes, so another validator can be tested against the same cases. Each of the six secret detectors has its own vector. Reachability, publishing, and the ADR freeze are repository checks, not part of the record format, so the vectors do not cover them.

The library exports `parseDecisionRecord(text)`, `validateDecisionRecord(slug, frontmatter, knownSlugs)`, `validateDecisions(root, decisions)`, and `renderDecisionIndex(records)`.
