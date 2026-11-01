---
title: A worktree the door puts back is prepared
status: accepted
date: 2026-11-02
authors: Command Code
deciders: Singularity Developer
tags: [extension, worktree, session, attach]
---

# A worktree the door puts back is prepared

## Context

The runner makes every worktree with the repository's own recipe: `scripts/setup-worktree.sh` runs
in it before anything else happens there, and it does what no generic worktree tool can — the
`core.bare` repair, the per-worktree `core.hooksPath`, the `.env` copy and the private Gradle
home. The contract says so, and the runner's own worktree steps do it — `prepareWorktree`, and
`checkoutPullRequestBranch`, which `prepareExistingWorktree` uses.

The live door is a second way a worktree is made. When a chat was switched into a run's session,
the run's cleanup removes the worktree as scratch, and the door puts it back
(`2026-10-31-the-auto-attached-chat-keeps-its-worktree.md`) so that the chat is not left standing
in a directory that is gone.

That restore ran `git worktree add` and nothing else. The worktree it made held **tracked files
only**: no `.env`, no per-worktree hooks, no private Gradle home. A human who carried on in the
chat the run had switched to, and ran `./check.sh`, got a failure that was not about the work.

## Idea

Two shapes for the restore:

- **A.** the door runs the repository's setup script in the worktree it puts back, the way the
  runner's own worktree steps do;
- **B.** the door leaves the worktree as `git worktree add` made it, and says in its message that
  the worktree is not prepared.

## Decision

**Option A.** After the door has re-added the worktree, `scripts/setup-worktree.sh` runs in it —
from the worktree's own copy of the script, because the script works on the checkout it lives in.

A worktree that is **still there** is not prepared again: the runner prepared it when it made it,
and preparing it twice would be the runner's own step done twice.

When the script cannot run — a repository without it, or a script that fails — the door says so in
its message, and the restore is reported as it is: the worktree is back, and it is not prepared.
The door does not pretend, and it does not re-derive what the script does.

## Rationale

**Why A.** The point of putting the worktree back is that the human can carry on in it, and the
gates are how the work is judged. A worktree that fails `./check.sh` for a reason that is not about
the work is worse than no worktree at all: it sends the reader looking for a fault in the change
instead of in the environment.

**Why the repository's script and not the door's own preparation.** The runner does not re-derive
what the script does anywhere else either — it asks the repository. A second implementation of the
`.env` copy and the hooks path would drift from the first, and the drift would show up as a gate
failure in a worktree nobody prepared by hand.

**Why not prepare a worktree that is still there.** The setup script belongs to the worktree's
creation. A worktree the runner made is prepared; a worktree the door puts back is prepared; a
worktree that was never removed is left as the runner left it.

## Consequences

- The door runs commands through one runner — `runCommand`, the same one the runner uses — and takes
  it as a dependency (`LiveDependencies.run`), so that one place decides how a command runs.
- The preparation is paid twice over a run's life: once when the runner makes the worktree, once
  when the door puts it back. That is the cost of a worktree a human can use.
- A repository whose setup script fails leaves the human with a worktree and a warning, not with a
  worktree that silently misses its `.env`.

## Links

- `src/extension.ts` — `restoreWorktree`, the preparation, and the two messages.
- `src/runner.ts` — `SETUP_SCRIPT`, `prepareWorktree`, `checkoutPullRequestBranch`.
- `test/extension.test.ts` — the worktree that comes back is prepared, and a worktree that was not
  removed is not prepared twice.
- `contract/afk-runner.md` — the worktree section, and what the setup script does.
- `docs/decisions/2026-10-31-the-auto-attached-chat-keeps-its-worktree.md` — why the worktree is
  put back at all.
