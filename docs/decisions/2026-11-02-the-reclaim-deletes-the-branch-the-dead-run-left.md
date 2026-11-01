---
title: The reclaim deletes the branch the dead run left on the remote
status: accepted
date: 2026-11-02
authors: Command Code
deciders: Singularity Developer
tags: [recovery, git, branch, reclaim]
---

# The reclaim deletes the branch the dead run left on the remote

## Context

The reclaim takes over a claim a dead run left behind. It deletes the claim's ref, the dead run's
worktree and the dead run's **local** branch — and it leaves the branch on the remote alone.

The rework pushes over that branch, and a push is a fast-forward only when the branch's commits are
on the base the rework was made from. When the base was rewritten after the dead run's branch was
pushed — `main` force-pushed, or rebased — the branch's commit is no longer an ancestor of the new
base, and git refuses the push as a non-fast-forward:

```
! [rejected]        <sha> -> refs/heads/agent/issue-<N> (non-fast-forward)
```

The claim is released, the next run reclaims, and the push fails the same way. The wedge is the
same class as the empty branch one: the observable that put the issue there is the branch, and the
branch is what the rework cannot get past.

## Idea

Delete the branch on the remote as well. The reclaim already deletes it in the checkout, and the
rework pushes over it — so the branch has to be gone from both places, or the rework's push is a
fast-forward over a branch it may not fast-forward over.

## Decision

**`reclaimClaim` deletes `agent/issue-<N>` on the remote**, after the dead run's worktree and
local branch are gone. The rework's push then **creates** the branch instead of failing on the
leftover.

## Rationale

**Why the reclaim may delete it.** A reclaim is reached only when the branch carries no work: the
derivation counts the commits the branch has and the base does not, and a branch whose commits are
already on the base is not work
(`2026-10-31-a-branch-with-no-commits-is-not-work.md`). Nothing is lost by deleting a branch that
holds nothing.

**Why not force-push the rework over the leftover.** The runner does not force-push the work branch
anywhere else, and a force-push over a branch a human may be reading is a force-push in all but
name. Deleting the branch first says the same thing without the force: the branch is the runner's
own, and the rework's push creates it.

**Why the branch goes after the worktree and the local branch.** A branch that is checked out
somewhere cannot be deleted, and the dead run's worktree is where it was checked out.

**Why the delete skips the pre-push hook.** A delete pushes no tree, and the repository's hook
gates the tree that is being pushed. A hook with nothing to gate must not stand between the runner
and a branch it has to remove — the same rule the claim's delete follows.

## Consequences

- A rework after a reclaim pushes over a branch that is not there, and the push creates it. The
  rewrite of the base can no longer wedge the issue.
- The dead run's branch is gone from the remote when the reclaim took over. Its commits were not
  work — the derivation had counted them on the base — and the commit the branch pointed at stays
  in the runner's own checkout.
- The reclaim costs one `ls-remote` and one `push --delete` when the branch is on the remote, and
  nothing when it is not.

## Links

- `src/claim.ts` — `reclaimClaim`.
- `src/git.ts` — `deleteRemoteBranch`.
- `test/runner.test.ts` — `test_the_reclaim_deletes_the_branch_the_dead_run_left_on_the_remote`,
  `test_a_reclaim_pushes_over_a_branch_the_new_base_no_longer_contains`.
- `docs/decisions/2026-10-31-a-branch-with-no-commits-is-not-work.md` — what counts as work on a
  branch.
- `docs/decisions/2026-10-30-a-failed-runs-branch-is-continued.md` — the local half of the same
  rule.
