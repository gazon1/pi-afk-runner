---
title: Writer-Reviewer Pattern
date: 2026-09-26
status: accepted
---

# Writer-Reviewer Pattern

## Context

When an ADR is proposed, it needs both a **writer** (author) and a **reviewer** (approver). The writer proposes the decision; the reviewer challenges it, suggests alternatives, and approves. This pattern governs how architectural decisions are made collaboratively.

## Decision

### Roles

**Writer** (author of the ADR):
- Creates the `proposed` ADR with full context, alternatives considered, and decision
- Opens a PR with the ADR
- Responds to review comments, updates the ADR
- Is responsible for the `supersedes` chain when updating

**Reviewer** (assigned approver):
- Must not be the same person as the writer
- Reviews within 2 business days of assignment
- Challenges assumptions, not taste — technical objections only
- Approves by merging the PR (or requests changes)

### Process

1. Writer creates ADR in `docs/decisions/YYYY-MM-DD-slug.md` with `status: proposed`
2. Writer opens PR, assigns reviewer
3. Reviewer reads, comments, requests changes if needed
4. Writer updates ADR based on feedback
5. Reviewer approves → writer merges
6. Writer or reviewer updates `status: accepted` + `date` after merge

### Constraints

- An ADR with `status: proposed` MUST NOT be cited in `DIGEST.md` critical/warnings sections
- An ADR with `status: deferred` does not need a reviewer until it is unblocked
- Multiple reviewers are allowed for high-impact decisions (e.g., security, data model changes)

## Consequences

- `just docs-audit` validates that `status: proposed` ADRs are in open PRs (check via GitHub API)
- Reviewers should be assigned based on domain expertise — not all ADRs need the same reviewer
- For the AI agent: it acts as a reviewer when PRs contain ADRs; it acts as a writer when it files ADRs for deferred findings
