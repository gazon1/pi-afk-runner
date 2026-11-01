---
title: The reviewer's tree is put back, and a fix that changed nothing is named
status: accepted
date: 2026-11-03
authors: MiniMax Code
deciders: Singularity Developer
tags: [review, worktree, git, session]
---

# The reviewer's tree is put back, and a fix that changed nothing is named

## Context

The reviewer runs in the worktree: the review needs the code, and the code is
there. Whatever that session leaves behind — a note, a scratch file, the
artifacts of a build it ran — stays in the tree.

The runner's own commits are made with `git add -A`, so a leftover is not
left in the tree: it goes to the remote. The next commit after the review is
the fix's, and the fix's commit carries the reviewer's file with it.

Measured on 2026-11-01, in a full run: a reviewer that wrote one file,
followed by a fix that changed nothing at all. The branch carried the
reviewer's file, the head had moved — so the fix looked as if it had changed
something — and the diff was reviewed a second time before the loop noticed
that the fix was empty.

Two things were tangled together. The **tree** the reviewer judged was not the
tree that was pushed, and the **head comparison** in the fix path — the one
that answers "did the fix change anything" — assumed a clean tree before the
fix. A reviewer's leftover broke that assumption: the fix's commit swept the
leftover in, the head moved, and an empty fix looked like a real one.

## Idea

Put the tree back to the tree the reviewer judged, the way the gates put their
build back, and let the fix path compare the head before and after the fix's
own commit — on a tree that is clean, so the comparison answers what it is
asked.

## Decision

**The review puts the worktree back.** `reviewPullRequest` reads the head
before its session and restores the worktree to it afterwards: the files the
session changed go, the files it left behind go, and the ignored files stay —
the worktree's own Gradle home, its `.env` copy and its build outputs are the
repository's, not the runner's to delete. It is the same restore the gates use,
and it happens whether the review passed, failed, or was cut off.

The head is **named** rather than left as it is: a reviewer that committed
something of its own moved the branch, and the tree that is pushed has to be
the tree the reviewer judged. One restore answers both — the gates' tree is
the current head, the review's tree is the head it judged — so there is one
implementation of "put the tree back", not two that can drift.

**A leftover is not kept in a commit of its own.** The brief allowed both — a
commit of its own, or the gates' restore — and the restore is the one that
holds the promise the brief makes: *a reviewer's leftover never reaches the
branch*. A commit of its own is still on the branch, and the branch is what
the pull request is made of.

**A fix that changed nothing is named, and the loop stops.** The fix path reads
the head before the fix and after the fix's commit. The tree is clean before
the fix — the review put it back — so a commit that moves the head is the
fix's own change and nothing else. An unchanged head means the fix changed
nothing: the findings were not addressed. The loop stops there, the run fails
with that sentence in it, and the findings go on the issue where the next run
reads them. The loop would otherwise review the same diff again, and the
second review says what the first one said.

The empty fix is a failure of its own (`EmptyFix`), and it is reported as an
unrecoverable one: a recoverable failure is retried by the engine, and the
retry would fix nothing and review the same diff again.

## Rationale

The runner's commits stage the whole tree, so anything in the tree is on the
branch. That is a rule the work session needs — the agent's work is whatever
it left — and a rule the review session must not be subject to: the reviewer
judges a change, it does not make one.

The restore is the one the gates already use, and the reason is the same: the
gates build in the worktree, and the artifacts would go to the remote with the
work. The reviewer may run a build too, and the note it writes is worth
nothing on a branch — the findings travel in the verdict, which is what the
review is.

The head comparison is only as good as the tree it compares on. Read on a
dirty tree it answers "did anything move", not "did the fix change anything" —
and the runner would believe the second and push the first. Restoring the tree
first is what makes the comparison mean what it says.

## Consequences

- A reviewer that writes anything in the worktree loses it. The findings still
  travel: they are in the verdict, and the verdict is in the review comment.
- A run whose fix changed nothing fails at the `review` step, with *the fix
  changed nothing* in the record and on the issue. It used to review the same
  diff up to four times and fail with *the review did not pass*.
- The review now needs the git it restores the tree with, so `reviewPullRequest`
  takes a `git` — the merge pipeline's review takes the same one.
- The merge pipeline's review restores its worktree too. That worktree is
  scratch, and its gate's build is not part of the branch.

## Links

- `src/runner.ts` — `reviewPullRequest`, `restoreWorktree`, and the fix path's
  head comparison.
- `src/workflow.ts` — `EmptyFix`, and the unrecoverable error it is reported
  as.
- `test/runner.test.ts` — the reviewer's leftover, and the empty fix.
- [2026-11-02-the-runner-runs-the-repositorys-gates.md](2026-11-02-the-runner-runs-the-repositorys-gates.md) —
  the restore the gates use, which this one reuses.
