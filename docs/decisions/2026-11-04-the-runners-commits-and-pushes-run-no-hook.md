---
title: The runner's own commits and pushes run no hook
status: accepted
date: 2026-11-04
authors: Command Code
deciders: Singularity Developer
tags: [runner, git, worktree, recovery]
---

# The runner's own commits and pushes run no hook

## Context

A run on issue 1667 failed at the commit the runner makes on the agent's behalf:
`session — failed — git ... commit ... failed (1)`. The target repository's
`.githooks/pre-commit` hook lints the changed files and compiles the modules the
change touches, and the runner's own `commitAll` ran a plain `git commit`, so the
hook ran inside the run and its exit 1 became the failure. Nothing was pushed
and no pull request was opened.

The work was lost with it. The release path commits what a failed run left in
the worktree (`2026-11-02-a-run-that-did-not-finish-leaves-its-work.md`) through
the same `commitAll`, so that commit was refused by the same hook, its error was
swallowed, and the worktree — the only place the work was — was removed.

The push had the same shape behind a flag. The pre-push hook runs a detekt
verdict over the tree being pushed — about nine minutes on a `shared/` change —
and `--no-verify` skipped it; without the flag the run pushed through it, and a
hook that is red on `main` for an unrelated reason refused the push of a change
that had nothing to do with it.

## Idea

A commit and a push are the runner's bookkeeping, not a gate. Both hooks are a
lint and a compile — a gate, and a build — and the run builds nothing
(`2026-11-05-a-run-gates-nothing-and-builds-nothing.md`): a hook the runner never
asked for must not decide whether the work is kept.

## Decision

**`commitAll` commits with `--no-verify`, and `pushRef` pushes with
`--no-verify`.** Every commit the runner makes — the agent's work, the registry
entry, the gates' and the review's fixes, the verdict, the unfinished work of a
failed run, merge mode's sync — and every push it makes run no hook.

**The `--no-verify` flag goes.** It named a decision about the repository's
state; the runner no longer asks the repository, so there is nothing for the
flag to say. `--no-verify` on the command line is now an unknown option and is
refused like any other unknown one.

**The small-change rule goes with it.** `SMALL_CHANGE_MAX_FILES`,
`SMALL_CHANGE_MAX_LINES`, `ChangeSize`, `changedSize` and `isSmallChange` existed
to decide when the pre-push hook was worth its cost; every push now skips it, so
the rule decides nothing.

## Rationale

**Why skip the hooks and not turn a refusal into a turn.** The gates step
already does that for the gates a run was told to run, and a second copy of it
for a gate nobody enabled would be a build the run does not owe the caller, run
on every commit — the first commit in a cold worktree pays the full compile, and
a run makes several.

**Why the work matters more than the hook.** A refused commit is not a verdict
about the change; it is an exit code the run never asked for. It ended the run
before the push and took the tree with it, which is the one outcome the runner's
own recovery rules exist to prevent.

**Why the flag is removed rather than defaulted.** A flag that is accepted and
changes nothing is a flag that lies to the operator about what the run does.

## Consequences

- The hooks' lint, compile and detekt findings no longer reach the agent, and a
  tree that does not compile can be pushed. The pull request's own CI judges the
  tree, which is already the run's rule.
- Merge mode's commits and pushes skip the hooks too; its full `./check.sh`
  remains its gate, and CI still gates landing.
- A command line that passes `--no-verify` now fails as an unknown option.
- A run no longer spends the pre-push verdict's minutes, so a push is as cheap
  as the network makes it.
- A hook that is neither a commit nor a push hook still runs: `git worktree add`
  runs the target's `post-checkout`, and merge mode's `git merge` runs
  `post-merge`.
- A failed run's unfinished work survives a pre-commit hook that would refuse it.

## Links

- `src/runner.ts` — `commitAll`, and `preserveUnfinishedWork` that calls it.
- `src/git.ts` — `pushRef`, the one place every push goes through.
- `test/commit.test.ts` — a refusing pre-commit hook, and the work that stays.
- `docs/decisions/2026-11-05-a-run-gates-nothing-and-builds-nothing.md` — a run
  gates nothing and builds nothing.
- `docs/decisions/2026-11-02-a-run-that-did-not-finish-leaves-its-work.md` — the
  work a failed run leaves behind.
- `docs/decisions/2026-11-01-the-work-is-a-conditional-graph.md` — the
  small-change rule this record removes.
- `contract/afk-runner.md` — the hooks of the target repository and who runs them.
