---
title: The run runs on Mastra — the agent, the graph and the memory are Mastra's
status: superseded
superseded-by: 2026-11-05-pi-is-gone
date: 2026-11-05
authors: MiniMax Code
deciders: Singularity Developer
supersedes: 2026-11-02-the-session-is-a-workflow, 2026-10-30-the-work-session-is-the-runners-minus-the-runner, 2026-11-02-a-prompt-may-only-name-a-skill-the-runner-carries
tags: [session, workflow, engine, memory, dependencies, mastra]
---

# The run runs on Mastra — the agent, the graph and the memory are Mastra's

## Context

The runner drives three sessions — the work session, the review session, the merge
resolution — and each of them is a **Pi session**: `createAgentSession` with a resource
loader (`src/cli.ts:482`), the SDK's model runtime, the SDK's tools, the SDK's skills
discovery. The graph that moves a session through its states is a separate engine:
`@quintinshaw/pi-dynamic-workflows` 3.15.0, driven by three scripts written as strings
(`src/workflow.ts:120`, `:141`, `:190`).

Around that, the runner has things that are its own and stay: git, GitHub, the claim,
the lock, the budget, the gates, the record, the deadline, the contract. Inside the
session it has the SDK's, and three of those are work the runner does around the SDK
rather than in it:

- **The decision is a tool call.** The triage says `work` or `skip` by calling
  `agent_issue_decision` (`src/session.ts:844`), the scope says `fits` or `split`
  (`src/session.ts:923`), the review ends on `agent_review_verdict`
  (`src/session.ts:1317`). The runner reads the decision out of a holder the tool
  fills in, and the branch is the workflow's decision afterwards.
- **The rules live in the session.** The issue body is untrusted data and the rule that
  says so is in the **system prompt** (`src/session.ts:73`); the guard's deny list
  (`*.env`, `*.pem`) is a policy file the Pi guard reads from the worktree
  (`src/guard.ts:54`); the skills a prompt names are found by the SDK's discovery
  (`additionalSkillPaths`, `src/cli.ts:391`).
- **The turn's failure is a message.** A model call that failed settles as an assistant
  message with `stopReason: "error"` (`src/session.ts:400`), and the runner reads the
  failure out of the session's messages.

None of this is wrong. It is a lot of machinery that is not the runner's, and the parts
that _are_ the runner's — the deadline, the stop, the failed turn, the record — sit next
to it and have to be re-implemented in whatever the session is.

Mastra has what the runner was reaching for: an **agent** with tools and a model, a
**workflow** engine with typed steps and a branch, and **memory** with threads and
resources.

## Idea

Run the run on Mastra: the work session, the review session and the merge resolution
become **Mastra agents** on **Mastra memory**, and the graph becomes a **Mastra
workflow** — while the runner's own rules, its seams and the contract stay where they
are.

## Decision

**The runner's sessions are Mastra agents.** The work session, the review session and
the merge resolution run on a Mastra `Agent` with a Mastra `Memory`: the run's context
is a thread, the run's issue is the resource, and a turn is `agent.generate` with the
run's `AbortSignal`. The Pi session factory (`src/cli.ts:482`) leaves the run: the Pi
SDK creates no session that a run drives. Until the switch it stays behind
`--engine pi`, and the flag is what the two engines share.

**The runner's graph is a Mastra workflow.** The three scripts become one typed
workflow whose steps are the session's states, whose branch is the issue's branch, and
whose review loop is a `dountil`. `@quintinshaw/pi-dynamic-workflows` is removed.

**The seams stay.** `AgentSession` and `SessionFactory` (`src/session.ts:429`, `:441`)
stay the face of a session; `TurnRunner`, `StatesResult` and `ReviewGateResult`
(`src/workflow.ts:104`, `:107`, `:425`) stay the face of the graph. The Mastra
implementations live behind them, and `src/runner.ts` does not learn that the session is
Mastra's.

**The runner's rules stay the runner's.** The deadline, the stop, the failed turn and
the record stay in `src/session.ts` and `src/runner.ts`. The workflow gets no timeout
and no retry of its own: a timeout there would cut a turn the runner still wants, and a
retry there would send a turn twice.

**The decisions stay decisions.** The five decision tools keep their names, their
schemas and their holder. They are **described once**, in the runner's own terms
(`src/tools.ts`), and each engine builds its own object from that description: Pi's
`defineTool` and Mastra's `createTool`, with the typebox schemas converted through
`toStandardSchema`. A tool written twice is a tool whose two copies drift, and the
drift would be a decision the runner reads differently depending on which engine ran
it. The branch is still read out of a holder the tool filled in.

**The skills rule stands, the carrier changes.** A prompt names a skill as `$<name>`,
and every `$name` in a prompt is a skill the runner carries — that rule and the suite
that checks it stay. What changes is the carrier: the runner's `skills/` directory and
the target repository's `.agents/skills` are read by the runner (`src/mastra/skills.ts`)
and handed to the agent as Mastra skills, instead of being found by the SDK's discovery.

**The guard's rules stand, the carrier changes.** The deny list the runner holds — `*.env`
and `*.env.*` denied, `*.pem` denied, `*.env.example` allowed again — is the runner's
own, and it is applied by the runner, over the agent's tools. On Mastra the carrier is
the workspace's own `beforeToolCall` hook (`src/mastra/guard.ts`); on Pi it is the
permission extension. The **rules** are one list (`GUARD_POLICY`, `src/guard.ts:54`)
read by both, so the two engines cannot refuse different things. The Pi permission
system is not loaded into a Mastra run, and the policy file it read is neither written
nor read any more.

