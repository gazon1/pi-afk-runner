---
title: The graph runs on the Mastra workflow engine, and it is a set of components
status: accepted
date: 2026-11-06
authors: MiniMax Code
deciders: Singularity Developer
tags: [workflow, engine, mastra, session, review]
---

# The graph runs on the Mastra workflow engine, and it is a set of components

## Context

[2026-11-05-pi-is-gone](2026-11-05-pi-is-gone.md) decided that the graph — the states a
session moves through — is the runner's own TypeScript, in `src/workflow.ts`, and gave the
reason: a workflow engine would have to be told every rule of the run, and the rules would
end up spread across two layers, the runner's and the engine's own statuses.

The graph was one file of four hundred and fifty lines. It held the states, the action
nodes, the branch, the review loop, the cut-off and the failure, and it held the engine
they were written on: `@quintinshaw/pi-dynamic-workflows`, a Pi engine wearing another
name. Writing the graph by hand was what kept Pi out of the tree.

Two things have changed since. The runner already runs on Mastra, and it already depends
on `@mastra/core` for the agent, the session and the guard. And the graph's own shape is
not the runner's rule-making: the states, the branch and the review loop are a control
flow, and a control flow is what a workflow engine is for. The rules the record was
worried about — the deadline, the stop, the cut-off — never were the engine's business,
and they are not the engine's business now.

Mastra's workflow engine (`@mastra/core/workflows` 1.81.0) carries the states, the
branch and the loop. It needs no storage, no `Mastra` instance and no server: a workflow
is built, committed, run.

## Idea

Build the graph on Mastra's workflow engine, and write it as a set of components that
compose — the states, the tokens, the errors, the step, the straight line, the work
session, the review loop — instead of one file that holds all of it.

## Decision

**The graph runs on `@mastra/core/workflows`.** The engine carries the states, the
branch and the review loop. The runner's rules stay the runner's: the deadline, the
stop, the cut-off, the failed turn, the record — they stay in `src/session.ts` and
`src/runner.ts`, and the engine is told none of them.

**The graph is a module of components.** `src/workflow.ts` is gone; `src/workflow/` holds
one idea per file:

| Module | What it is |
|---|---|
| `states.ts` | the states a session is made of |
| `tokens.ts` | the tokens the branch is keyed by |
| `errors.ts` | the graph's own errors and their codes |
| `steps.ts` | the step that runs one state, and the failure it carries |
| `linear.ts` | the states, in order, in one session |
| `work-session.ts` | the work session's script, composed of workflows |
| `review-gate.ts` | the review loop |

`src/workflow/index.ts` is the module's face, and the runner imports that.

**The work session is a composition of sub-workflows.** The two decisions and what each
decision leads to are workflows of their own: `work-session-close-skip`,
`work-session-split`, `work-session-work` and `work-session-scope`. The branch is what
puts them together — the triage's answer picks the closing workflow or the working one,
the scope's answer picks the splitting workflow or the work turns. The intake that used
to be a sub-workflow of its own is gone: the issue's data travels with the turn that
reads it — **replaced** by `2026-11-08-the-issue-travels-with-the-turn.md`.

**The seam does not change.** `WORKFLOW_STATES`, `WORKFLOW_ACTIONS`, `WorkflowState`,
`StateOutcome`, `TurnRunner`, `StatesResult`, `runStates`, `runWorkSession`,
`runReviewGate`, `WorkflowError`, `cutOffError`, `isCutOff`, `stateFailure`,
`FixChangedNothing` and `ReviewStatedNoVerdict` keep their names and their shapes.
`src/runner.ts`, `src/session.ts` and `src/merge.ts` do not learn that the graph is the
engine's.

**The tokens are named once.** `TRIAGE_TOKEN` and `SCOPE_TOKEN` live in
`src/workflow/tokens.ts`, and the session's decision tools import them: the edge the
graph takes and the word the model said are one spelling.

**The engine's ways are the graph's ways.** Five of them shaped the design, and each of
them is a place the graph would be wrong if it were written the way it looks like it
should be:

- **A branch runs every condition that holds**, not the first one. The conditions are
  therefore written in exclusive pairs — `token === "skip"` and `token !== "skip"` —
  and exactly one of them holds, always.
