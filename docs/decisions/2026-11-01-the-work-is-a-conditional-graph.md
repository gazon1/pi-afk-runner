---
title: The work session is a conditional graph, and the review loops until it passes
status: accepted
date: 2026-11-01
authors: CommandCode
deciders: Singularity Developer
tags: [session, workflow, queue, review, gate, dependencies]
---

# The work session is a conditional graph, and the review loops until it passes

## Context

The work session was a linear array: brief, implement, verify, next. Every issue
in the queue was worked, at whatever size it arrived; every run pushed with the
repository's pre-push hook; the review was made once, and a `fail` verdict left
the pull request red until a human looked.

Four things the run needs are branches, not steps:

- an issue that is already done, a duplicate, or too vague should be **closed**
  and the queue should move on, not worked;
- an issue too large for one run should become smaller issues, linked from the
  original, which is closed;
- a piece of a split issue should not start before the piece before it is done;
- a review that fails should get a fix and a second look, within the run's
  budget, before the run gives up on it.

The workflow engine is already the thing that runs the session. Its authoring
guide names the blocks for this: `phase()` and `agent()` for the turns, and
`gate()` for "repeat until a validator says it passed".

## Idea

Express the branch in the engine's own blocks — `phase`, `agent`, and plain
`if` on the token a turn returned — and express the review/fix cycle with
`gate`, rather than a traversal or a loop of our own.

## Decision

**The session's workflow is a branch.** The engine's script runs, in the engine's
own `phase`/`agent` blocks: the intake, a `triage` turn, and — only when the
triage says `work` — a `scope` turn. A `skip` closes the issue; a `split` files
the smaller issues and closes the original. Only a `fits` reaches brief,
implement, verify and next.

**Triage and scope are turns, and their decisions are tools.** The agent ends
the turn with `agent_issue_decision` or `agent_scope_decision`; the runner reads
the value and performs the effect. The runner writes — closing an issue, filing
issues, linking them — because that is the place the bounds live: a split is at
most eight pieces, and each piece's brief opens with `## Agent Brief`, so the
next run can work it. A decision the model did not make is the safe default:
`work` and `fits`, because the issue was labelled `ready-for-agent`.

**The review loop is `gate`.** `runReviewGate` gives the engine a thunk that
reviews, and a validator that says whether the verdict passed; a failure's
feedback buys a fix, and the fixed diff is reviewed again. A fix is a **new
session** — its context is the findings and the code, not the work session's
whole conversation — and the runner commits and pushes it before the next
review. The loop stops at a pass, at `MAX_FIX_ITERATIONS`, or when the run's
deadline leaves no budget.

**An issue waits for the parent it names.** A line that starts with
`**Depends on:**` (or `Blocked by:` / `Parent:`) names issue numbers; a piece
still open blocks the issue. A closed parent settles it: the runner cannot see
a merge that did not close the issue, and a human who closed it has said the
work is done. A split chains its pieces this way, so they run in order. The
check is best-effort: a read that fails does not block, because guessing wrong
in that direction holds an issue out of the queue for ever.

**A small change skips the long pre-push checks.** A diff of at most
`SMALL_CHANGE_MAX_FILES` files and `SMALL_CHANGE_MAX_LINES` lines skips the
repository's pre-push hook. The hook's detekt verdict over one module takes
minutes, and a handful of lines does not earn it; the run's own review still
reads the change, and an explicit request wins either way. CI is not skipped:
the merge pipeline still lands only a commit CI has judged.

**A skip or a split is a finished run, not a failure.** The run releases its
claim and leaves no pull request. The CLI and the live door say which happened
and why, and the sweep moves on.

**A review that never passes fails the run, with the finding on the issue.** The
failure path releases the claim, the branch and the pull request stay, and the
next run reads the finding as intake and continues the same branch. That is the
continuation: the issue is not re-filed, and the branch is not thrown away.

**Every issue gets a new context.** One session per issue, and one per fix
iteration; nothing carries a conversation from one issue to the next.

## Rationale

The engine's blocks are the mechanism this repository already depends on. A
traversal of our own — an edge map and a `while` — would be a second engine, and
the guide's `gate` already says "retry until the validator passes", which is
exactly the review loop. The branch itself is plain JavaScript because the flow
is fixed and small; a decision node is an `if` on the token the turn returned.

The runner performs the triage's and scope's effects because the bounds are the
runner's to hold. The agent could close an issue or create one with `gh`, and
then nothing would bound the queue or the split — the same reason the leftover
tool exists.

The dependency marker lives in the issue's text because the queue read already
carries the text a run reads, and a closed parent is the observable the runner
already has. GitHub's own relationship API would bind the runner to a second
surface for a rule the brief can state in one line.

The small-change skip is a trade: the hook is the repository's rule, so the
default is to run it; the size makes the default different where the cost is
larger than the value. An explicit `--no-verify` still wins.

## Consequences

- The review is no longer made **once** per pull request: it is made once per
  **diff**. A fixed diff is a new commit, and the newest review decides it, so
  the gate's rule is unchanged; the contract copy's "reviews once" now means
  that, and the target's copy should be updated when the target can be.
- The queue read costs one detail read per candidate that is about to be
  worked, to find its dependencies.
- A run can now end without a pull request, by closing or splitting its issue.
  The exit code is still zero: the run did what the queue asked.
- The pre-push hook's skip is visible in the run record's push step.
- The session's prompt list grew from four files to six; the build copies them
  as before.

## Links

- `src/workflow.ts` — the two scripts, `runWorkSession`, and `runReviewGate`.
- `src/session.ts` — the triage and scope tools, the action nodes, and the split.
- `src/prompts/00-triage.md`, `src/prompts/00-scope.md` — the two decisions.
- `src/runner.ts` — the dependency check, the small-change rule, and the loop.
- `src/gh.ts` — closing, commenting, and the dependency marker.
- `src/prompts/02-implement.md` — the small change's shorter gate.