**The model is a Mastra model.** A run goes through a Mastra gateway. The MiniMax
gateway written for `mastra-app` is carried over, and `--model` names a Mastra model
reference. Pi's provider discovery, and the OAuth that comes with it, are not used by a
run.

**The Mastra engine arrives beside Pi, behind a flag.** The first phase does not
replace the Pi engine: `--engine pi|mastra` chooses, and Pi is the default until the
switch. The Mastra module is loaded by a **dynamic import**, so a Pi run does not pay
for Mastra being installed. The flag is the seam's way of saying the two engines are
the same session with two implementations, not two runners.

**Mastra's version is pinned.** `@mastra/core` is pinned exactly, at 1.81.0, because the
API is moving: `.branch()` runs **every** true condition rather than the first one, and
there is no `.doWhile` — only `.dountil`.

## Rationale

**Why Mastra and not the self-written layer.** The self-written layer is three scripts
written as strings, plus a graph assembled from data at run time, plus a session the
SDK owns. Mastra gives typed steps, a branch, a loop, memory and a model gateway — the
parts the runner spends its own code on, and it gives them as one thing with one
version to pin.

**Why the seams stay.** The rewrite is the risky half of this change, and the seams are
what make it a sequence of green PRs instead of one big one: the graph can be swapped
under a `TurnRunner` that did not change, and the agent can be swapped under a
`SessionFactory` that did not change. They also keep `src/runner.ts`, the record, the
gates and the merge mode out of the diff — those are the runner's, and the rewrite is
not about them.

**Why the skills and the guard rules survive while their carriers do not.** Both are
guarantees about the agent's **environment** — what it may read, what checklists it has
— and neither is about the SDK. The SDK was the carrier; Mastra becomes the carrier;
the guarantees are the runner's and are re-implemented in the runner's own terms. A
guarantee that changes carrier is not a guarantee that changed.

**Why this supersedes three records and not more.** The engine changes, so
[2026-11-02-the-session-is-a-workflow](2026-11-02-the-session-is-a-workflow.md) goes:
its shape survives — the session is still a workflow, the engine still runs the graph,
the runner still runs the turns — but its engine does not. The session is no longer a Pi
session, so
[2026-10-30-the-work-session-is-the-runners-minus-the-runner](2026-10-30-the-work-session-is-the-runners-minus-the-runner.md)
goes: what it decided was how a **Pi** session is built, and there is no Pi session in
a run. The skills' carrier changes, so
[2026-11-02-a-prompt-may-only-name-a-skill-the-runner-carries](2026-11-02-a-prompt-may-only-name-a-skill-the-runner-carries.md)
goes — and its **rule** is restated above, because the rule is the runner's and the
rule stands.

## Consequences

- Dependencies: `@quintinshaw/pi-dynamic-workflows` and `@gotgenes/pi-permission-system`
  go; `@mastra/core` (1.81.0, pinned), `@mastra/memory` and `@mastra/schema-compat`
  come, with `@ai-sdk/anthropic` for the gateway. `@earendil-works/pi-coding-agent`
  stays a peer dependency **until the last Pi session is gone**; `typebox` stays,
  because the tool schemas stay typebox.
- New modules under `src/mastra/`: the agent, the session, the tools, the skills, the
  guard, the log, the model and the gateway — and, beside them, the runner's own
  description of a tool (`src/tools.ts`), the journal both engines write
  (`src/journal.ts`), and the Pi adapter over it (`src/pi-tools.ts`).
- The runner (`src/runner.ts`), the record, the gates, the budget, the merge mode and
  the contract do not change. `contract/afk-runner.md` names no session, no tool and
  no engine, so it does not move.
- The prompts do not change: `$name` stays, and the suite's check that a prompt names
  only a carried skill stays.
- Lost: Pi's provider discovery and its OAuth (a run uses a Mastra gateway); the Pi
  guard's policy file — a repository's committed Pi policy no longer governs a run,
  and the runner's own deny list does.
- A worktree no longer carries a `.pi/` policy directory: nothing writes it and nothing
  reads it.
- The Mastra engine's memory is in the process (`InMemoryStore`) until phase 3: a run
  that restarts loses its context. The README does not promise memory before then.
- The phases, the acceptance of each phase, and the API questions that have to be
  answered before the second phase are in
  [docs/plans/2026-11-02-the-run-runs-on-mastra.md](../../plans/2026-11-02-the-run-runs-on-mastra.md).

## Links

- `docs/plans/2026-11-02-the-run-runs-on-mastra.md` — the phases and the open API
  questions.
- `src/session.ts` — the seams (`AgentSession`, `SessionFactory`), the deadline, the
  failed turn, the decision tools.
- `src/tools.ts` — the runner's own description of a tool, and the two engines'
  adapters over it.
- `src/workflow.ts` — the states, the turn runner, the review loop.
- `src/cli.ts` — `piSessionFactory` (what leaves the run), `pickModel` (what the
  gateway replaces), and the `--engine` flag that chooses between them.
- `src/guard.ts` — the deny rules both engines apply.
- `contract/afk-runner.md` — the guarantees that do not change.
- `docs/decisions/2026-11-05-the-runner-is-a-command-and-not-a-pi-extension.md` — the
  door that is already gone.
