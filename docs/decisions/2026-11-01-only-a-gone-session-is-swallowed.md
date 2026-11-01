---
title: Only a gone session is swallowed
status: accepted
date: 2026-11-01
authors: MiniMax Code
deciders: Singularity Developer
tags: [runner, extension, session, errors]
---

# Only a gone session is swallowed

## Context

The live front door reports through the host session it was handed: `publish` writes the run's
status entry and its footer line, `talk` sends the notifications. Each of them wrapped its calls in
a `catch {}` that caught everything, and the comment above said what the catch was for — *the
session may be gone* — while the code said *anything at all*.

The two are not the same. A session switch, a fork or a reload retires the context the runner
holds: the host says so and the calls on it throw
(`This extension ctx is stale after session replacement or reload.`). The run goes on without the
footer, and that failure has to be swallowed. But a mistake inside those bodies — a line that is
built wrongly, a call that is made on the wrong object — was swallowed the same way: the run went
on as if the host had answered, and nobody was told.

## Idea

Swallow the failure of a gone session, and let every other failure out.

## Decision

**`publish` and `talk` catch only the host's stale-context failure, and rethrow the rest.**
`isStaleContext` recognises it by the host's own words (`stale` in the message); a failure that is
not that is thrown, so that it is seen.

**The try around each call holds that call and nothing else.** The line `publish` writes is made
before the calls, so a mistake in it is never mistaken for a gone session.

**What failed is said before the stage is published.** A run that fails says what failed first, and
the stage is published either way: a status line that cannot be written must not keep the human
from hearing what failed.

**The rest of the front door keeps its comments.** The catches that stay — the prune, the removal in
`reset()`, the widget of the log — say why they are there. For the prune and the removal, the
failure that matters is the one the call after them reports.

## Rationale

**Why the stale-context failure is the only one that is swallowed.** It is the failure the host
raises on purpose, for a session that is gone: the run has outlived the chat it was started from,
and there is nothing left to report to. Everything else is either a mistake of ours or a bug of
the host's, and both are worth seeing.

**Why the failure is recognised by its message.** The host has no other way of saying it. A retired
context is a context whose `ui` accessor throws on the next read, and whose API throws on the next
call — the message is the contract. The runner keeps it in one place so that a host that words it
differently is one edit away.

**Why the run does not go on after such a failure.** A run that keeps going after a mistake in its
own reporting is a run whose report nobody can trust. The failure ends the run — in the command
that started it, or in the background — and the lock is released on the way out.

## Consequences

- A bug in the front door's reporting is loud: it fails the command that started the run, or ends
  the run in the background. The run does not carry on with a report nobody can trust.
- What the human hears about a failed run is the run's own failure, not the reporting's: the
  failure is said first, and the stage is published afterwards.
- A session switch keeps working as before: the run goes on, the footer is gone, and the status
  line is read back from the entry when the session is opened again.
- The rule depends on the host's wording. When the host changes it, `isStaleContext` is the one
  place to change — and a stale failure that is not recognised stops the run instead of being
  swallowed.

## Links

- `src/extension.ts` — `isStaleContext`, `publish`, `talk`, `restoreWorktree`.
- `test/extension.test.ts` — `a host that stops answering`,
  `keeps a worktree that git still knows, and the work in it`.
- `docs/decisions/2026-10-31-the-auto-attached-chat-keeps-its-worktree.md` — why the worktree is
  put back at all.
