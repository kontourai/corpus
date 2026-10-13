---
id: station-mutation-record
type: concept
title: Fixture record
category: engineering.fixtures
tags:
  - 'true'
  - 'null'
aliases:
  - engineering.fixtures/mutations
links:
  - target_id: source-record
    kind: related
    label: '1.10'
provenance:
  agent: 'true'
  session_id: 'null'
  source_ids:
    - source-record
  note: '1.10'
created_at: '2026-01-01T00:00:00.000Z'
updated_at: '2026-01-01T00:00:00.000Z'
expires_at: '2030-01-01T00:00:00.000Z'
ttl_seconds: 60
status: active
mutation_log:
  - op: update
    at: '2026-01-01T00:00:00.000Z'
    agent: 'true'
    note: '1.10'
    evidence:
      fields:
        - title
        - tags
  - op: link
    at: '2026-01-01T00:00:00.000Z'
    agent: 'true'
    note: '1.10'
    evidence:
      added:
        - target_id: source-record
          kind: source
          label: 'null'
  - op: propose
    at: '2026-01-01T00:00:00.000Z'
    agent: 'true'
    note: '1.10'
    evidence:
      concept_id: concept-record
      proposal: '1.10'
  - op: propose
    at: '2026-01-01T00:00:00.000Z'
    agent: 'true'
    note: '1.10'
    evidence:
      proposer_id: proposer-record
      proposal: 'true'
  - op: apply
    at: '2026-01-01T00:00:00.000Z'
    agent: 'true'
    note: '1.10'
    evidence:
      proposer_id: proposer-record
      rationale: 'null'
  - op: reject
    at: '2026-01-01T00:00:00.000Z'
    agent: 'true'
    note: '1.10'
    evidence:
      proposer_id: proposer-record
      reason: '-'
  - op: supersede
    at: '2026-01-01T00:00:00.000Z'
    agent: 'true'
    note: '1.10'
    rationale: 'true'
    evidence:
      superseded_count: 1
  - op: superseded-by
    at: '2026-01-01T00:00:00.000Z'
    agent: 'true'
    note: '1.10'
    new_id: replacement-record
    rationale: '1.10'
    evidence:
      superseded_by_id: replacement-record
  - op: retire
    at: '2026-01-01T00:00:00.000Z'
    agent: 'true'
    note: '1.10'
    evidence:
      targetStatus: implemented
      rationale: 'true'
      implementedByRef: implementation-record
      supersededByRef: replacement-record
---

Station mutation fixture.