---
title: The runner runs the repository's gates before it pushes
status: accepted
date: 2026-11-02
authors: MiniMax Code
deciders: Singularity Developer
supersedes: 2026-11-01-the-self-review-runs-the-gates-again
tags: [gates, session, push, worktree, record]
---

# The runner runs the repository's gates before it pushes

## Context

The work session was told to run the repository's gates itself — `./check.sh`, `just tcheck-evals`,
`just docs-audit` — and the runner believed it: it committed whatever the agent left in the
worktree and pushed it. An agent that skipped the gates, or mis-ran them, put a broken diff on the
remote and into the review, and the review spent a cycle finding out what the gate would have said
in a minute.

The record of 2026-11-01 answered half of it. The agent ends its turn with a tool that says what
each gate said and **which tree** it was said against, and the runner stopped the run when the
report was missing, red, incomplete, or about an older tree. That is the agent's word: the runner
cannot tell that the gates really ran, only that the tree it pushes is the tree the report was made
against. The brief that started this — issue #28 — names the failure exactly: an agent that skips
or mis-runs the gates puts broken code on the remote.

The list of gates was written down twice as well: in the contract copy, which is the target
repository's own document, and in the runner's own code.

## Idea

Run the repository's gates in the worktree, on the tree the agent left, as a step of the run
between the session and the push. A gate that does not pass ends the run there.

## Decision

**The runner runs the gates.** A new `gates` step sits between the `session` step and the `push`
step: it runs `./check.sh`, `just tcheck-evals` and `just docs-audit` — the list the target
repository's contract names, in that order — in the worktree, and the first gate that does not pass
fails the run. The run then releases its claim and pushes nothing.

**The list is the repository's, written down once.** The commands are the ones the target's own
contract names; the runner invents no gate of its own, and it does not run `just gate` — that one
runs the Maestro flows on a device, and it does not run `docs-audit`. The list lives in
`src/gates.ts`, the command that runs each gate is derived from it, and a test holds it against the
contract copy. A list the runner keeps to itself is a list that drifts from the repository it
judges; a list written down twice without a test between them is the same drift with extra steps.

**The agent's report goes.** This supersedes
[2026-11-01-the-self-review-runs-the-gates-again](2026-11-01-the-self-review-runs-the-gates-again.md),
which said that #28 would make the report unnecessary. A report of gates the runner now runs itself
is a second rule about the same thing, and two rules about the same thing can only disagree: the
agent would have to run the gates *and* report them, and the runner would run them a second time.
The report's tree check goes with it — the runner runs the gates on the tree it is about to push,
so there is no earlier tree for a report to be about. The agent still runs the gates: it has to, to
fix what they report. The runner's run is the verdict; the agent's run is the feedback.

**The record says which gate failed.** The step's detail names the gate and the exit code, and the
record carries the tail of what the gate printed — its standard output and its standard error —
indented under the step. A record that says only "a gate failed" is a record a reader cannot act
on. The tail is the tail: a failing `./check.sh` prints megabytes, and neither the runner's memory
nor the record is the place for all of them.

**A gate that could not run says so.** Three stories are three different records: a gate that ran
and refused the change (an exit code), a host that cannot run the gate (`just` is not installed),
and a gate that never got to answer (it was killed, or the run's budget was spent before it could
start). Only the first has an exit code, and the record must not claim one for the other two.

**The registry entry is created before the gates, not in the push step.** A change the work landed
needs its entry in `.specify/issues/`, and the entry belongs to the pull request. It is also what
the repository's own gate checks. Created in the push step it would arrive after the gates had
judged a tree the pull request never carries: the gates would judge a tree that is not the one
that gets pushed.

**The budget is shared, and the gates are inside it.** The run's ceiling is one hour for
everything it does. The session may not spend all of it — the gates run after the session, and a
session that spends everything leaves them nothing to run with — so the session keeps two thirds of
the budget and the gates are given the rest. Each gate is capped at the merge pipeline's own gate
budget, so the two doors do not disagree about how long a build may take. A gate that is killed, or
that never started, has no exit code, and the record does not claim one — "exit 1" would say the
gate refused the change when it never got to answer.

**The worktree goes back to the tree the gates judged.** A gate that builds leaves its build in the
worktree, and the runner's later commits are made with `git add -A`: the artifacts would go to the
remote with the work. The worktree is therefore restored — the files the gates changed and the
files they left behind — before anything else is committed.

**A fix is gated again.** The review's fix changes the tree, so the tree the gates judged is not
the tree that would be pushed. The gates run again on the fixed tree, and a fix that does not pass
them is not pushed. The tree on the remote is the tree the gates judged.

## Rationale

The agent is not a gate. A prompt that says "run the gates" is an instruction, and an instruction
is followed as often as not; the runner is the one place that cannot forget.

The gates run in the worktree because that is where the repository runs them: the worktree has the
private Gradle home, the `.env` copy and the hooks the setup script installs. Run anywhere else,
they would judge a tree the repository does not build.

The registry entry moved because a gate has to judge the tree that is pushed, and the entry is
part of that tree. In the other order the gates judged a tree that was missing a file the
repository's own gate requires — a false failure, on the change that needs the entry most.

The budget is shared because the run's ceiling is the run's. A gate that may take an hour, three
times over, is a run that outlives its ceiling by three hours — and the hourly sweep overlaps it.

## Consequences

- A run that ends at the `gates` step leaves no branch on the remote and no pull request: the
  claim is released, the work stays in the local branch, and the next run takes the issue again.
  Its exit code is `45`, so a scheduler can tell a red gate from an issue that could not be
  worked.
- The gates cost what they cost. The long evals run on every worked issue, not only on the large
  ones; the small-change skip still applies to the repository's pre-push hook, which is the rule
  the repository states for itself.
- The runner is now bound to the target repository's gate commands, and to the host having them:
  `just` and whatever the gates call have to be on the machine the run works on.
- The runner's pipeline has a step the target's contract does not name. The contract copy is the
  target's document and is not edited to match; the deviation is recorded in `contract/README.md`
  and here. When the target's contract names the gates step, the copy is copied again and the note
  goes.
- The work session no longer ends its last turn with a tool. The prompt's last action is a report
  again, and the runner reads no report.

## Links

- `src/gates.ts` — the list, the command each gate is run with, and the runner's run of them.
- `src/runner.ts` — the `gates` step, the budget it shares, and the worktree it restores.
- `src/prompts/02-implement.md` — the agent is told that the runner runs the gates too.
- `contract/afk-runner.md` — the target repository's own list of gates.
- `docs/decisions/2026-11-01-the-self-review-runs-the-gates-again.md` — the record this one
  supersedes.
