---
title: The chat the auto-attach opens keeps its worktree
status: accepted
date: 2026-10-31
authors: Command Code
deciders: Singularity Developer
tags: [extension, worktree, session, attach]
---

# The chat the auto-attach opens keeps its worktree

## Context

`/afk-runner-run` creates a work session whose `cwd` is the worktree. Since `353f11c` the live door
also **auto-attaches** as soon as that session exists: `attach()` calls `ctx.switchSession(transcript)`,
and Pi's `switchSession` rebuilds the runtime with the **session's** cwd, so the host chat's working
directory becomes the worktree.

The runner then removes the worktree at the end of every run — it is scratch, and the branch holds the
work. The host chat is left sitting in a directory that no longer exists: every `bash` call throws
`Working directory does not exist`, and any extension that reads `process.cwd()` throws `ENOENT`
(`~/.pi/agent/sessions/--home-max-afk-worktrees-issue-45--/` carried that error six times).

The manual `/afk-runner-attach` already restored a removed worktree before switching; the automatic
one did not.

## Idea

Two shapes, both in the attach path:

- **A.** drop the auto-attach, so the host never switches into a session whose cwd is the worktree;
- **B.** keep the auto-attach and make the worktree outlive the switch.

## Decision

**Option B.** After a run returns, if the door auto-attached during it, the door awaits that attach
and restores the worktree with the same `git worktree add` the manual attach uses. A review-only run
checked the worktree out detached and may have left no local branch, so when the branch cannot be
checked out the restore falls back to a detached worktree on the fetched commit. The restore lives in
one helper (`restoreWorktree`) shared by both paths, so the two cannot drift. A run started from the
CLI, which has no host to switch, still removes its worktree.

## Rationale

**Why B.** The README already promises that an attached session's worktree is restored because a
session whose working directory is gone can read nothing. The auto-attach is the same switch; it needs
the same promise. Option A would delete the behaviour `353f11c` added.

**Why not a worktree-lifetime mechanism.** The runner does not need to know a host is attached. The
worktree is scratch, the branch is durable, and the next run's implement step removes any leftover
before adding its own (`runner.ts`, `prepareWorktree`). Restoring once at the end is the whole
requirement.

## Consequences

- A worktree can outlive its run while the chat sits in it, on the branch the run pushed. Uncommitted
  changes are not restored: the worktree is re-created from the branch. The next run for the same
  issue removes it first.
- A review-only run on a checkout with no local branch restores a detached worktree on the fetched
  commit. The chat reads the right tree, but it is not on the branch.
- The `realpathSync` import was already unused; this change only removed it so the lint gate is clean.

## Links

- `src/extension.ts` — `restoreWorktree`, `attach`, the auto-attach, and the run's `finally`.
- `test/extension.test.ts` — `puts back the worktree the auto-attach left this chat in`.
- `README.md` — what `/afk-runner-run` and `/afk-runner-attach` promise.
- `docs/decisions/2026-10-30-the-work-session-is-the-runners-minus-the-runner.md` — the session whose
  cwd this is.
