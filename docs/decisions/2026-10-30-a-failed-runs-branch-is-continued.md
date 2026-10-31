---
title: A failed run's branch is continued, and moved to the new base when it carries nothing
status: accepted
date: 2026-10-30
authors: Command Code
deciders: Singularity Developer
tags: [worktree, retry, recovery, git]
---

# A failed run's branch is continued, and moved to the new base when it carries nothing

## Context

A run that fails removes its worktree and releases its claim, and **keeps its branch**: the work a
run did is durable, and a push that never happened is not a reason to throw commits away.

What the next attempt met, measured on 2026-10-30 against a fixture repository:

```
[claim] ok — claimed from 2cf52713
[worktree] failed — git worktree add -b agent/issue-1 … failed (255):
fatal: a branch named 'agent/issue-1' already exists
```

The first failure was not the issue's fault — the target repository had no
`scripts/setup-worktree.sh` — and the issue was left **unworkable on that checkout for ever**, because
every later attempt took the claim and then died on `-b`.

The opposite failure follows from the obvious fix. A second attempt that simply reuses the branch
inherits **its** base commit: the run claims `origin/main` afresh, then works the main of an hour ago.
Measured: the retry's worktree sat on the old base, without the setup script the base had gained in
between.

## Idea

Keep the branch, but ask whether it carries anything of its own before deciding what it means.

## Decision

**`addWorktree` continues an existing branch, and moves it to the claimed base when it has no commits
of its own.**

```
branch exists?  no  → git worktree add -b <branch> <path> <base>
                yes → git rev-list --count <base>..<branch> == 0 ?
                        yes → git branch -f <branch> <base>   (nothing to lose)
                        no  → leave it where it is           (the work is durable)
                      git worktree add <path> <branch>
```

`git rev-list --count <base>..<branch>` counts the commits reachable from the branch and not from the
base, so it answers "did any work land here that the base does not already have?" without knowing
which base the branch was made from.

## Rationale

**Why not delete the branch on release.** The branch is the only place a failed run's commits live
until a push. Deleting it on every failure would make "the work a failed run did is durable" false,
and the durability is the reason the release path leaves it alone.

**Why the count, not a stored base.** The runner has no state store — that is a property of this
design, not an omission — so it cannot remember the base a branch was created from. The count needs
nothing remembered: no commits beyond the base means no work, whatever base that was.

**Why move a branch that has no work.** A retry that works an hour-old main is a retry that will
conflict with the base it is pushed onto, and the agent would be told to implement against code that
no longer exists. When there is nothing to lose, the fresh base is strictly better.

## Consequences

- A failed run's issue can be retried on the same checkout, which it could not before.
- A retry after a failure that produced **no** commits starts from the current `origin/main`; a retry
  after one that did starts from where that work stopped, and may need rebasing by the agent or a
  human — which is what "durable" costs.
- A worktree a killed run left registered on the same branch is **not** a hard stop: the worktree
  step removes the path it is about to use before creating it, so the next attempt cleans up its own
  leftover. The branch is what holds the work, and it is kept.
- A worktree is removed when the run finishes, whether it succeeded or not. The branch keeps the
  work; the next run that needs a worktree makes one. Only a run that is killed outright leaves one
  behind, and the next attempt removes it.
- `git branch -f` runs only when the branch is attached to no worktree — it is not checked out at
  that point, because the worktree is created after this decision.

## Links

- `src/git.ts` — `addWorktree`.
- `src/runner.ts` — `prepareWorktree`, and the release path that deliberately keeps the branch.
- `test/runner.test.ts` — `test_a_second_attempt_continues_the_branch_the_first_left`.
