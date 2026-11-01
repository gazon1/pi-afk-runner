---
title: The merge sweep spends one budget, divided as a work run's is
status: accepted
date: 2026-11-02
authors: MiniMax Code
deciders: Singularity Developer
tags: [runner, merge, budget, session]
---

# The merge sweep spends one budget, divided as a work run's is

## Context

`--merge` read `--deadline-ms` and passed it whole to every agent session it
started: the conflict resolution and the fresh review each got the run's
ceiling, not a share of it. Nothing bounded the sweep itself, so the unit's
`TimeoutStartSec=infinity` was the honest description of a run that could take
an hour per gate plus a full run budget per pull request, for every candidate
it found.

The work pipeline had already solved this: `src/budget.ts` divides the run's
ceiling into **reserved** shares — the session, the gates, the review — and
each phase asks what is left when its turn comes. Merge never adopted it,
because until the record named the reason, the difference was invisible: the
failure message said only "the merge session was cut off".

## Idea

The merge mode has the same three spending phases as a work run — an agent that
resolves, a gate that runs, an agent that reviews — so it can take the same
shares, out of one wall-clock for the whole sweep.

## Decision

**The merge sweep has one budget.** It starts when the sweep starts, and
`--deadline-ms` is its ceiling.

**Each step takes its share of what is left** — `budgetShares(remainingMs())`:
the resolution takes the session's share, the gate takes the gates' share, and
the review takes the review's share.

**The gate is clipped, not unbounded.** Its timeout is its own budget or what
the run has left, whichever is smaller. The gate's own hour is unchanged when
the run has more than that.

**A candidate that would start with nothing left is skipped.** It is left whole
for the next run, with the reason "the run's deadline left no budget"; it is not
a failure, as any other skipped pull request is not.

## Rationale

**Why shares and not one number per step.** The failure the shares fixed in the
work pipeline is the same here: a resolution that spends everything leaves the
gate and the review nothing, and a gate killed half-way through means the
resolution's work is thrown away with the worktree. Reserving the gate's and
the review's parts keeps every step able to finish.

**Why the sweep and not each pull request.** A per-pull-request deadline is what
the mode had, and it is what makes a sweep unbounded: N candidates meant N
budgets. The unit's timer is a period, not a bound.

**Why a skipped candidate is not a failure.** The merge contract says a skipped
pull request is not a failure — it is one the next run reads again. A clock that
ran out is the same state, with a reason that names it.

**Why the gate may still be killed.** A timeout the gate never chose is not a
verdict, so the runner keeps the gate's own hour as the upper bound and clips
only when the run has less. A run that dies in the gate loses nothing that was
not already the gate's answer.

## Consequences

- A merge sweep can no longer outlive `--deadline-ms` by more than the step that
  is running when the clock runs out.
- A long gate can consume the sweep; the pull requests after it are left for the
  next run, with a reason that names the clock.
- A sweep that leaves candidates for lack of budget exits `0`: they are skipped,
  not failed.
- A gate the run's own clock killed is not handed to the agent for a fix: there
  is nothing left to spend on the fix either.

## Links

- `src/merge.ts` — `remainingMs`, the per-step shares, and `verifyGate`'s clip.
- `src/budget.ts` — the shares, and the ceiling they add up to.
- `docs/decisions/2026-11-01-the-session-share-is-two-hours.md` — the shares the
  work run uses, and why they are reserved.
- `contract/merge.md` — what the merge mode may do.
