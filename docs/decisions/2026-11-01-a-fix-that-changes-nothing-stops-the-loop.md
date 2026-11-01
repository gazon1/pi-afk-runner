---
title: A fix that changes nothing stops the review loop
status: accepted
date: 2026-11-01
authors: Command Code
deciders: Singularity Developer
tags: [review, gate, workflow, fix, budget]
---

# A fix that changes nothing stops the review loop

## Context

The review loop is the engine's `gate`: review, and when the verdict failed, fix what it found,
commit, push, and review the fixed diff again. The fix is a model turn, and a model turn may
change nothing — the finding was already addressed, or the session stopped early, or it wrote a
comment and no code.

The loop did not notice. The runner committed the worktree anyway (`commitAll` is a no-op on a
clean tree), pushed the same commit, and reviewed the same diff again. The next verdict was the
same verdict, and the loop spent another review on it — up to `MAX_FIX_ITERATIONS` — to hear the
same answer. A fix that changed nothing bought a review of a diff that had not changed.

## Idea

Compare the worktree's head before and after the fix. If it did not move, the fix changed nothing,
and the loop has nothing to push and nothing to review again.

## Decision

**A fix that leaves the head where it was stops the loop.** The head is read before the fix and
after the runner's commit of the fix's work; the two are the same sha when the fix wrote nothing.
The loop does not push, does not run the gates on the unchanged tree, and does not review the same
diff again. The run fails the way an exhausted loop fails — the finding goes on the issue, the
claim is released, the branch and the pull request stay — and the reason it gives is that the fix
changed nothing, not only that the review failed.

**The stop is an error the engine cannot swallow.** The engine's `gate` cannot break out of its
loop: it runs the thunk, asks the validator, and tries again. So the fix raises
`FixChangedNothing` — a `WorkflowError` that is **not recoverable**, the kind the engine stops
the run on — and `runReviewGate` catches it around the run to come back with `noChange` set. A
recoverable error would have been swallowed and the loop would have carried on to the next review,
which is exactly what the fix is meant to prevent.

**The head is the witness, not the tree.** The head answers the question the loop asks: is there a
new commit to push? The runner's commit is a no-op on a tree nothing changed, so a fix that wrote
nothing leaves the head where it was — and a fix that wrote and reverted nothing is the same
thing. A fix that wrote something moves the head, whatever the content of that commit is.

## Rationale

**Why compare the head and not the diff.** The head is one `git rev-parse` before and one after,
and it answers the question the loop asks: is there a new commit to push? A diff against the base
would answer a different question — whether the *work* changed — and the work is what was already
reviewed.

**Why stop rather than try again.** The finding was not addressed. A second fix turn with the
same findings and the same tree is the same turn again, and the runner's budget is the scarce
thing: a review costs a session, and the run has a deadline. The failure is real, and it is
better said plainly — "the fix changed nothing" — than spent on another review of the same diff.

**Why the run still fails.** The work did not pass the review, and nothing about this fix changed
that. A run that ended "successfully" would leave the pull request red and the issue unclaimed,
and the next reader would have to guess why. The failure path is the one that leaves the finding
on the issue for the next run to read as intake.

## Consequences

- A fix that changes nothing costs one fix turn and no review: the loop stops where it is.
- The continuation comment on the issue says the fix changed nothing, so the next run reads a
  reason and not only a verdict.
- The gates do not run again on a tree the fix did not change: the tree they judged is the tree
  that is on the remote.
- Why a fix can change nothing is still the model's business, not the runner's: the runner notices
  the empty fix and stops, and the finding stays on the issue.

## Links

- `src/workflow.ts` — `FixChangedNothing`, and the `noChange` the review gate comes back with.
- `src/runner.ts` — the head comparison in the fix, and the continuation comment.
- `test/workflow.test.ts` — the loop stops on a fix that changed nothing.
- `test/runner.test.ts` — `test_a_fix_that_changes_nothing_stops_the_loop`.
- `docs/decisions/2026-11-01-the-work-is-a-conditional-graph.md` — the review loop this refines.
