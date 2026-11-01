---
title: A branch on the remote is work only when it carries commits the base does not
status: accepted
date: 2026-10-31
authors: Command Code
deciders: Singularity Developer
tags: [branch, derivation, recovery, git, pull-request]
---

# A branch on the remote is work only when it carries commits the base does not

## Context

The state the runner derives treated the **existence** of `agent/issue-<N>` on the remote as "the
work was pushed", and planned the pull request for it.

Measured on 2026-10-31, against `gazon1/sing`, issue 1504:

```
[pull request] failed — gh pr create --repo gazon1/sing --head agent/issue-1504 --base main …
  failed (1): pull request create failed: GraphQL: No commits between main and agent/issue-1504
```

The branch was pushed at the commit it was created from — zero commits of its own. A run from before
the session step refused an empty tree (`353f11c`) did that; the agent finished its turns without
recording work, and the push sent `HEAD`, which was still the base.

The wedge is permanent. The branch exists, so every later run derives `Pushed`, skips the claim and
the session, and asks GitHub the same refused question. The staleness window cannot free the issue
either, because the branch outranks it in the derivation. Five runs failed this way in one afternoon,
and the queue behind the issue could not be reached.

## Idea

Ask the branch what it carries, not whether it is there.

## Decision

**`workBranch` is true only when the branch carries commits the base does not have.** A branch that
points at the base — or whose commits the base already has — carries no work, and the issue derives
as `Claimed` or `Orphaned` instead of `Pushed`. The question is the one `gh pr create` asks, and
both ends are fetched first.
(The question was first asked with `git rev-list --count <base>..<branch>`, per branch; it is now
asked of every branch at once — see `2026-11-01-the-queue-is-read-in-one-call.md`.)

## Rationale

**Why not refuse the pull request instead.** A step that fails on the empty branch still fails on
every later run, because the branch is the observable that put the issue there. The derivation is
where the wrong answer is, so the derivation is where it is fixed.

**Why the count, not the branch's sha against the base's.** Equality catches today's branch and not
the next one: a branch whose work already landed on the base is in the same position, and GitHub
refuses it for the same reason. The count needs nothing remembered, exactly as
`2026-10-30-a-failed-runs-branch-is-continued.md` decided for the local branch.

**Why fetching the base is not optional.** The comparison GitHub makes is against the base branch's
**current tip**, so the fetched base is what the branch is counted against — not a remote-tracking
ref that may be an hour old.

## Consequences

- An empty branch no longer blocks the queue: a fresh claim is left alone (a live run may still push),
  and a stale one is reclaimed and worked again, which fast-forwards the leftover branch on its push.
- Each claimed issue costs two fetches per run, one of the base and one of the branch. A branch that
  is not on the remote costs the `ls-remote` the runner already made.
  (The cost has since changed: the branches are read for all the issues at once — see
  `2026-11-01-the-queue-is-read-in-one-call.md`.)
- A branch whose work is already on the base is likewise not work; the issue is reclaimed rather
  than sent to a pull request GitHub would refuse.
- The session step still refuses to push an empty tree, so the state this record fixes cannot be
  produced again by a current build.

## Links

- `src/git.ts` — `branchesWithWork`.
- `src/runner.ts` — `observeIssue`, and the `R` row of the derivation table.
- `test/runner.test.ts` — `test_a_branch_with_no_commits_is_not_work`.
- `docs/decisions/2026-10-30-a-failed-runs-branch-is-continued.md` — the local-branch half of the
  same rule.
