---
title: The pull request is asked about before the claim
status: accepted
date: 2026-11-02
authors: Command Code
deciders: Singularity Developer
tags: [queue, review, pull-request, claim, recovery]
---

# The pull request is asked about before the claim

## Context

The runner derives an issue's state from six observables and keeps no journal of its own. The
claim label was the first of them to be asked about, so an issue without the label derived
`Queue` — whatever was behind it. The contract says one issue, one worktree, one pull request,
one review of that pull request, and two paths broke it.

**The queue never looked at an open pull request.** The queue path planned `work` for whatever it
found. A run that fails at the review step releases its claim — including a failure *after* the
pull request was opened — so the issue went back into the queue with its pull request open, and
the next run worked the issue again over the same branch and posted a second review on the same
pull request. The gate reads the **newest** marked comment, so a `pass` after a `fail` turned a
red pull request green on a review of a different diff.

**Two runners on two hosts could review the same pull request.** The claim excludes a second
*claim*, not a second *review*: `deriveState` answered `Opened` for any pull request without a
review comment, and it never looked at the claim's freshness. While host A reviewed pull request
#77, host B's hourly run saw the same issue claimed with an open pull request and no comment, and
reviewed it too.

## Idea

The claim says that a run is **working** an issue. The pull request is the **work**. Ask about the
work first, and let the claim say what it says: that somebody is on it right now.

## Decision

**`deriveState` asks about the pull request before the claim.** A pull request that exists puts
the issue out of the queue, and how far it got is what the pull request's own state says:
`Opened`, `Reviewed` or `Counted`. The work branch comes next (`Pushed`), and the claim label
last (`Queue`, `Claimed`, `Orphaned`).

**The queue is observed issue by issue, and the observation is the plan.** An issue with an open
pull request is planned as `review`, an issue whose branch carries work and has no pull request as
`pull request`, and only an issue with neither as `work`.

**A fresh claim on a pull request that has no review means somebody is reviewing it right now.**
The plan is `none` and the pull request is left alone. A claim that has gone stale is nobody's,
and the pull request is reviewed.

**The review step reads the pull request's comments before it reviews,** and skips when a marked
review is already there.

## Rationale

**Why the pull request before the claim.** The claim is released on failure, and a failure after
the pull request was opened is a failure like any other. What the claim says afterwards — nothing
is being worked — is true and useless; what the pull request says — the work is open, and it is
waiting for a review — is what the run has to do. A derivation that reads the label first cannot
see that, and the queue it produces is a queue of work that is already open.

**Why the branch before the claim too.** The same argument, one step earlier: a branch that
carries commits is work that was pushed, and a pull request was never opened for it. The run owes
that pull request, not another round of work.

**Why the claim's freshness, and not the claim itself.** The claim excludes a second claim, not a
second review, so holding the claim is not what keeps two hosts off one pull request. The
*freshness* of the claim is: a claim that is still fresh belongs to a run that may be reviewing
right now, and a claim that has gone stale belongs to a run that is gone. The staleness window is
already the runner's answer to "is anybody still there?", and this is the same question asked
about a review.

**Why the comments are read before the review, and not only before the post.** The gate decides on
the newest marked comment, so a second review of one pull request overrides the first. Reading the
comments first turns that into a skip rather than an override, and it does so before the run
spends a session on a review nobody will read. The check is in the review step and not inside the
review: the gate's loop reviews the *fixed* diff, and that review is the same run's answer to the
findings of the first one.

## Consequences

- A run that fails at the review step leaves a **red pull request** and an issue in the queue. The
  runner does not touch that pull request again: a pull request is reviewed once. The comment the
  run leaves on the issue says so, and the pull request is a human's to look at.
- A run that died before its review leaves a pull request **without** a review. The next run
  reviews it, and writes the verdict file the change needs — the slug is read from the diff, the
  same way the work path reads it from the work session.
- The queue costs more to read: every candidate is observed, so each one costs a pull request read
  and a branch read before it is planned.
- A **stale** claim is still not exclusive, and an **unclaimed** issue is not exclusive at all: two
  hosts can plan the same review at the same moment, and both review. The comment check narrows
  that window to the length of a review session; it does not close it. Closing it needs a claim
  the review path takes, which is a different change.
- An **interrupted** run keeps its claim (`2026-10-31-an-interrupted-run-releases-its-claim.md`), and
  a fresh claim is somebody else's review — so the interrupted run's pull request is reviewed when
  the claim goes stale, and not on the next tick. It is never worked a second time in the meantime,
  which is what the interrupt case is for.
- The fix loop leaves a `fail` comment on the pull request before it fixes anything. A run that
  dies between the fix and the second review leaves a pull request whose newest marked comment
  judges an older diff — red, which is the safe side of the gate's rule.

## Links

- `src/runner.ts` — `deriveState`, `planFor`, `chooseIssue`, and the review step.
- `test/runner.test.ts` — the derivation, the plan, and the runs that review an open pull request.
- `contract/afk-runner.md` — the rule this record enforces: one issue, one worktree, one pull
  request, one review of that pull request.
- `docs/decisions/2026-10-31-an-interrupted-run-releases-its-claim.md` — what an interrupted run
  leaves behind, and why the claim it keeps is now kept for the claim's own sake.
