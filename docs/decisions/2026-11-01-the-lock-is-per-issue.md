---
title: The host lock is per issue, and a merge has one of its own
status: accepted
date: 2026-11-01
authors: Command Code
deciders: Singularity Developer
tags: [runner, lock, flock, parallelism, merge]
supersedes: 2026-10-30-the-host-lock-is-a-real-flock
---

# The host lock is per issue, and a merge has one of its own

## Context

The host lock
(`2026-10-30-the-host-lock-is-a-real-flock.md`) is one `flock` for the whole
machine: one runner at a time, because two runs on one host were said to fight
over the worktree root, the Gradle home and the record directory.

All three of those are already per issue. A worktree is
`<worktree-root>/issue-<N>`, a record is `build/diagnostics/issue-<N>/`, and
the private Gradle home lives inside the issue's worktree. Two runners working
two different issues share nothing but a read of the checkout and their own
`gh` calls. The one lock turned that into a queue: a second run on a different
issue exits `75` for no reason.

Merge is a second problem. It never works an issue, its worktrees are
`pull-request-<N>`, and its candidates are pull requests whose review and CI
have already judged them. Holding the work lock there meant a merge waited for
whatever issue a worker was on, and a worker waited for a merge.

## Idea

Keep the `flock` mechanism exactly as it is, and make the lock's **scope** the
unit of work instead of the host: one file per issue, one for the sweep, one
for merge.

## Decision

**A work run takes the lock of the issue it works; a merge takes its own.**

- `--issue <N>` takes `issue-<N>.lock`. Two runs on one issue cannot work it at
  once — the second exits `75` having read nothing — and runs on different
  issues do not see each other.
- `--all`, and a run that picks the queue's first issue, take `runner.lock`:
  the issue is not known before the scan, and a sweep is one queue-wide unit.
  Each issue the run then works takes that issue's own lock too, for as long as
  that issue's run lasts. The lock is taken inside the run once the issue is
  chosen, so a sweep and a `--issue <N>` run exclude each other on an issue,
  and two sweeps still exclude each other as a whole.
- `--merge` takes `merge.lock`. It does not look at the work locks and the work
  runs do not look at it, so the two run side by side; two merges still exclude
  each other, because they share `pull-request-<N>` worktrees.

The mechanism is unchanged: a real `flock(1)`, taken by a child process with
`--nonblock --no-fork`, released by the kernel when that child dies. The runner
still requires `flock(1)`, so the host is still a Linux workstation, and a lock
that cannot be taken is still a loud `76`.

## Rationale

**Why the issue is the right unit.** The claim on the issue already excludes a
runner anywhere; the host lock is the local backstop for the same issue. Making
it the same unit means the two layers finally agree, and the host's capacity is
the machine's, not one issue's.

**Why the sweep keeps `runner.lock`.** A sweep reads the queue once and works
it by number. Two sweeps would choose the same first issue and race on its
claim, which the claim resolves, but there is no gain in letting them try.
Each worked issue still takes its own lock, so the sweep and a named run on one
issue are excluded by the lock rather than by the claim alone.

**Why merge gets a file rather than no lock.** Merge shares
`pull-request-<N>` worktrees between its own runs, and `gh pr merge` is not a
compare-and-swap. A file of its own keeps two merges apart without making
either wait for an issue.

**Why merge may run beside the work.** A candidate has already passed its newest
review, carries `agent-reviewed`, and has a green CI. A work run that reworks
the same branch moves it under the merge, and the landing names the commit it
checked (`gh pr merge --match-head-commit`): GitHub refuses the merge if the
branch moved, so the race is a failed step, not a merged one.

## Consequences

- Several runners may work different issues on one host at once. The lock
  directory holds one file per issue in flight, plus `runner.lock` and
  `merge.lock`.
- The exit codes do not change: `75` says the lock the run needs is held, `76`
  says it could not be taken. The message names the file, so `issue-110.lock`
  and `runner.lock` are distinguishable.
- A merge no longer waits for a sweep, and a sweep no longer waits for a merge.
  Its landing names the commit the run checked, so a branch that moves under it
  is refused rather than landed.
- The target repository's contract does not mention the host lock, so nothing
  copied from it changes.

## Links

- `src/lock.ts` — `workLockName`, `lockNameFor`, `MERGE_LOCK_NAME`.
- `src/cli.ts` — the lock the run takes, per mode.
- `src/runner.ts` — `RunOptions.lockIssue`, the issue lock a queue-chosen run
  takes once the issue is known.
- `src/extension.ts` — the single-issue run, which takes the issue's lock.
- `src/git.ts` — `fetchCommit`, the per-run ref a remote read comes from.
- `test/runner.test.ts` — `test_two_issues_do_not_wait_for_each_other_or_the_sweep`,
  `test_two_runs_on_one_issue_do_not_work_it_at_once`,
  `test_a_sweep_leaves_an_issue_another_run_is_working`,
  `test_two_runs_work_two_issues_at_once`,
  `test_a_merge_does_not_wait_for_the_work_lock`.
- `docs/decisions/2026-10-30-the-host-lock-is-a-real-flock.md` — the mechanism
  this decision keeps.
