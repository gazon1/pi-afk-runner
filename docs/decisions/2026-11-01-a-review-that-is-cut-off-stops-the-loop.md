---
title: A review that is cut off stops the review loop
status: accepted
date: 2026-11-01
authors: Command Code
deciders: Singularity Developer
tags: [review, gate, workflow, budget]
---

# A review that is cut off stops the review loop

## Context

The review loop is the engine's `gate`: review, and when the verdict failed, fix what it found,
commit, push, and review the fixed diff again. The review is a model turn, and a model turn can be
cut off — by the deadline, or by a human's stop.

The loop did not notice. The review raised a plain error, and the engine does not know a plain
error: an unknown failure is **recoverable**, so the engine logged it, returned nothing, and the
loop carried on. The gate's validator reads "nothing" as a failed verdict, so the loop bought
another fix turn and another review — of the same diff, because the fix before it never committed
anything either. That happened once per attempt, up to the loop's limit.

Measured on 2026-11-01, with the review loop alone: a review that was always cut off was swallowed
every time, and the loop ran the full number of attempts, each one a fix session and a review
session against a diff nothing had changed. Nothing in the run's record or on the issue named the
cut-off review: the run said the review did not pass, and the finding was the only reason given.

The fix that was cut off already had its own stop — see
[2026-11-01-a-fix-that-changes-nothing-stops-the-loop.md](2026-11-01-a-fix-that-changes-nothing-stops-the-loop.md).
The review did not.

## Idea

A review that was cut off stated no verdict. There is no finding to answer, so there is nothing to
fix and nothing to review again: the loop ends where it is, and the run says that the review was
cut off and what cut it off.

## Decision

**A review that was cut off stops the loop.** There is no verdict to answer the finding, so the
loop does not buy a fix turn and does not review the same diff again. The run fails with the
cut-off as its reason, the work the run left stays on the branch, and the next run continues it.

**The cut-off is the engine's own abort error.** The review raises `cutOffError` — a
`WorkflowError` that is **not recoverable**, the kind the engine stops the run on. A plain
failure would have been swallowed: the engine logs it, returns nothing, and the loop carries on to
the next attempt, which is exactly what the review's cut-off is meant to prevent. The engine's
`gate` has no break of its own, so an error the engine stops on is the only way out of the loop.

**The loop's verdict says the cut-off, and the run says it too.** `runReviewGate` comes back with
`cutOff` set — the message the cut-off carried — next to the `noChange` the loop already had for a
fix that changed nothing. The runner reads it before it reads the findings: a review that was cut
off is **not** a review that failed, so the continuation comment — "the review did not pass after
N review(s)" — is not posted, and the run's failure names the cut-off instead. The record's step
for the review says what was cut off and what cut it off, next to the steps that finished.

**The two cut-offs are told apart by what they say.** A review that was cut off and a review that
answered are told apart the way a fix that was cut off and a fix that wrote nothing are told
apart: the record names the cut-off, and the reason is not reported as a review that failed. A
review that answers a verdict is unaffected — the loop still fixes and reviews again.

## Rationale

**Why the loop stops rather than tries again.** The review stated no verdict, so there is no
finding. A fix turn with no finding has nothing to fix, and a second review of a diff nothing
changed buys the same answer. The runner's budget is the scarce thing: a review costs a session,
and the run has a deadline.

**Why the cut-off is not a failed review.** A review that said `fail` names a finding, and the
finding is what the next run reads as intake. A review that was cut off names nothing: reporting
it as a failed review sends the next run after a finding that was never made, and hides the
reason the run really stopped — the clock, or a human.

**Why the run still fails.** The pull request carries no verdict, and the run is over: the claim
is released, the branch and the pull request stay, and the next run continues them. A run that
ended "successfully" would leave a pull request nobody had judged and an issue nobody could read
the state of.

**Why the work is kept.** The cut-off is the run's own end, not a failed change: the work the
run left is on the branch, and the next run continues it.

## Consequences

- A review that is cut off costs one review session and no fix turn: the loop stops where it is.
- The run's record names the cut-off review and what cut it off.
- A review that was cut off is not reported as a review that failed, and a review that failed is
  not reported as a review that was cut off.
- A review that answers a verdict is unaffected: the loop still fixes and reviews again.
- Why a review session is cut off is still the model's business, not the runner's: the runner
  notices the cut-off and stops, and the next run reviews the diff again.

## Links

- `src/workflow.ts` — the `cutOff` the review gate comes back with, and the abort error the
  engine stops the run on.
- `src/runner.ts` — the cut-off the review raises, and the run that reports it instead of a
  failed review.
- `test/workflow.test.ts` — the loop stops on a review that was cut off.
- `test/runner.test.ts` — `test_a_review_that_is_cut_off_does_not_review_the_same_diff_again`.
- `docs/decisions/2026-11-01-a-fix-that-changes-nothing-stops-the-loop.md` — the fix's own stop,
  and the reason the review needed one too.
