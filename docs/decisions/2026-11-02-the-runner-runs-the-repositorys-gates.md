---
title: The runner runs the repository's gates before it pushes
status: accepted
date: 2026-11-02
authors: MiniMax Code
deciders: Singularity Developer
tags: [gates, session, push, worktree, record]
---

# The runner runs the repository's gates before it pushes

## Context

The work session was told to run the repository's gates itself — `./check.sh`, `just tcheck-evals`,
`just docs-audit` — and the runner believed it: it committed whatever the agent left in the
worktree and pushed it. An agent that skipped the gates, or mis-ran them, put a broken diff on the
remote and into the review, and the review spent a cycle finding out what the gate would have said
in a minute.

The gates are the repository's own, and the repository's contract already names them
(`contract/afk-runner.md`, "The gates the agent runs"). The runner did not run them.

## Idea

Run the repository's gates in the worktree, on the tree the agent left, as a step of the run
between the session and the push. A gate that exits non-zero ends the run there.

## Decision

**The runner runs the gates.** A new `gates` step sits between the `session` step and the `push`
step: it runs `./check.sh`, `just tcheck-evals` and `just docs-audit` — the list the target
repository's contract names, in that order — in the worktree, and the first gate that exits
non-zero fails the run. The run then releases its claim and pushes nothing.

**The list is the repository's, written down here.** The commands are the ones the target's own
contract names; the runner invents no gate of its own, and it does not run `just gate` — that one
runs the Maestro flows on a device, and it does not run `docs-audit`. A list the runner keeps to
itself is a list that drifts from the repository it judges.

**The record says which gate failed.** The step's detail names the gate and the exit code, and
the record carries what the gate printed — its standard output and its standard error — indented
under the step. A record that says only "a gate failed" is a record a reader cannot act on.

**The registry entry is created before the gates, not in the push step.** A change the work landed
needs its entry in `.specify/issues/`, and the entry belongs to the pull request. It is also what
the repository's own gate checks. Created in the push step it would arrive after the gates had
judged a tree the pull request never carries: the gates would judge a tree that is not the one
that gets pushed.

**The gate budget is the merge pipeline's budget, in one place.** The command runner's default is
fifteen minutes — shorter than a build with its tests — and the merge pipeline already gives the
same repository gate an hour. The gates step takes that budget, and both doors read it from one
constant: the pipeline that runs the gate first must not kill a build the other one would have let
finish. A gate that is killed, or that never started, has no exit code, and the record does not
claim one — "exit 1" would say the gate refused the change when it never got to answer.

## Rationale

The agent is not a gate. A prompt that says "run the gates" is an instruction, and an instruction
is followed as often as not; the runner is the one place that cannot forget.

The gates run in the worktree because that is where the repository runs them: the worktree has the
private Gradle home, the `.env` copy and the hooks the setup script installs. Run anywhere else,
they would judge a tree the repository does not build.

The registry entry moved because a gate has to judge the tree that is pushed, and the entry is
part of that tree. In the other order the gates judged a tree that was missing a file the
repository's own gate requires — a false failure, on the change that needs the entry most.

## Consequences

- A run that ends at the `gates` step leaves no branch on the remote and no pull request: the
  claim is released, the work stays in the local branch, and the next run takes the issue again.
- The gates cost what they cost. The long evals run on every worked issue, not only on the large
  ones; the small-change skip still applies to the repository's pre-push hook, which is the rule
  the repository states for itself.
- The runner is now bound to the target repository's gate commands. A change to them in the target
  has to change `GATE_COMMANDS` here, and the target's contract is where that change is written
  down first.
- A gate that runs longer than an hour ends the run with a message that says so.
- The fix turn of the review loop still pushes on the agent's word alone: the gates run on the
  work session, not on a fix.

## Links

- `src/runner.ts` — `GATE_COMMANDS`, `runGates`, the `gates` step, and the record's output.
- `src/prompts/02-implement.md` — the agent is told that the runner runs the gates too.
- `contract/afk-runner.md` — the target repository's own list of gates.
