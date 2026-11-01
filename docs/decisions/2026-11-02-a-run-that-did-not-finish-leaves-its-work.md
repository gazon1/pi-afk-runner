---
title: A run that did not finish leaves its work on the branch
status: accepted
date: 2026-11-02
authors: MiniMax Code
deciders: Singularity Developer
tags: [runner, session, recovery, worktree, git]
---

# A run that did not finish leaves its work on the branch

## Context

A run on issue 1756 was cut off by the deadline in the middle of its
verification. The change was written, the ADR was in, the fast suites were
green — and all of it was in the worktree, uncommitted, because the agent
stashes its work before it runs a gate suite on a clean tree.

The release path removed the worktree, and the work went with it. The branch
`agent/issue-1756` was left where the base was: a branch with no commits of
its own, which is not work
(`2026-10-31-a-branch-with-no-commits-is-not-work.md`), and which the next
attempt moves to the base and works on from scratch
(`2026-10-30-a-failed-runs-branch-is-continued.md`).

The runner already keeps a failed run's **commits**: the branch survives the
release, and the next attempt continues it. What it did not keep was the work
that was only in the worktree — and the worktree is scratch.

## Idea

The unfinished work is worth as much as the finished work. It has to land
somewhere the next run looks, and the branch is the only place the next run
looks.

## Decision

**A failed run commits what it left in the worktree, on the branch, before the
worktree goes.** The commit says what it is — `wip: the work a run that did not
finish left behind` — and the record names the branch it is on.

**The commit is local.** The branch is not pushed, so the issue does not derive
as "pushed" and the next run works the issue rather than planning a pull
request for work nobody has reviewed
(`2026-10-31-a-branch-with-no-commits-is-not-work.md`).

**The implement turn reads the tree before it writes.** The prompt says the
tree may carry an earlier run's work, and that a `wip:` commit is work to
finish rather than to redo.

**The reclaim still deletes the branch.** A run that was killed outright is a
different interruption: the reclaim takes over a claim nobody is working, and
its own decision stands
(`2026-11-02-the-reclaim-deletes-the-branch-the-dead-run-left.md`). A branch
that a reclaim deletes is a branch whose work was redone — the price of
starting from a base the dead run never saw.

## Rationale

**Why the branch and not the worktree.** The worktree is scratch: it is
removed when the run ends, whether it succeeded or not, and the next attempt
removes whatever a killed run left. The branch is what the next attempt
continues — that is the whole of the existing machinery, and the work was
already reaching it. The runner had one gap in it: the files the agent had
not committed yet.

**Why a commit and not a stash.** A stash lives in the repository's own
`refs/stash`, not in the worktree, and it is a thing a human curates. A commit
on the branch is what the next attempt already knows how to find, and it says
in its message that it is unfinished.

**Why the commit is not pushed.** The derivation reads the branch on the
remote, and a branch that carries commits the base does not is "pushed work":
the next run would plan a pull request for it and skip the work session
entirely. The unfinished work must be visible to the next run and invisible to
the derivation, and a local commit is exactly that.

**Why the prompt says it.** The next run's agent opens a tree that already
carries an implementation. Without saying so, it redoes the work it was given
— which is the thing this decision is about. The message on the commit is not
enough on its own: an agent that does not read the log never sees it.

**Why the reclaim is left alone.** Its decision has its own reason — a push
over a branch whose commits the new base does not contain is refused as a
non-fast-forward — and a killed run is an interruption the runner did not
choose and cannot see the end of. Changing that is a decision of its own, and
it is not the one this record makes.

## Consequences

- A run that fails leaves its work on the branch, and the next run continues it
  instead of starting from the base.
- The branch of a failed issue carries a commit until the next attempt pushes
  it. The issue does not derive as "pushed" meanwhile, so the queue still sees
  it as work to do.
- The record of a failed run names the branch the unfinished work is on.
- The work the next run continues may be based on a base that has moved: the
  agent may have to rebase it. That is the price of durability, and it was
  already the price of a failed run's commits.
- A run that was **killed** still loses its work to the reclaim. Its branch is
  deleted and the work is redone.

## Links

- `src/runner.ts` — `preserveUnfinishedWork`, and the release path that calls
  it before the worktree goes.
- `src/prompts/02-implement.md` — the turn that reads the tree first.
- `src/git.ts` — `addWorktree`, which continues a branch that carries commits.
- `docs/decisions/2026-10-30-a-failed-runs-branch-is-continued.md` — the
  branch a failed run leaves is continued.
- `docs/decisions/2026-10-31-a-branch-with-no-commits-is-not-work.md` — what
  counts as work on a branch.
- `docs/decisions/2026-11-02-the-reclaim-deletes-the-branch-the-dead-run-left.md`
  — the reclaim, which stands.
