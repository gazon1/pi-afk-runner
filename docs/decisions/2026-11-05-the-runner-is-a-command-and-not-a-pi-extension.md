---
title: The door goes — the runner is a command, not a Pi extension
status: superseded
superseded-by: 2026-11-05-pi-is-gone
date: 2026-11-05
authors: MiniMax Code
deciders: Singularity Developer
supersedes: 2026-10-30-the-afk-runner-is-a-pi-extension, 2026-10-31-the-auto-attached-chat-keeps-its-worktree, 2026-11-01-only-a-gone-session-is-swallowed, 2026-11-02-a-restored-worktree-is-prepared
tags: [extension, cli, session, worktree]
---

# The door goes — the runner is a command, not a Pi extension

## Context

The runner had two front doors. The **command** (`src/cli.ts`) takes the lock, works one
issue or the whole queue, writes the record and gives the lock back; a systemd timer runs it
and the exit code is what the timer reads. The **door** (`src/extension.ts`) was a Pi
extension — a package Pi loads — which drew the run in Pi's own UI, registered
`/afk-runner-run`, `/afk-runner-stop` and `/afk-runner-attach`, published the run's status
into Pi's session entry, and let a human steer the run from the host session while it
worked.

The door was 860 lines, a module of its own (`src/live.ts`), 1 416 lines of tests, a
dependency of its own (`pi-queue-steer-factory`), a manifest field (`pi.extensions`), a
recipe in the justfile (`just live`) and a good half of the README.

Nobody used it. The runs that matter happen unattended, from the timer. The interactive
path was carried from the first days of the runner and never became the way it was run.

## Idea

Take the door out and let the command be the only way in.

## Decision

**The runner is a command, not a Pi extension.** `src/extension.ts` and `src/live.ts` are
gone. The manifest names no extension, and the package is not a Pi package any more: the
`pi.extensions` field and the `pi-package` keyword are out.

**What goes with the door.** `pi-queue-steer-factory` — the steer queue, which only the
door had — leaves the dependencies. `just live` leaves the justfile. The `/afk-runner-*`
commands leave with the extension.

**The version gate stays and moves.** The gate was the door's first line. The runner
drives Pi's SDK either way, so the gate is now the session factory's first line
(`src/cli.ts`): it runs before the first session is made, and a Pi outside the pinned range
is refused at the start of the run. The package still exports it (`src/index.ts`), because
a caller that embeds the runner needs it too.

**The session's own extensions stay.** The guard is installed **into** the session
(`src/guard.ts`), and the session discovers the target repository's own Pi packages. What
goes is only the mechanism that kept the package's own extension out of the session it
created — `isOwnExtension` and the `extensionsOverride` filter in `src/cli.ts` — because
there is no own extension to keep out.

**What survives of the records this one replaces.** The runner stays in its **own
repository**, for the same reason: the target is a Kotlin Multiplatform application with
its own gates, and a JavaScript toolchain inside it would put the runner's code under the
app's gates. The **claim stays an exclusive remote ref with a nonce** — a label cannot be a
lock, because adding one is idempotent. And the **run's content still does not leave the
machine**: no telemetry, no third-party service, because the content includes issue bodies
and the repository is public.

**The rule about a restored worktree survives in the runner.** The worktree the review
path puts back is prepared — the repository's own `scripts/setup-worktree.sh` runs in it —
because a worktree that holds tracked files only has no `.env`, no per-worktree hooks and
no private build home, and the gates fail in it for reasons that are not about the work.

## Rationale

**Why the door goes rather than being kept.** It is dead weight: nothing runs it, and
every change in it is a change the tests have to keep green. The runner's job is the run —
claim, worktree, agent, gates, pull request, review — and the door is a way of watching a
run that the run's own record and log already answer. The one thing it offered that nothing
else did was steering into the running turn, and it cost a dependency, a module, a recipe
and half the README.

**Why the gate moves rather than goes.** The gate protects the runner against a Pi it was
not written for. That risk did not go with the door: the runner still creates Pi sessions,
with the SDK's own API, and an SDK that changed its interface does not fail loudly. The
gate is a check on the SDK, not on the extension.

**Why the separate repository stands.** That reasoning does not touch the door: it is about
the target's gates, and about a JavaScript toolchain under an application's own review.

## Consequences

- The package is installed and run as a **command**: `npm ci`, `npm run build`, `node
  dist/cli.js`. `pi install -l --approve ./` no longer applies — there is nothing for Pi to
  load.
- `@earendil-works/pi-tui` leaves the peer dependencies: nothing imported it.
- The README, the justfile, the manifest and the CI job describe a command now; the CI job
  checks `dist/cli.js` where it checked `dist/extension.js`.
- **Lost:** the live chat, the `/afk-runner-*` commands, steering into the running turn and
  the transcript chat. The run's own record and its log file are what a human is pointed
  at.
- The copy of the contract in `contract/afk-runner.md` still describes the runner as a Pi
  extension and still gives the `pi install` line. It is a **copy** of the target
  repository's document and is not edited to match; the drift is recorded in
  [contract/README.md](../../contract/README.md).
- `src/extension.ts` was the only user of `src/live.ts` and of `pi-queue-steer-factory`;
  both go with it.

## Links

- `src/cli.ts` — the command, the session factory and the version gate.
- `src/version.ts` — the pinned range and the check.
- `src/guard.ts` — the guard the session runs under.
- `docs/decisions/2026-11-05-the-run-runs-on-mastra.md` — the engine the run moves to.
- `docs/decisions/2026-10-30-the-afk-runner-is-a-pi-extension.md` — the record this one
  replaces; what survives of it is above.
