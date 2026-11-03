---
title: The bound is one rule
status: accepted
date: 2026-11-05
authors: MiniMax Code
deciders: Singularity Developer
tags: [git, gh, timeouts]
---

# The bound is one rule

## Context

The runner starts children it cannot control: a `gh` that talks to GitHub, a `git` that talks to a
remote, a gate that builds. Each of them is bounded, and the bound has two halves: the child is
asked to stop at the bound, and the run stops waiting for it a moment later.

That second half was written twice. `src/gh.ts` had it for `gh`, and `src/git.ts` had it for `git` —
the same race against the same grace, with a grace constant of its own in each file. The two copies
answered the same question, and two answers to the same question drift: one of them would have been
given a different grace, or a different failure, and nothing would have said so.

The rule itself was already recorded — see
[2026-11-01-the-queue-is-read-in-one-call.md](2026-11-01-the-queue-is-read-in-one-call.md) for `gh`
and [2026-11-05-the-git-runs-through-simple-git.md](2026-11-05-the-git-runs-through-simple-git.md)
for `git`. What was missing was the place the rule lives.

## Idea

One helper, one grace, one place the rule is written.

## Decision

**`src/bound.ts` holds the rule.** `withHardStop(call, …)` races a call against a hard stop: the
call is the child's half of the bound, and the hard stop is the run's. `KILL_GRACE_MS` is the grace
the child is given, and it is one number for the whole runner.

**The child's own stopping stays with the caller.** How a child is asked to stop is the child's
business: `gh` is stopped by `execFile`'s timeout, `git` by an abort signal. The helper does not
know about either, and a rule that knew about both would be a rule about two things.

**The failure stays the caller's.** A `gh` that hung is a `GhCommandTimedOut` and a `git` that
hung is a `CommandTimedOut`; they say different things about different commands, and the helper
builds neither. It asks for the failure through a function the caller passes in.

## Rationale

**Why a helper and not a second careful copy.** The repository has one implementation per question:
two answers to the same question drift, and the copy that drifts is the one nobody watches. The two
copies of the bound were already equal — that is why nobody noticed them — and equality is not a
thing a rule can rely on.

**Why the grace is one number.** Five seconds is what a child that was asked to stop needs to stop.
A `gh` that needs more and a `git` that needs less would be two numbers, and two numbers are two
answers to the same question again. The ones that need less are the ones that are killed by the
signal rather than ignored by it.

**Why the failure is built by the caller.** What a caller catches is what the caller reads. `src/merge.ts`
reads the exit code of a failed merge, and `src/gates.ts` reads a timeout as a timeout; a helper
that raised one error for both would have replaced two readable failures with one unreadable one.

## Consequences

- `src/gh.ts` and `src/git.ts` both go through `src/bound.ts`, and `GH_KILL_GRACE_MS` and
  `GIT_KILL_GRACE_MS` are gone: the grace is `KILL_GRACE_MS`, in one place.
- A child that ignores the request to stop holds neither the `gh` path nor the `git` path: the run
  stops waiting at the bound plus the grace, and says so.
- The failure a hung child raises is still the caller's own — `GhCommandTimedOut` or
  `CommandTimedOut` — and still names the call that hung.
- The hard stop carries no output: a child that printed something before it was killed and ignored
  the signal is a child whose output the runner does not have. That is what the failure says, and
  it is the price of stopping the wait.

## Links

- `src/bound.ts` — the rule: the grace and the hard stop.
- `src/gh.ts` — the `gh` call under the bound.
- `src/git.ts` — the `git` call under the bound, and the failure it raises.
- `test/git.test.ts` — a `git` that ignores the kill signal does not hold the run.
- [2026-11-01-the-queue-is-read-in-one-call.md](2026-11-01-the-queue-is-read-in-one-call.md) — the
  rule as it was recorded for `gh`.
- [2026-11-05-the-git-runs-through-simple-git.md](2026-11-05-the-git-runs-through-simple-git.md) —
  the rule as it was recorded for `git`.
