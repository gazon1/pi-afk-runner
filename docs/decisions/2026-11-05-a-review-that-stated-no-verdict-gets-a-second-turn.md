---
title: A review that stated no verdict gets a second turn
status: accepted
date: 2026-11-05
authors: MiniMax Code
deciders: Singularity Developer
tags: [review, workflow, verdict, session]
---

# A review that stated no verdict gets a second turn

## Context

A live run against `gazon1/sing` (issue #1804) got all the way to the review: the claim, the
worktree, the session, the gates, the push and the pull request were all fine, and the review
failed with `the review of pull request 1808 stated no verdict`.

The reviewer was not cut off — a cut-off review says so — and it was not a failure of the
provider. It made eight tool calls, read the diff, and ended its turn with a sentence about what
it was about to do next. The verdict tool was never called.

The tool is the review's own last action: the review ends by calling it, and the runner reads
the verdict out of it. A turn that ends without it is a turn that decided nothing — the runner
cannot tell a reviewer that read the diff and found nothing wrong from a reviewer that stopped
half-way through reading it, because both of them end with prose.

That is the whole failure: **the runner had one chance to get a verdict, and a reviewer that
spent its chance on reading was treated the same as a reviewer that had nothing to say.** The
work was done, the gates were green, the pull request was open, and the run ended with a pull
request nobody had judged.

## Idea

The review gets a **second turn** when the first one stated no verdict — the same second chance
a gate's refusal gets
([2026-11-05-the-workflow-runs-the-gates](2026-11-05-the-workflow-runs-the-gates.md)): the
reviewer is told what is missing, in the same session, with everything it has already read still
in front of it.

The second turn is a **second chance, not an extra turn**: a review that stated its verdict ends
there.

## Decision

**The review is two states, and the second one is conditional.** The review session runs the
review prompt, and then — only when the verdict tool was not called — a reminder turn
(`VERDICT_REMINDER`) that says what is missing and asks for the verdict.

**The first verdict stands.** `createVerdictTool` records the verdict once
(`holder.value ??= verdict`): a second call cannot change what the review already decided. The
review is one verdict, and the comment the runner posts is one.

**The engine can skip a state.** The graph is the runner's own TypeScript, and a turn that is
only needed when the earlier turns did not do their job needs a way to say so. `runStates` takes
a `skip` predicate, asked before each state runs, and `runPromptArray` passes it on. The answer
is asked lazily — after the review turn — so the state that is skipped depends on what the
earlier one did.

## Rationale

**Why a second turn rather than a failed run.** A review that states no verdict is not a verdict.
But it is also not a judgement of the change: the reviewer did not say the change is good or
bad, it stopped. Ending the run there throws away work that was done and gates that were green,
because the model finished its turn in the wrong place. The runner already believes that a gate's
refusal deserves a turn of its own rather than the end of the run; a reviewer that stopped
without a verdict is the same kind of event, and the same answer fits.

**Why the same session.** The second turn has to see what the reviewer already read. A fresh
session would have to read the diff again, and would be asked for a verdict about a diff it has
not looked at — which is how a review turns into a guess.

**Why the turn is skipped when the verdict is there.** The reminder says the review did not end
with a verdict, and that is not true when it did. A turn that is only needed when it is missing
costs a model call on every review otherwise, and a prompt that states something untrue is a
prompt that teaches the model to expect the untrue.

**Why the first verdict stands.** The reviewer may call the tool twice — once by accident, once
on the second turn. The review that the pull request carries is one verdict: the first one that
was reached. A later verdict that overwrites it would change what the comment says about a diff
the reviewer had already judged.

## Consequences

- A review that stated no verdict costs one more turn, in the same session, and may still state
  no verdict — then the run fails as it did before, with the same reason.
- The graph grew one predicate: `runStates` takes `skip`, and `runPromptArray` passes it on. The
  work session's branch does not use it.
- A review that stated its verdict is unchanged: one turn, one comment, one verdict.
- The record of a run that needed the second turn says the review took two turns.

## Links

- `src/runner.ts` — the review's two states, the reminder, and the `skip` that keeps the second
  turn a second chance.
- `src/session.ts` — the verdict tool, and the first verdict that stands.
- `src/workflow.ts` — the `skip` the graph asks before a state runs.
- `2026-11-05-the-workflow-runs-the-gates.md` — the record this one follows: a gate's refusal
  comes back to the agent as a turn.
- `2026-11-01-a-review-that-is-cut-off-stops-the-loop.md` — the other way a review ends without
  a verdict: cut off, which is not this.
