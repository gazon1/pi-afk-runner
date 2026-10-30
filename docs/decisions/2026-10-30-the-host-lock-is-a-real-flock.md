---
title: The host lock is a real flock, and the runner is therefore a Linux tool
status: accepted
date: 2026-10-30
authors: MiniMax Code
deciders: Singularity Developer
tags: [runner, lock, flock, linux, deployment]
---

# The host lock is a real flock, and the runner is therefore a Linux tool

## Context

The runner is unattended: a timer starts it, it works one issue, it exits. Two runners on one host
must not work at once — they would fight over the worktree root, the Gradle home and the record
directory.

The **claim** on the issue is the layer that excludes a runner anywhere, and it is enough for the
cross-host case. This decision is about the layer below it, on one host.

The obvious implementation — a lock file, created with `O_EXCL` and deleted on exit — has two
failures that matter here. A runner that is killed leaves the file behind, and the next runner
blocks on it for ever; and a lock that is only a *marker* is not a lock at all, because the label
cannot be one either: adding a label is idempotent, so two runners would both "win" it.

The host is a Linux workstation, and `flock(1)` is there.

## Idea

Take a real `flock(2)` advisory lock, on a file in a writable directory, for the whole run.

## Decision

**The host lock is `flock(1)`, and the runner requires it.**

The lock is taken by a child process: `flock --nonblock --no-fork <file> sh -c 'echo locked; exec
sleep …'`. The holder prints a line once the lock is its own and then blocks, so the parent knows
it has the lock without polling, and `--no-fork` keeps the holder in the process `flock` itself, so
that ending the child ends the lock. A forked holder would leave the lock behind when the parent
was killed — the exact failure the decision is about.

Two outcomes are distinguished, and both are loud:

- the lock is **held** — the runner exits immediately, having read nothing and written nothing;
- the lock **cannot be taken** — the directory is not writable, or `flock` is not installed — the
  runner exits non-zero, naming the lock.

Neither is ever a successful run that selected nothing. A runner that could not take the lock must
never look like a runner that had nothing to do.

## Rationale

An advisory lock is released by the kernel when the holding process dies. That is the property a
lock file cannot have without a staleness rule, and a staleness rule is a clock: the runner would
have to decide that a lock older than X belongs to a dead runner, and that is a guess about a
machine's clock, made by a process that may itself be wrong.

`flock(1)` also gives the failure modes for free. The conflict exit code says the lock is held; any
other exit says the lock is unusable, with `flock`'s own message on stderr — which names the file.

The cost is Linux. `flock(1)` is a util-linux tool, and macOS has no equivalent in the base system.
That is accepted: the runner's host is a Linux workstation, the target repository's own tooling is
Linux, and a runner that cannot take the lock says so rather than running two of itself.

## Consequences

- The runner needs `flock(1)`. Elsewhere the lock is unusable and the runner refuses to start.
- The lock directory must be writable by the user the runner runs as. The default is
  `<checkout>/build/afk-runner`; a systemd unit may point it elsewhere.
- The lock is **host-local**. It excludes nothing on another host — that is the claim's job, and
  the two layers are not interchangeable.

## Links

- `src/lock.ts` — the lock.
- `src/cli.ts` — the exit codes: `75` is the lock held, `76` is the lock unusable.
- `systemd/README.md` — what the codes mean to whoever reads the unit's status.
- `docs/decisions/2026-10-30-the-afk-runner-is-a-pi-extension.md` — the runner's own decision, and
  the three layers of exclusion it describes.
