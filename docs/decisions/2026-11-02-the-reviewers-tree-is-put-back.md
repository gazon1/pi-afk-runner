---
title: The reviewer's tree is put back
status: accepted
date: 2026-11-02
authors: MiniMax Code
deciders: Singularity Developer
tags: [review, worktree, git, session]
---

# The reviewer's tree is put back

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
leftover in, the head moved, and an empty fix looked like a real one. The
empty fix itself is already
[decided](2026-11-01-a-fix-that-changes-nothing-stops-the-loop.md); what was
missing was the tree that makes the comparison mean what it says.

## Idea

Put the tree back to the tree the reviewer judged, the way the gates put their
build back, and let the fix path compare the head before and after the fix's
own commit — on a tree that is clean.

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

The **branch** is named too. A plain `git reset --hard` moves whatever branch
is checked out, so a reviewer that checked out another branch would have that
branch moved to the head the review judged: a branch the review never judged,
and one that is not the runner's to move. The tree goes back on the branch the
review judged — that branch is moved by name, and the branch the reviewer
checked out is left where it is. The branch is detached first, because a branch
that is checked out in a worktree cannot be moved.

The restore happens before the verdict is read, so a session that failed
leaves nothing behind either: the tree goes back on the way out. A restore
that fails is said so in the runner's own words, and a session that failed as
well is named beside it — the two are one failure: the review did not happen,
and the tree it did not judge is not back either.

**A leftover is not kept in a commit of its own.** The brief allowed both — a
commit of its own, or the gates' restore — and the restore is the one that
holds the promise the brief makes: _a reviewer's leftover never reaches the
branch_. A commit of its own is still on the branch, and the branch is what
the pull request is made of.

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
- The review now needs the git it restores the tree with, so `reviewPullRequest`
  takes a `git` — the merge pipeline's review takes the same one.
- The merge pipeline's review restores its worktree too. That worktree is
  scratch, and its gate's build is not part of the branch.
- The reviewer is told the rule: the prompt says the tree is put back and the
  verdict is the only thing that leaves the session.
- A branch the reviewer checked out is left where it was. The review moves the
  branch it judged, by name, and says so in the failure when it cannot.

## Links

- `src/runner.ts` — `reviewPullRequest`, `restoreTree`, and the fix path's
  head comparison.
- `src/merge.ts` — the merge pipeline's review, and the git it restores with.
- `test/runner.test.ts` — the reviewer's leftover, and the empty fix.
- [2026-11-01-a-fix-that-changes-nothing-stops-the-loop.md](2026-11-01-a-fix-that-changes-nothing-stops-the-loop.md) —
  the empty fix, and the head comparison the clean tree makes meaningful.
- [2026-11-02-the-runner-runs-the-repositorys-gates.md](2026-11-02-the-runner-runs-the-repositorys-gates.md) —
  the restore the gates use, which this one reuses.
