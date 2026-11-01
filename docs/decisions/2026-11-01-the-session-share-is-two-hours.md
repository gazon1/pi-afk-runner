---
title: The work session's share of the budget is two hours, and the claim's staleness outlasts the run
status: accepted
date: 2026-11-01
authors: MiniMax Code
deciders: Singularity Developer
tags: [runner, budget, session, deployment]
---

# The work session's share of the budget is two hours, and the claim's staleness outlasts the run

## Context

A run on issue 1756 was cut off by the deadline in the middle of its
verification. The change was written, the ADR was in, the fast suites were
green — and the run had had an hour. The session was still working: the slow
desktop suite alone is a quarter of an hour, and the agent spent the second
half of its budget proving that 109 of the 111 failures it reported were the
base branch's.

An hour was not a measured number. It was a round number, and the target's
gate cost had grown past it: the session implements the change, runs the
gates itself, and — when the change touches a screen — runs the desktop
suite, which is a quarter of an hour on its own.

While this was being worked, the runner's budget became three **reserved
shares** (`src/budget.ts`): the work session keeps one, the gates keep an hour
each, and the review keeps what is left. The shares fixed a different failure
— a session that spent everything left the gates nothing to run with — and
left the session's share at the hour that had just cut a run off.

## Idea

The share is the number that matters. The ceiling on the run is the sum of the
shares, and it is already generous; what was too small is the part the session
gets.

## Decision

**The work session's share is two hours.** The ceiling on the run follows from
it: the shares added up.

**The claim's staleness window outlasts a live run.** The unit takes a dead
run's claim over after eight hours — longer than the five and a half hours a
run may spend — so a run that is still working keeps its issue.

**The unit passes no `--deadline-ms`.** The default is the shares added up;
a smaller ceiling would scale the shares down, and the session is the share
that is already the tight one.

## Rationale

**Why the share and not the ceiling.** Under the shares model the ceiling is
the sum, and the sum was never the binding constraint: the session's share
was. A run of issue 1756 died with an hour of *session*, while the ceiling
was still an hour and a half away. Raising the ceiling without raising the
share would have scaled every share down, and the session would have got
less.

**Why two hours.** It is what the session costs on the target: the
implementation, the gates it runs, and the desktop suite when the change
touches a screen. A cut turn's changes are never committed, so the session
that runs out of time loses everything it did.

**Why the staleness window follows the run.** The window is how long a claim
may sit before another run may take the issue over. It has to be longer than
a live run, or the sweep takes over an issue that is still being worked — the
issue's own lock does not help, because the lock is per issue and per host,
and the sweep is on the same host.

**Why the unit does not pass `--deadline-ms`.** The flag scales the shares:
`budgetShares` divides the ceiling it is given by the default and gives every
share its proportion. A ceiling smaller than the sum makes the session's share
smaller than the two hours this record sets — the opposite of the intent.

## Consequences

- A run's ceiling is five and a half hours: two for the session, an hour for
  each of the three gates, half an hour for the review.
- A unit installed from `systemd/pi-afk-runner.service` takes a dead run's
  claim over after eight hours. A hand-started run keeps the default of a
  week.
- The session is still the part that can be starved: it is two hours of a run
  that may take five, and the gates and the review have their own.

## Links

- `src/budget.ts` — the shares, and the ceiling they add up to.
- `systemd/pi-afk-runner.service` — the unit's staleness window.
- `systemd/README.md` — what the unit runs and how long a claim may sit.
- `docs/decisions/2026-11-02-the-runner-runs-the-repositorys-gates.md` — the
  gates step, and the shares it brought with it.
