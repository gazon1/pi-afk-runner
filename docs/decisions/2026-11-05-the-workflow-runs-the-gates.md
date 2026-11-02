---
title: The workflow runs the gates — the agent does not
status: accepted
date: 2026-11-05
authors: MiniMax Code
deciders: Singularity Developer
supersedes: 2026-11-01-the-self-review-runs-the-gates-again
tags: [gates, workflow, agent, configuration]
---

# The workflow runs the gates — the agent does not

## Context

The runner runs the target repository's gates in its own `gates` step, between the session and
the push ([2026-11-02-the-runner-runs-the-repositorys-gates](2026-11-02-the-runner-runs-the-repositorys-gates.md)).
The **agent** was told to run them too: the implement turn, the verify turn and the review's fix
turn each carried the list and the command to run it. The reasoning was that the agent has to
see what the gate reports in order to fix it.

That reasoning was sound, and the arrangement was not:

- The agent ran the gates **twice** — once itself, once in the workflow's step — and paid for
  both out of the session's share of the budget. A build that takes fifteen minutes was
  charged twice, and the session's two hours were spent partly on a gate the runner was going
  to run anyway.
- The agent's run was **not** the run that counted. A tree the agent left green could still be
  refused by the runner's step, and a tree the agent left red was refused twice. The word that
  decided the push was the runner's, so the agent's run bought nothing but cost.
- The list was written down in three places that could drift: the runner's `src/gates.ts`, the
  target repository's contract, and the prompts.

Two more things came up while this was being decided:

- A live run failed at the gates with `sgate MISSING the gate CLI`. The tools of a checkout
  live in **that checkout's own** venv (`~/.venvs/<worktree>/bin`), the repository's own
  `scripts/setup-worktree.sh` says so — it prints `ready: export PATH="…:$PATH"` — and the
  runner ran the gates with the runner's own PATH. A gate that cannot find its tools never got
  to answer, and the record called it a gate that refused the change.
- The **list** of gates was fixed in the runner's source. The target repository's contract
  names three gates, and a repository that wanted a different list had no way to say so short
  of a change in the runner.

## Idea

The workflow's `gates` step runs the gates and nobody else does. The agent is told not to run
them, and a gate that refuses the change comes back to the agent as a **turn**, with the gate's
own output, so the agent still fixes what the gate reported — the runner just runs the gate.

Which gates run becomes the repository's own business, in three layers: the command line, the
repository's own file in the root of the checkout, and the contract's list.

And the gates run with the PATH the repository's own setup script printed.

## Decision

**The agent does not run the gates.** The prompts of the implement turn, the verify turn and
the review's fix turn say so, and the runner's `gates` step is the only thing that runs them.

**A refusal goes back to the agent.** The `gates` step catches the gate's failure and gives
the agent a turn with the gate's output — the tail of it, bounded — and the fix is committed
before the gates run again. Two turns are the limit (`GATE_FIX_ATTEMPTS`); a gate that refuses
a third time ends the run, and the failure is the record's.

**Which gates run is decided in three layers, and the command line wins.** `--gate` names the
gates a run runs, in one flag, separated by commas: `--gate "./check.sh --fast,just docs-audit"`.
Then the repository's own `.afk-runner.json` in the root of the checkout:

```json
{ "gates": ["./check.sh --fast", "just docs-audit"], "gateTimeoutMs": 900000 }
```

And the contract's list when neither of them says anything. A file that cannot be read ends
the run where it stands — a runner that quietly fell back to the contract's gates would judge a
tree by a list the repository did not ask for. An empty list runs no gates at all.

**The gates run with the repository's own PATH.** The setup script's `export PATH="…:$PATH"`
line is parsed, and the gates run with that PATH, so the gate CLI of that worktree is found
rather than somebody else's. The script prints that line only when it makes the venv; a venv
that is already there is named and nothing more, so the name it prints is read as well.

**The run's ceiling follows the gates it runs.** `defaultDeadlineMs(gateCount)` and
`budgetShares(deadlineMs, gateCount)` take the number of gates into account: a run with one
gate does not carry the budget of a run with three.

## Rationale

**Why the agent does not run them.** An instruction to run a gate is not a gate. The runner is
the one place that cannot forget, and its word is the one the push rests on. Running the same
gate twice bought a second opinion nobody used and cost the session's budget twice.

**Why the refusal goes back to the agent rather than ending the run.** Banning the agent from
running the gates without giving it the result would make every gate failure fatal to a whole
session — a typo in a test name would cost a full run. The refusal comes back as a turn
instead: the agent still fixes what the gate reported, and the runner still judges the tree.
The turn is bounded (two), and the second refusal ends the run.

**Why the command line wins over the repository's file.** A run started by hand says what it
wants to run; a repository says what a run on it runs. The order is the same as everywhere
else in the runner: the more specific instruction wins.

**Why the file is in the checkout's root, and why a broken file is fatal.** The file is the
repository's own — it travels with the repository, it is versioned with it, and a person
reading the repository finds it where they expect to find it. A file that cannot be read is the
repository's own mistake: falling back to the contract's list would judge a tree by a list
the repository did not ask for, and the run would say nothing about it.

**Why the PATH is parsed out of the setup script's output.** The repository's own script
already says where its tools are; the runner does not re-derive it, it reads it. A gate CLI is
an editable install of that checkout's own venv, so a shared venv makes every worktree judge
somebody else's checkout. The script says that venv in two ways — the PATH it asks for, and
the path of a venv it found already there — and both are read: a gate that ran with the
host's PATH reported a missing tool, not a verdict.

**Why the ceiling follows the gate count.** The gates' share is an hour per gate. A run with
one gate that reserves three gate-hours has three hours less for the session and the review
than the gates will ever use.

## Consequences

- The prompts no longer carry the gate list; they carry the rule that the runner runs the
  gates. The list lives in `src/gates.ts` and in the target repository's contract, and the
  test that holds the two together still does.
- A run that fails at the gates may have had two extra agent turns in it. The record says
  what the gate refused; the fix commits carry `fix: the gates' findings`.
- `RunOptions` grows `gates` and `gateTimeoutMs`; `runGates` takes the list, the timeout and
  the environment.
- A repository that wants a different list writes `.afk-runner.json`; a person running the
  runner by hand writes `--gate`.
- The merge door keeps the **full** `./check.sh`: that is the contract of the merge mode, and
  it is a separate mode with its own gate.

## Links

- `src/gates.ts` — the list, the repository's own file, and the run of the gates.
- `src/runner.ts` — the `gates` step, the refusal that goes back to the agent, and the PATH.
- `src/budget.ts` — the ceiling that follows the gate count.
- `src/prompts/02-implement.md`, `src/prompts/03-verify.md` — the turns that do not run the
  gates.
- `contract/afk-runner.md` — the target repository's own gates.
- `2026-11-02-the-runner-runs-the-repositorys-gates.md` — the record this one continues: the
  runner runs the gates.
- `2026-11-01-the-self-review-runs-the-gates-again.md` — the record this one supersedes: the
  self-review does not run the gates.
