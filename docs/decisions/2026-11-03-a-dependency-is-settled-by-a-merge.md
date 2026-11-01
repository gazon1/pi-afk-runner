---
title: A dependency is settled by a merge, and by nothing else
status: accepted
date: 2026-11-03
authors: MiniMax Code
deciders: Singularity Developer
tags: [queue, dependencies, split, merge]
---

# A dependency is settled by a merge, and by nothing else

## Context

An issue says what it waits for in its own text: a line that starts with
`**Depends on:** #N` names a parent issue. The runner reads that line before it
works an issue, and the rule it applied was **the dependency is settled when the
parent is closed**.

That rule cannot tell a parent that was closed because its work landed from a
parent that was closed because its work was refused. A parent closed as
won't-fix, closed as stale, or closed by hand after its pull request was closed
unmerged all read the same: `CLOSED` is `CLOSED`. So a chain could start a
piece whose predecessor was rejected, and the piece built on work that was
never going to arrive.

The record of 2026-11-01 said why the rule was there: "the runner cannot see a
merge that did not close the issue, and a human who closed it has said the work
is done". The first half was true. The second half was the defect: a human who
closed a parent as won't-fix has said the work is **not** to be done, and the
rule read that as the opposite.

## Idea

The rule needs an observable that says the work **landed**. GitHub already has
one, and it is the pull request's own state: **merged**. A parent that was
closed without a merge has not landed, whatever the closure says.

The alternative — keep `closed` and declare that a closed `wontfix` parent
settles the chain — is the rule that produced the defect, so it is not a
choice between two readings. It is the same rule with the same answer.

## Decision

**A dependency is settled when the parent's pull request is merged, and by
nothing else.**

- The observable is the **merged pull request of the parent's work branch**,
  `agent/issue-<N>` — read with `gh pr list --state merged --head
  agent/issue-<N>`. A pull request keeps its head branch after the branch is
  deleted, so a merged pull request is still found after the merge mode deleted
  the branch.
- A parent that is still open blocks the child.
- A parent that was closed **without** a merged pull request blocks the child:
  closed as won't-fix, closed as stale, closed by hand.
- A parent whose pull request is open, or closed unmerged, blocks the child.
- **A read that fails blocks the child.** A dependency is settled on positive
  evidence of a merge, and "the runner could not tell" is not that evidence.
  The queue is read again on every run, so a read that fails holds an issue
  out for one run, not for ever.
- The **child's own text** is still read best-effort: an issue whose text
  cannot be read has no dependency the runner can see, and the run cannot go on
  without the brief either — it stops where the brief is read.

The split follows the same rule: the pieces are chained with `**Depends on:**
#N`, and a piece waits for the previous piece's pull request to be merged. The
chain advances when the work lands, not when an issue is closed.

## Rationale

The old rule read an observable that does not carry the meaning it was given.
An issue's state says whether the issue is done; it does not say whether the
work landed, because the same state covers a merge, a rejection and a
decision to do nothing. The pull request's state does carry it: `merged` is a
statement about the work, and every other state — open, closed unmerged, or
absent — is a statement that the work has not landed.

Merging is also the only landing the runner itself can produce. The work
pipeline never merges, and the merge mode lands only what the work pipeline
opened and reviewed, so "the parent's pull request is merged" is a statement
about exactly the work the runner is responsible for.

Failing closed is the direction the rule points. The old rule failed open,
because a read that fails was held to be "probably fine" — but under a rule
whose answer is "the work landed", an unreadable parent is an unknown parent,
and an unknown parent is not a landed one. The cost is bounded: the queue is
read again on every run, so a transient failure delays one run rather than
stalling the queue.

## Consequences

- The parent's **issue** is no longer read: the check reads the parent's pull
  request instead, one `gh pr list` where there was one `gh issue view`.
- The rule is stricter than "closed". A chain whose parent a human closed by
  hand now waits until somebody merges the pull request that names that
  parent, or takes the dependency line away.
- A parent whose work landed **outside** the runner's pull request — a human's
  pull request, or a direct commit to the base branch — keeps the child
  waiting. The observable is the runner's own branch, and a parent that was
  never worked by the runner has no pull request on it. Widening the
  observable to every merged pull request that names the parent is the change
  that would cover that case, and it costs a read of the whole merged set.
- A dependency that names **no issue at all** keeps the child waiting, where
  the old rule let it through: reading an issue that does not exist failed, and
  a failed read was not a block. A number that names nothing is a typo in the
  text, and the fix is the text.
- The message the front doors show is the one the rule now deserves: "a parent
  issue is not merged yet".
- The rule of 2026-11-01 that said a closed parent settles the dependency is
  replaced by this record. The rest of that record — the triage and scope
  branches, the review loop, the small-change skip — stands.

## Links

- `src/runner.ts` — `openDependencies` and `hasLanded`, the rule.
- `src/gh.ts` — `mergedPullRequestArgs` and `readMergedPullRequest`, the read.
- `src/session.ts` — `splitIssue`, the chain the rule governs.
- `src/prompts/00-scope.md` — the split prompt, which says when a piece starts.
- `docs/decisions/2026-11-01-the-work-is-a-conditional-graph.md` — the record
  whose dependency rule this one replaces.
