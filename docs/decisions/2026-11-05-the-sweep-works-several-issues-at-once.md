---
title: The sweep works several issues at once
status: accepted
date: 2026-11-05
authors: MiniMax Code
deciders: Singularity Developer
tags: [runner, sweep, concurrency, cli]
---

# The sweep works several issues at once

## Context

A sweep worked one issue at a time. Each issue runs an agent session, a gate
and a review, and every one of those waits on the network — the model's answer,
the remote's answer, the CI's answer. The host sat idle through most of it, and
a queue of ten issues took ten times as long as the slowest part of each issue
required.

The runner already knew that several issues may be in flight at once: the lock
is **per issue** ([2026-11-01-the-lock-is-per-issue](2026-11-01-the-lock-is-per-issue.md)),
so a hand-started `--issue <N>` run and a sweep can work different issues on
one host without meeting. What was missing was the sweep doing it to itself.

Several ways to do it were available, and they are not the same thing:

- **several processes**, each with its own `--issue`: the timer would start more
  runners, and each would take the sweep's own lock, so they would not work the
  queue between them;
- **several workers inside one sweep**: one lock, one queue read, one journal;
- **one worker, several issues**: the issues were already independent, but only
  one was ever started.

## Idea

The sweep takes a number of workers. Each worker takes the next issue that is
free and works it to the end of its journey, while the others do the same with
the next issues.

## Decision

**`--all --workers N` works N issues at once.** The flag needs `--all`: it
means "the whole queue", and without a queue there is nothing to spread. One
worker is the default, so a run that does not name it behaves exactly as
before.

**The workers are inside one sweep, not several runners.** The sweep's lock is
taken once, for the whole sweep, and each issue takes its own lock while it is
being worked. The workers never meet on the same issue, and a second sweep on
the host still skips itself.

**The workers are equal.** Every worker works the same kind of issue, with the
same model pool and the same budget. The pool's best model is shared by all of
them: spreading the pool's models across the workers was considered and left
out, because the pool moves a session between models on its own, and two
sessions moving at once would need a second rule about who moves where.

**A line names the issue it belongs to.** The workers write to one stream, and
a line that does not say which issue it is about is a line nobody can read. The
tag is `issue <N> — `, and it is written only when there is more than one
worker: a sweep with one worker produces the journal it always produced.

**The git commands that touch the shared checkout are serialized.** The workers
share one checkout, and two of its commands are not safe to run at the same
time: `git fetch` on the same ref fails to lock it, and `git worktree prune`
(which `git worktree remove` runs) can prune a worktree another worker is
still registering. The fetch and the worktree commands each go through one
queue.

## Rationale

**Why workers inside the sweep.** The queue is read once, and the journal is
one list of issues. Several processes would each read the queue, each take the
sweep's lock (and each skip itself because of it), and each report its own
status — the timer would see several statuses and have to decide what they
meant.

**Why the per-issue lock is enough.** The lock's unit was settled before this:
one lock per issue, one for the sweep. A sweep with several workers takes the
sweep's lock once and each issue's own lock as it works it, so the workers are
kept apart by the same rule that keeps a hand-started run apart from a sweep.
Nothing about the lock changed.

**Why the tag is only written when there is more than one worker.** A journal
that a reader learned to read is a thing that should not change shape because a
flag was passed. The tag is also what makes a mixed stream readable at all, so
it is not a decoration that can be left off: it appears exactly when the lines
are mixed, and never otherwise.

**Why the git commands are queued.** These are not hypothetical hazards: two
`git fetch`es of the same ref in one checkout fail with `cannot lock ref`, and
`git worktree add` writes its registration before the directory exists, so a
`prune` in that window deletes it. The queue costs nothing — the commands take
milliseconds — and the alternative is a sweep that fails on its second issue.

**Why the models are not spread.** The pool is a file the host owns, and it
moves a session from one model to another as the run goes. With several
sessions, "spread the models" is a second rule about the pool, and the failure
it would cause — two sessions on one model that is out of its limit — is the
one the pool already handles by moving. One worker per model would also make
the sweep's cost depend on the pool's size, which is not the host's decision
to make through a flag.

## Consequences

- A sweep of N issues on a host that can carry M takes about N/M rounds.
- The flag is a usage error without `--all`; the runner says so and stops.
- A stop cuts every session that is alive, not just the one that was running.
- Every line a multi-worker sweep writes names its issue; a one-worker sweep is
  unchanged, byte for byte.
- The exit code, the summary line and the total still mean the same thing: the
  code of the failure of the issue with the smallest number, and the count of
  the issues that were worked.
- The systemd unit is unchanged and works one issue at a time. The number of
  workers is the host's to choose, in the unit's arguments.

## Links

- `src/cli.ts` — `ARGS.workers`, `parseArgs`, `sweep`, and the `AsyncLocalStorage`
  context that names the issue a line belongs to.
- `src/git.ts` — `fetchQueue` and `worktreeQueue`, the two queues that keep the
  shared checkout safe.
- `docs/decisions/2026-11-01-the-lock-is-per-issue.md` — the lock's unit, which
  is what makes several workers safe.
- `docs/decisions/2026-11-05-the-pool-asks-the-engine-what-it-carries.md` — the
  pool the workers share.
- `systemd/README.md` — the unit, and how an operator adds `--workers N`.
