---
title: A run gates nothing and builds nothing
status: accepted
date: 2026-11-05
authors: MiniMax Code
deciders: Singularity Developer
supersedes: 2026-11-05-the-workflow-runs-the-gates
tags: [gates, build, workflow, speed]
---

# A run gates nothing and builds nothing

## Context

The runner ran the target repository's gates in its own `gates` step, between the session and the
push ([2026-11-05-the-workflow-runs-the-gates](2026-11-05-the-workflow-runs-the-gates.md)), and
the agent was told not to run them: an instruction to run a gate is not a gate.

The step was still the slowest thing in a run. On the target, `./check.sh --fast` compiles the
Android app, runs the affected tests and lints the changed files — minutes of Gradle daemon
before the first word of the review. The gates' share of the budget was three hours, and the
run's own ceiling carried them whether they were needed or not.

The **agent** was the other half of the cost. Nothing stopped it from compiling on its own: it
ran `./gw :shared:compileDebugKotlinAndroid` in the middle of a turn, unasked, and paid the
minutes out of the session's share.

A live run made the cost concrete: the work was finished in six turns, and the run then spent
longer in the gates than the agent had spent writing the code.

The target repository's own CI judges the pull request anyway. The gates in the work pipeline
were a second judge of the same tree, and the second judge was the slow one.

## Idea

**A run gates nothing, and nothing in it builds.** The tree the agent leaves is the tree that is
pushed, and the repository's own CI is what judges it.

The machinery is not gone: a run that is _told_ to run gates still runs them, in the worktree,
with the repository's own PATH — and the merge door keeps the full `./check.sh`, which is the
contract of the merge mode.

## Decision

**A run runs no gate unless it is told to.** The list of gates is empty by default
(`NO_GATES`). It comes from the command line (`--gate "./check.sh --fast,just docs-audit"`) or
from the repository's own `.afk-runner.json`, in that order. The contract's list is not a
fallback any more: a run that nobody told to gate runs no gate.

**The agent does not build.** The guard's bash policy refuses the commands that build or gate —
`./gw`, `./gradlew`, `./check.sh`, `just gate`, `just tcheck-evals`, `just docs-audit` — and the
implement, verify and next turns say the same thing in words: do not build, do not compile, do
not run the checks; judge the change by reading it.

**A test suite is a check, and it is refused by the program it starts.** `pytest` and
`python -m unittest` are refused however the command spells them — behind a `cd`, behind a
`timeout`, behind a shell's own `-c`. The refusal is by the **program** and not by the word the
command carries: a `grep -rn unittest` reads how the target gates itself, and that is the work.

**A command does not get to ask for an hour.** There are two ways to ask for time — the tool's own
`timeout` and the shell's `timeout` — and both are bounded: the guard refuses a call that asks for
more than ten minutes. A run that waits is a run that does nothing else, and the session's minutes
are the run's whole budget.

**The gates' share of the budget follows the gates a run actually runs.** A run with no gate
reserves no gate budget, and its ceiling is the session's share and the review's share added
up. A run told to run three gates reserves an hour each, as before.

**The merge door is unchanged.** The merge mode is opt-in and separate, and its gate is still the
full `./check.sh` — that is the contract of the merge mode.

## Rationale

**Why the gates went off by default.** A gate is a second judge of the tree, and the pull
request already has one: the repository's own CI. The work pipeline's gate bought a second
opinion of the same diff at the price of minutes per run, and it bought it on the tree _before_
the review — so the review, which is the thing that reads the diff, started later.

**Why the machinery stayed.** A run that is told to run gates still runs them, in the worktree,
with the repository's own PATH, and a refusal still comes back to the agent as a turn. Turning
the gates off is a decision about the **default**, not about the mechanism: the merge door needs
a gate, and a repository that wants its own gates says so in one file.

**Why the agent is forbidden rather than asked.** "Do not build" in a prompt is a request; a deny
rule in the guard is a refusal. The agent compiled on its own because nothing stopped it, and a
rule that can be ignored is not a rule — it is a suggestion that costs minutes when it is
ignored.

**Why the tree is pushed as it is.** The user's own words: the speed is worth more than the
errors, and the errors are not hidden — the verify turn reports what it did not check, and CI
judges the tree. A run that says what it did not check is honest; a run that spends a quarter of
an hour proving that it did not need to is slow.

## Consequences

- A work run pushes a tree that was never compiled. The pull request's CI is what says whether it
  holds.
- The record of a run says nothing about gates, and the `gates` step runs no gate.
- `src/gates.ts` keeps the list, the repository's own file, the PATH and the three failure
  reasons; `NO_GATES` is what a run falls back to.
- The target repository's contract still describes the gates it names. This runner's default
  runs none of them, and the merge door runs the full one.
- The gate's own budget share follows the gates a run runs: zero for a run with no gate, an hour
  each for a run with three.
- A command that asks to run for longer than ten minutes is refused, whichever way it asks for the
  time.

## Links

- `src/gates.ts` — `NO_GATES`, the repository's own file, and the run of the gates.
- `src/guard.ts` — the bash policy that refuses a build, the programs that are a test suite, and the
  ceiling on how long a command may run.
- `src/budget.ts` — the ceiling that follows the gate count.
- `src/prompts/02-implement.md`, `src/prompts/03-verify.md`, `src/prompts/04-next.md` — the
  turns that do not build.
- `src/merge.ts` — the merge door, whose gate is still the full `./check.sh`.
- `2026-11-05-the-workflow-runs-the-gates.md` — the record this one supersedes: the workflow
  runs the gates.
