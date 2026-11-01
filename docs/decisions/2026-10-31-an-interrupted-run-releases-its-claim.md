---
title: An interrupted CLI run releases its claim instead of dying with it
status: accepted
date: 2026-10-31
authors: Command Code
deciders: Singularity Developer
tags: [claim, signals, recovery, cli, sweep]
---

# An interrupted CLI run releases its claim instead of dying with it

## Context

The release step runs when a **step fails**. A process that is killed — Ctrl-C, a signal, a stopped
service — never reaches it, so the label and the claim tag stay on the issue.

Measured on 2026-10-31, against `gazon1/pi-afk-runner`:

- Issues 64 and 50 carried `agent-in-progress`, a claim tag on the remote and nothing else: no
  branch, no pull request, and no record under `build/diagnostics/` for either. The worktrees
  `/home/max/afk-worktrees/issue-64` and `issue-50` were still on disk.
- Both were left by runs killed while the session was retrying a model that answered `429`. The
  next sweep reported them as "held by another runner" and worked neither.

The designed recovery is the staleness window, and it is the wrong tool for a run that died on this
host: the window is a week by default (`DEFAULT_STALE_AFTER_MS`), the issue is blocked for that long,
and the value that would free it sooner is a flag somebody has to know to pass.

## Idea

Give the killed process a chance to do what the failed one already does: stop the turn, fail the
step, release the claim.

## Decision

**The CLI installs `SIGINT` and `SIGTERM` handlers that turn the signal into the stop the deadline
already uses.** The flag is the `stopped` callback the prompt array checks between turns; the
running session is aborted; the session step fails with the message it already has for a cut turn;
the failure path releases the claim and writes the record. A second signal exits with 130.

**A stop after the work was pushed keeps the claim.** The pull request is that issue's state now, and
the claim keeps the issue out of the queue. The worktree is still removed: it is scratch.

> The claim used to be what pointed the next run at the pull request — released, the issue had no
> label, derived as `Queue`, and the next run worked it a second time. The pull request is derived
> without the claim now (`2026-11-02-the-pull-request-is-asked-about-before-the-claim.md`), so the
> claim is kept for the claim's own sake: a fresh claim is somebody else's work, and the pull
> request is left alone until the claim goes stale.

The sweep reads the same flag between issues: a human who stopped the run stopped the sweep, not one
issue of it.

## Rationale

**Why not shorten the staleness window.** The window protects a *live* run, possibly on another
host, from being taken over. Making it short enough to recover a killed run in minutes would let a
slow run lose its issue. The signal is the one case where the runner knows the run is over.

**Why not release in a shutdown hook around the steps.** The release needs what only the plan has:
the issue number, the worktree and the claim. The failure path already owns that state; a second
path would duplicate it and drift.

**Why the second signal exits anyway.** A human who insists must be able to kill the process, even
at the price of the claim. That is the same trade the stale window makes, without the wait.

## Consequences

- Interrupting a run costs the abort's settling time — the release and the record still run.
- An interrupt during the review keeps the claim, so the next run does not work the issue again; it
  resumes at the review once the claim goes stale, and the review reports the same cut turn the work
  session does. A fresh claim is somebody else's review
  (`2026-11-02-the-pull-request-is-asked-about-before-the-claim.md`), and an interrupted run's claim
  is fresh.
- A sweep stopped between issues exits non-zero: issues were left in the queue, and a zero would
  say the queue was drained.
- The CLI's exit code is the step's, not 130, on a single signal; 130 is reserved for the second.
- `SIGKILL` cannot be handled. A claim left that way is still recovered by the staleness window,
  or by hand.
- The channel that releases claims now exists for both kinds of failure: a step that fails and a
  process that is asked to stop.

## Links

- `src/cli.ts` — `main`, the `interrupt` handler, and the sweep's check.
- `src/session.ts` — `runPromptArray`, the `stopped` callback the signal feeds.
- `test/runner.test.ts` — `test_an_interrupted_run_releases_its_claim`.
- `docs/decisions/2026-10-30-a-failed-runs-branch-is-continued.md` — what the next attempt does with
  a branch a failed run left.
