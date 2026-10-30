---
title: Code Review Process
date: 2026-09-26
status: accepted
---

# Code Review Process

## Context

Code review is the primary quality gate before merging. This ADR defines what reviewers must check, what is required vs. nice-to-have, and how to handle disagreements.

## Decision

### Required checks (CI-equivalent, must pass)

Reviewers MUST block merging if any of these fail:

1. **Correctness** — logic is correct, edge cases handled, no off-by-one errors
2. **Test coverage** — new logic has tests; existing tests still pass
3. **No regressions** — feature flags, existing behavior, API contracts unchanged
4. **Clean architecture** — layer boundaries respected (domain ← data ← presentation)
5. **Detekt clean** — `warningsAsErrors: true`, no new violations in changed code

### Required checks (process, must be verified by reviewer)

6. **ADR if needed** — architectural decisions require an ADR in the same PR
7. **No secrets** — no API keys, tokens, or credentials in code
8. **Breaking changes documented** — API/behavior changes noted in PR description

### Nice-to-have (reviewer should flag, author decides)

- Naming clarity
- Comment quality
- Code duplication (within reason)
- Over-engineering

### Process

1. Author opens PR, assigns reviewer(s)
2. CI runs: `jvmTest`, `detekt`, `androidTest` (if applicable)
3. Reviewer reads diff, comments within 1 business day
4. Author addresses comments or responds
5. Reviewer approves or blocks
6. Author merges (squash-merge preferred for feature branches)

### Disagreements

- Technical disagreements: reviewer must articulate the specific risk, not just taste
- If author and reviewer disagree after one round: escalate to a third engineer
- Pattern/idiom disagreements: reference existing ADRs or DIGEST rules

## Consequences

- `just tcheck` (full pipeline) is the authoritative check before merge
- PRs without ADR for architectural changes should be blocked by reviewer
- The `four-phases-gate` ADR defines the PR phases that require review
