---
title: The branch's name and the pattern that recognises it live in one place
status: accepted
date: 2026-11-02
authors: Command Code
deciders: Singularity Developer
tags: [branch, guard, merge, contract]
---

# The branch's name and the pattern that recognises it live in one place

## Context

The branch an issue's work lives on — `agent/issue-<N>` — was written three times over. `workBranch`
named it. The guard that decides whether a worktree may be removed matched the branch against a
regular expression of its own, written out longhand inside `removeWorktree`. The merge pipeline
matched its candidates against a third pattern, in `src/merge.ts`.

The three did not disagree, because the name does not change. That is the whole point: they would
disagree the first time it did. And the disagreement is not a crash. A name that moved on one side
alone leaves the removal guard refusing the runner's own worktrees — a run that cannot release its
claim — or, worse, removing a worktree that belongs to somebody else. Meanwhile the merge pipeline
stops recognising the branches it is supposed to land, and the work it opened sits unlanded.

## Idea

One place owns the name **and** the pattern that recognises it, and the two places that have to
agree ask that place.

The pattern has to answer for two shapes. The merge pipeline sees a pull request's head — a branch
name. The removal guard sees what `git worktree list --porcelain` reports — a full ref,
`refs/heads/agent/issue-<N>`.

## Decision

**`src/git.ts` owns the work branch: the prefix, the segment, the name `workBranch` builds from
them, and the pattern `WORK_BRANCH_PATTERN` that recognises one.**

- `WORK_BRANCH_PATTERN` answers for a branch's name and for the full ref git reports: the prefix
  `refs/heads/` is optional. The issue number is the first group, so the merge pipeline reads the
  issue out of the very match the guard uses to say yes. The literal parts of the name are escaped
  before they go into the pattern, so a name that carries a `.` cannot widen what the guard
  accepts.
- The removal guard asks the pattern instead of carrying one of its own.
- The merge pipeline asks the same pattern. `src/merge.ts` re-exports it, so the pipeline's own
  surface does not change, but there is one pattern and not two.
- The branch's own name — `agent/issue-<N>` — does not change, and neither contract does.

## Rationale

**Why one pattern and not one per caller.** Two patterns for one name are two chances to disagree,
which is the thing this change exists to remove. The optional `refs/heads/` is a small concession
that lets both callers ask the same question of the same object.

**Why the pattern lives beside the name and not in a module of its own.** The name is what the
pattern recognises. A file that holds only a pattern has to be asked what it is a pattern *of*;
the file that names the branch says so.

**Why the merge pipeline re-exports the pattern.** Its contract names the branch, and the code
that applies the contract has always exported the pattern it applies. The export stays; the
pattern behind it moves.

## Consequences

- A change to the branch's name is a change in one file, and the removal guard and the merge
  pipeline follow it.
- `test/work-branch.test.ts` is the guard: the name is spelled once in the source, the pattern is
  defined once, the merge pipeline asks that very pattern, the removal guard removes a worktree on
  the runner's branch and refuses one on anybody else's.
- `test/merge.test.ts` says the merge pipeline still lands only the work pipeline's pull requests:
  a pull request on another author's branch is not a candidate.

## Links

- `src/git.ts` — `workBranch`, `WORK_BRANCH_PATTERN`, and `removeWorktree`'s guard.
- `src/merge.ts` — the candidate rule, which asks the pattern.
- `test/work-branch.test.ts` — the guard.
- `test/merge.test.ts` — the merge pipeline's own candidates.
- `contract/merge.md` — the merge pipeline's contract, unchanged by this.
