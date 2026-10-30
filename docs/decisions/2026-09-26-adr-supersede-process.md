---
title: ADR Supersede Process
date: 2026-09-26
status: accepted
---

# ADR Supersede Process

## Context

When a decision changes, the old ADR must be marked superseded. The correct linking direction (which file references which) and date ordering have been sources of confusion.

## Decision

### The supersede relationship

When ADR **B** replaces ADR **A**:

**In ADR A** (the old one being replaced):
```markdown
---
status: superseded
superseded-by: 2026-09-26-B-slug
---
```
Add `superseded-by` only. Keep the full content.

**In ADR B** (the new one):
```markdown
---
status: accepted
date: 2026-09-26
supersedes: 2026-09-25-A-slug
---
```
Add `supersedes` only. `date` must be newer than A's date.

### Date ordering invariant

The file `date` establishes ordering, not the file name. A newer ADR (higher date) supersedes an older one.

**Correct:** `2026-09-26-B.md` supersedes `2026-09-25-A.md` — B is newer date, B adds `supersedes: 2026-09-25-A`

**Incorrect:** `2026-09-26-B.md` cannot supersede `2026-09-27-A.md` — B is older, it would be A superseding B.

### Chain length

Supersession chains are linear, not branching. If A → B → C, then C supersedes A directly (C's `supersedes` can list A, B, or both). Any ADR in the chain may have a `superseded-by`.

### Multiple supersedees

A single ADR may supersede multiple older ones (many-to-one). Each old ADR gets its own `superseded-by: YYYY-MM-DD-new-slug`.

### Content preservation

The superseded ADR's content is **never removed** — it explains *why* the old decision was made. The reader can follow the chain to understand the evolution.

## Consequences

- `refresh-decisions-digest.sh` must handle `superseded-by` by not duplicating superseded ADR bullets into DIGEST Critical section
- `just docs-audit` validates that no `superseded-by` points to a non-existent file
- The `four-phases-gate` ADR (PR-1.3) will enforce supersede-chain audits during PR review