- **A step's failure comes back as a plain object.** The class that tells a cut-off from
  a failure, and the details the runner reports, are gone by the time the run returns.
  The failure therefore travels beside the run, in the run context's holder, and it is
  that copy the caller is told about.
- **The engine logs a step's failure.** A step does not throw: it catches, hands
  the failure to the holder and stops the run itself, so the run's own output
  stays clean.
- **`bail()` inside a nested workflow does not stop the parent.** Stopping the run is
  `abort()`, which stops the whole run — the nested workflows and the loop with it.
- **A nested workflow is committed before it is nested.** A workflow that is not committed
  has no execution graph, and the engine says so when it is run.

**The graph is still built per run.** It depends on the states the session declares, so
it is assembled at run time, exactly as before.

**Mastra's own subagents are not used.** The work session is one session: one system
prompt, one set of tools, one context every turn sees.

## Rationale

**Why the engine now.** The graph was never the place where the runner's rules lived;
the rules were always in the session. What the graph is — a branch on a token, a loop
with an attempt count, a sequence of states — is control flow, and the runner already
depends on the package that carries it. The cost of the hand-written graph was not the
lines: it was that the runner carried its own engine's copy of branching, looping and
failure, and that copy was the one that had to be read, tested and kept in step with
the engine's own semantics.

**Why components.** One file held the states, the tokens, the errors, the step, the
branch, the loop and the outcomes, and every change to one of them touched it. The
decomposition puts each idea where it is read: the states are read where the session
declares them, the tokens where the branch is keyed, the errors where a failure is
caught, the review loop where the review is. The composition is still one graph at run
time.

**Why the engine's ways are recorded rather than worked around.** Each of the five is a
place where the obvious code is quietly wrong: a branch that runs both of its
conditions, a failure that loses its class, a run that logs the failure, a
`bail()` that does not stop anything, a nested workflow that has to be committed. The
graph is written to each of them, and the record is where that is written down.

**Why the seam stays.** The runner's callers — the runner, the merge mode, the tests —
ask the graph what it did, not how. Keeping the names and the shapes means the change
of engine is invisible above the module.

## Consequences

- **Files:** `src/workflow.ts` is deleted and `src/workflow/` is added; `src/session.ts`,
  `src/runner.ts` and the tests import `./workflow/index.js` instead of `./workflow.js`.
  The decision tools a turn ends on move out of `src/session.ts` into `src/decisions/`,
  one decision per file — the triage, the scope, the related issues, the verdict.
- **The graph is the engine's, and the engine's version matters.** `@mastra/core` is
  pinned at 1.81.0, and the five ways above are the engine's ways: an upgrade of the
  package is a change of the graph's behaviour, and the graph's tests are what say
  whether it still behaves.
- **The failures travel beside the run.** A failure that leaves a step is in the run
  context's holder, not in the engine's `error`. Anything that reads a run's failure
  reads the holder.
- **The graph is still assembled per run**, so the engine's cost of building a workflow
  is paid once per run, as the hand-written graph's cost was.
- **The tokens are shared with the session.** A change of a decision token is a change in
  `src/workflow/tokens.ts` and in the tool that returns it, and the two cannot drift.
- **The runner's own rules are unchanged.** The deadline, the stop, the cut-off, the
  broken review being fatal, the small-change skip and the dependency rule are all where
  they were.

## Links

- `src/workflow/index.ts` — the module's face.
- `src/workflow/work-session.ts` — the work session's script, composed of workflows.
- `src/workflow/review-gate.ts` — the review loop.
- `src/workflow/steps.ts` — the step that runs one state, and the failure it carries.
- `src/workflow/tokens.ts` — the tokens the branch is keyed by.
- `src/session.ts` — the runner's rules: the deadline, the stop, the cut-off.
- `docs/decisions/2026-11-05-pi-is-gone.md` — the record whose graph clause this
  replaces: the graph is the runner's own TypeScript.
- `docs/decisions/2026-11-01-the-work-is-a-conditional-graph.md` — the shape the graph
  keeps: triage, scope and split as a branch, and the review loop.
- `contract/afk-runner.md` — the guarantees that do not change.
