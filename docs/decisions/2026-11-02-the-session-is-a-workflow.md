---
title: The session's states are a workflow, and the workflow drives the runner's session
status: accepted
date: 2026-11-02
authors: MiniMax Code
deciders: Singularity Developer
tags: [session, workflow, prompt, engine, dependencies]
---

# The session's states are a workflow, and the workflow drives the runner's session

## Context

The work session was a **prompt array**: four files read from disk, four turns
sent into one session, and a loop that sent them one after another. The loop
carried three rules that were not obvious and were not the loop's to invent:
the deadline that bounds the whole array, the stop that a human can give, and
the turn whose model call failed and settles as a normal turn.

The array grew a fifth thing later — the issue's body and its comments, in
turns of their own, before the prompts — and the loop grew a branch for it.
The work was still one session, one system prompt and one context, and every
turn saw the turns before it.

Meanwhile the README has listed `@quintinshaw/pi-dynamic-workflows` as one of
the packages the install brings — "the multi-step workflow" — and the package
was not a dependency. A dependency the project names and does not use is a
promise nobody keeps.

## Idea

Describe the session's turns as a **graph of states** — Brief, Implement,
Verify, Next — and let a workflow engine run the graph, instead of a loop
that walks an array.

## Decision

**The session's states are a workflow, and `@quintinshaw/pi-dynamic-workflows`
runs them.** The states are named in `src/workflow.ts`, each with the prompt
file it runs, and the file list is read from them: the state and the file
cannot drift apart.

**The engine runs the graph; the runner runs the turns.** The engine is given
a *turn runner* instead of its own subagents. Its agents are separate
sessions in separate worktrees, each with a model of its own — a fleet. This
is one session: one system prompt, one set of tools, one context that every
turn sees. The rule that the issue body is data lives in the **system
prompt**, and a fleet of subagents would each need it in theirs.

**The runner's rules stay the runner's.** The deadline, the stop and the
failed turn are the runner's, and they stay in `src/session.ts`: the engine
gets no timeout of its own and no retry, because a timeout there would cut a
turn the runner still wants and a retry there would send a turn twice.

**A state says what it did.** Every state returns success or failure, and a
failure stops the run: the engine carries the failure, and the runner reports
the failure underneath it — the same message the old loop threw.

**A run that is cut off is not a failure.** The deadline and the stop end the
run as an aborted run, with the states that finished, exactly as the old loop
reported them.

## Rationale

The graph is the thing the session actually is, and saying it in one place —
four states, four files, one order — is worth more than the loop it replaces.
The engine earns its place by being the thing that decides what runs next:
its phases, its states, its failure handling and its cut-off are one
mechanism, not four rules spread over a loop and a timer.

The engine's subagents are the part that is **not** used, and deliberately:
they are separate sessions, in separate worktrees, with their own models and
their own tools. The work session is none of those things. The contract says
the issue body is data and the rule that says so is in the system prompt; a
subagent session would have to be told that in its own prompt, which is
exactly the place a rule does not belong.

Keeping the runner's rules out of the engine is what keeps the engine's
behaviour from becoming the runner's behaviour by accident. The engine's
default for a failed agent is a *recoverable* failure: it logs it, returns
nothing, and carries on to the next state. A run that carried on past a
failed turn would look like a run that worked, and the work would be judged
on what it left behind.

The alternative — the engine's own subagents, one per state — was rejected for
the same reason the fleet is not used: four states are four turns of **one**
conversation, and a fleet of four sessions is four conversations that have to
be told what the previous one learned.

## Consequences

- The runner depends on `@quintinshaw/pi-dynamic-workflows` (3.15.0), and
  loads it: it is a package of the project, and the README has said so.
- `@earendil-works/pi-tui` is a peer dependency now: the engine's entry
  point pulls it in, and the host provides it.
- The engine's own logs are **not** written: the record of a run belongs to
  the runner, under `build/diagnostics/`.
- The work session's states are named — the graph stays readable, and the
  review and merge sessions declare one state each — but a run's record says
  how far it got as a count, not a state name: see
  `2026-11-02-the-record-names-the-build-and-the-progress.md`.
- A state that fails ends the run where it stands. A state that is cut off
  ends it as an aborted run.
- The engine is a new thing to keep up with: its version is pinned, and its
  behaviour — a recoverable failure, an empty answer, a retry — is the
  engine's, not the runner's.

## Links

- `src/workflow.ts` — the states, the script, and the turn runner.
- `src/session.ts` — the deadline, the stop, the failed turn, and the
  session's rules.
- `src/prompts/01-brief.md` … `04-next.md` — the four turns the states run.
- `README.md` — the install's packages, and the workflow among them.
- `contract/afk-runner.md` — the guarantees that did not change: the body is
  untrusted data, the rule is in the system prompt, the record stays on the
  machine.
