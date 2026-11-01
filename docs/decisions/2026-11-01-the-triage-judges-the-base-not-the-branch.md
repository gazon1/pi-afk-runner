---
title: The triage judges the base, not the issue's own branch
status: accepted
date: 2026-11-01
authors: Command Code
deciders: Singularity Developer
tags: [session, triage, worktree, prompts]
---

# The triage judges the base, not the issue's own branch

## Context

A run on issue 1751 ended in triage with:

```
issue 1751 was closed as not needed — Already fixed by commit 593aa7ca on agent/issue-1751
```

Nothing about it was on `origin/main`. The commit was on the issue's **own** branch, put there by an
earlier run of the same issue
(`2026-11-02-a-run-that-did-not-finish-leaves-its-work.md`). The run's worktree reused that branch,
so the triage read a tree that already carried an implementation and answered "already done" — and
closing the issue left the work on a branch nobody would ever push.

The triage prompt said the opposite of the implement prompt: the implement turn is told the tree may
carry an earlier run's unfinished work, and the triage was told "already done — the code and the
tests say so" without being told **which** code.

## Idea

The triage cannot tell the base from the branch by looking at the tree, and the runner knows both. Say
so.

## Decision

**The work session's system prompt carries a `worktree` section that names the issue's branch, the
base branch and commit the claim recorded, and the commits the branch already carries that the base
does not.** The runner reads those commits with `git log <base>..HEAD --oneline` before the session
starts, so the agent is told them rather than asked to find them. The triage prompt says that
"already done" means the **base** has the change, and that `git show <base>:<path>` is the base's
copy of a file.

**A skip records what it discarded.** The step's line in the run's record says how many commits the
branch carried when the issue was closed — the same count, read once.

## Rationale

**Why the system prompt and not the prompt file.** The branch, the base commit and the commits the
branch carries differ per run and per issue; the prompt file is static. The brief's location is in the
system prompt for the same reason, and the section sits next to it.

**Why the runner reads the commits and not the agent.** An instruction to run `git log` is a step the
agent may skip, mistype or obey differently from its intention; the runner already has the worktree and
the git runner at that point. The fact is cheap to read once and worth stating outright.

**Why `git log`, not `git diff`.** `addWorktree` leaves a branch with commits of its own where it is
(`2026-10-30-a-failed-runs-branch-is-continued.md`), so the branch's real base can be older than the
base this run claimed. In that case a two-dot diff compares two trees and shows the base's own changes
as if the branch made them — measured: an untouched file appeared changed. `git log <base>..HEAD`
names only the commits reachable from the branch and not from the base, which is the question that
matters and the same one `branchesWithWork` asks.

**Why not a guard that refuses a `skip` on a branch with commits.** A skip is legitimate for reasons
that have nothing to do with the tree — a duplicate issue, a brief too vague to work
(`src/prompts/00-triage.md`). The runner has only the reason's free text, and refusing every skip
where the branch carries work would force work on issues that should be closed. The fact the triage
was missing is a fact, and it is given to the triage.

## Consequences

- A triage that reads work on the branch no longer reports the issue as fixed; the run continues that
  work and pushes it.
- The work session carries one more system section, and `startAgent` now requires the worktree facts
  as an argument: a caller cannot start a work session without saying which branch it is on. A session
  the runner starts outside a worktree (a review, a fix) does not get the section.
- The record of a skip says how many commits the branch carried the base does not have, so a human
  sees what the close discarded without reading the transcript.
- The `implement` and `scope` prompts' notes about the earlier run's work stay: they are the turns
  that write on top of that tree and that size the brief against it.

## Links

- `src/session.ts` — `worktreeRule`, `WORKTREE_SECTION`.
- `src/runner.ts` — the session step, which passes the base the claim recorded.
- `src/prompts/00-triage.md` — the turn, and what "already done" means.
- `docs/decisions/2026-11-02-a-run-that-did-not-finish-leaves-its-work.md` — the branch that carries
  the unfinished work.
- `docs/decisions/2026-10-30-a-failed-runs-branch-is-continued.md` — why the branch's own base can be
  older than the base the claim recorded.
