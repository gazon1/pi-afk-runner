---
title: The shared checkout's git commands are one at a time, or safe at the same time
status: accepted
date: 2026-11-12
authors: MiniMax Code
deciders: Singularity Developer
tags: [git, sweep, concurrency]
---

# The shared checkout's git commands are one at a time, or safe at the same time

## Context

A sweep works several issues at once, and its workers share one checkout: one
`.git`, one set of refs, one `FETCH_HEAD`, one worktree registry. The decision
that gave the sweep its workers queued the two commands that were known to
collide — the fetch and the worktree commands — and left the rest alone, on the
assumption that the rest were safe.

The audit that assumption needed never happened, and three things were not
safe, or not safe for a reason anybody had written down:

- the **push of the work branch** was in no queue, and nothing said why it did
  not have to be in one;
- the **collection git starts by itself** — `gc --auto`, `git maintenance run
  --auto` — was on. A fetch, a commit and a push may start one, and in a
  checkout that several workers share a second one collides with the first:
  git then says "failed to run maintenance" and the command fails, and the
  sweep fails with it;
- two of the fetches — the one that reads a commit into a private ref, and the
  bulk one that reads the queue's branches — were outside the fetch queue. Every
  fetch writes the checkout's `FETCH_HEAD`, and updates the remote-tracking
  refs its refspec maps to, and git locks both.

And one function, `restoreWorktree`, removed a worktree and fetched a branch
outside both queues. Nothing called it: it came with the auto-attached chat,
whose extension is gone.

## Idea

Give the shared checkout one rule, and write the rule where the commands are.

## Decision

**Every git command that touches the shared checkout is either one at a time,
or safe to run at the same time — and the reason is written at the command.**

- **The fetches are one at a time** — all of them, through one queue: the one
  that updates a remote-tracking ref, the one that reads a commit into a
  private ref, and the bulk one that reads the queue's branches.
- **The worktree commands are one at a time**, as they already were.
- **The pushes are safe at the same time**, and the reason is written down: a
  push writes one ref of the remote, one that belongs to its own issue — the
  claim is exclusive — and it writes nothing in the checkout. The hook it runs
  is the worktree's own, in the worktree's own directory, with the worktree's
  own build cache.
- **The collection git starts by itself is off**: every git the runner runs
  carries `gc.auto=0` and `maintenance.auto=0`.
- **The reads, the object writes and the writes of private refs are safe at
  the same time**, each with its reason at the command.
- **`restoreWorktree` is gone.** Nothing called it, and a function nothing
  calls is a rule nobody keeps.

## Rationale

**Why the push is not queued.** The pre-push hook of the repository the runner
works in takes about nine minutes over a shared change. A queue would make the
sweep's slowest phase one at a time, for a hazard the remote already handles:
two pushes of different refs are ordinary git traffic. The reason is written
down instead, so a reader can check it rather than trust it.

**Why the collection is off rather than tolerated.** Git reports a failed
collection as the failure of the command that started it, so "tolerate it"
means reading the command's own answer and deciding that it was not fatal — a
rule about every git the runner runs, and a rule about what a failure means.
Turning the collection off is one option, in one place, for every command.

**Why the dead function is gone rather than repaired.** It removed a worktree
and fetched a branch without a queue. Repairing it would have made it correct
for a caller that does not exist; deleting it removes the chance that a caller
appears and finds a function that is wrong in a way nobody is watching.

**Why the reasons are written at the commands.** The one file that holds every
git call is the only place where the reasons can stay true: a command added
without a reason is the hole the next audit finds.

## Consequences

- Every fetch of a checkout takes its turn, including the two that used to run
  beside the others. A sweep's selection and review paths wait for one another
  there.
- The runner never collects the checkout it works in. The checkout is the
  user's, and a collection the runner did not ask for is a collection the
  runner did not get to judge.
- `restoreWorktree` and `RestoredWorktree` are gone from the module's surface.
  Nothing in the repository called them.

## Links

- `src/git.ts` — the queues, the reasons at the commands, and the options
  every git the runner runs carries.
- `docs/decisions/2026-11-05-the-sweep-works-several-issues-at-once.md` — the
  decision that gave the sweep its workers, and queued the fetch and the
  worktree commands.
- `test/git.test.ts` — the collection is off, and the fetches take their turns.
