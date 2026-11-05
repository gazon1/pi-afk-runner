# The run runs on Mastra — the plan

The decision this plan implements:
[2026-11-05-the-run-runs-on-mastra.md](../decisions/2026-11-05-the-run-runs-on-mastra.md),
and, since it superseded it, [2026-11-05-pi-is-gone.md](../decisions/2026-11-05-pi-is-gone.md).
The boundary they settle: **Mastra is the runner's only engine, and the graph is the
runner's own TypeScript.** The seams (`AgentSession`, `SessionFactory`, `TurnRunner`) and
the contract stay where they are.

Verified against `@mastra/core` 1.81.0 (the types in
`node_modules/@mastra/core/dist`), a local run of `createWorkflow` + `createStep` +
`.branch()` with no server, the typebox → `toStandardSchema` conversion from
`@mastra/schema-compat`, `@mastra/core/storage` (`InMemoryStore`, `InMemoryMemory`,
`MastraCompositeStore`), and `@mastra/core/test-utils` (`createMockModel`,
`MockProvider`).

---

## 1. The boundary

|                                                        | Before                                         | Now                                                                       |
| ------------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------- |
| The runner's sessions (work, review, merge resolution) | a Pi session (`src/cli.ts` `piSessionFactory`) | **Mastra `Agent` + `Memory`** (`src/mastra/session.ts`)                   |
| The graph engine                                       | `@quintinshaw/pi-dynamic-workflows`            | **the runner's own TypeScript** (`src/workflow.ts`)                       |
| The decision tools                                     | Pi `defineTool` + typebox                      | **one description (`src/tools.ts`), one adapter** (`src/mastra/tools.ts`) |
| Skills                                                 | Pi `additionalSkillPaths`, `$name` in prompts  | **Mastra skills by directory**; the `$name` rule stands                   |
| The guard                                              | `@gotgenes/pi-permission-system`               | **the same rules, over Mastra's own hook** (`src/mastra/guard.ts`)        |
| The model                                              | Pi `modelRuntime` (`pickModel`)                | **a Mastra gateway** (the MiniMax one)                                    |
| The live door (`src/extension.ts`)                     | a Pi extension                                 | **gone** — the runner is a command                                        |

## 2. What was replaced, and by what

| Before                                                                            | File                                 | Now                                                                                                                      |
| --------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Three script strings (`LINEAR_SCRIPT`, `WORK_SCRIPT`, `REVIEW_SCRIPT`)            | `src/workflow.ts`                    | the runner's own graph: the states, the action nodes, the branch, the review loop                                        |
| `runEngine` / `turnAgent`                                                         | `src/workflow.ts`                    | the same; the `TurnRunner` seam stays as it is                                                                           |
| the review's `gate` (review → fix → review)                                       | `src/workflow.ts` `runReviewGate`    | the runner's own loop: the attempt, the retry, the cut-off                                                               |
| the Pi session (`createAgentSession`, `DefaultResourceLoader`)                    | `src/cli.ts`                         | `new Agent(...)` + `agent.generate(prompt, {abortSignal, memory})`                                                       |
| `AgentSession` (`prompt`/`abort`/`dispose`/`messages`)                            | `src/session.ts`                     | stays the **interface**; the implementation is `src/mastra/session.ts`                                                   |
| `SessionFactory`                                                                  | `src/session.ts`                     | stays the **seam**: `mastraSessionFactory`                                                                               |
| the five decision tools                                                           | `src/session.ts`, `src/leftovers.ts` | **described once** in `src/tools.ts`; `src/mastra/tools.ts` builds Mastra's object from it; the **holder pattern stays** |
| skills discovery                                                                  | `src/cli.ts`                         | the directories themselves, read by the runner (`src/mastra/skills.ts`)                                                  |
| the guard's deny list                                                             | `src/guard.ts`                       | the **same list**, over Mastra's `beforeToolCall` hook                                                                   |
| the model                                                                         | `src/cli.ts` `pickModel`             | `Mastra` gateways; the MiniMax gateway (`src/mastra/gateways/minimax.ts`)                                                |
| usage (`usageFromMessage`)                                                        | `src/session.ts`                     | `answer.usage` — tokens only, no cost                                                                                    |
| the Pi transcript                                                                 | `src/extension.ts`                   | gone with the door; the run's own log file under `build/diagnostics/issue-<N>/` is what a human reads                    |
| the version gate (`src/version.ts`) and the package's public API (`src/index.ts`) | —                                    | **gone**: the package is a `bin` with no exports                                                                         |

## 3. What did not change

`src/git.ts`, `src/gh.ts`, `src/claim.ts`, `src/lock.ts`, `src/budget.ts`,
`src/gates.ts`, the run record (`writeRunRecord`, `renderRecord` in `src/runner.ts`),
the deadline and the cut-off, `src/merge.ts` (except for its session, which goes through
the same `SessionFactory`), the CLI's options (except `--engine` and `--agent-dir`, which
are gone), the prompts, `contract/afk-runner.md`, `contract/merge.md`.

**The contract does not move:** `contract/afk-runner.md` names no session, no workflow
module, no decision tool and no engine. The one thing that had to be re-checked — "system
prompt, not a user turn" (the untrusted input rule) — survives, and has its own test.

## 4. The phases

Each phase was its own step, green on `npm run check`.

**Phase 1 — the Mastra agent beside Pi.** Done, and later dissolved into phase 4.

- `src/mastra/agent.ts`: the `Agent` — the system prompt from `systemPromptSections`,
  the tools, the skills, the memory.
- `src/mastra/session.ts`: `AgentSession` on Mastra — `prompt` → `agent.generate`,
  `abort` → `AbortController.abort()`, `messages` → the last assistant message.
- `src/tools.ts` + `src/mastra/tools.ts`: the runner's own description of a tool, and
  Mastra's object over it. The five decision tools keep their names, their schemas and
  their holder.
- `src/mastra/skills.ts`: the skill directories the run carries — the runner's own and
  the target's `.agents/skills`.
- `src/mastra/log.ts`: the run's own log (the `onEvent` lines).
- `src/mastra/guard.ts`: the deny list `src/guard.ts` holds, over Mastra's
  `beforeToolCall` hook.
- `src/mastra/model.ts` + `src/mastra/gateways/minimax.ts`: the model as
  `provider/model`, and the MiniMax gateway.
- **Acceptance:** `test/mastra.test.ts` — the tools mean what they say, the guard
  refuses what it must, the skills are the ones the prompts name, and a failed turn
  says so on the last assistant message.

**Phase 2 — the graph.** Done, but **not** as a Mastra workflow.

- `src/workflow.ts` is the runner's own graph. The engine gave the runner three things
  — `phase()`, `agent()` and `gate()` — and those three are now the runner's own words.
- The public API does not change: `WORKFLOW_STATES`, `WORKFLOW_ACTIONS`,
  `WorkflowState`, `StateOutcome`, `TurnRunner`, `StatesResult`, `runStates`,
  `runWorkSession`, `runReviewGate` keep their names and their shapes.
- The engine's statuses map onto the runner's own outcomes: a failed turn **stops** the
  run, a cut-off run comes back as an aborted run with the states that finished, and the
  review loop retries until the verdict passes.
- The engine was also the thing that pulled Pi back in: `@quintinshaw/pi-dynamic-workflows`
  imports the Pi SDK and declares it as a peer dependency. A Mastra workflow would have
  kept that chain alive, which is why the graph is written directly.
- **Acceptance:** `test/workflow.test.ts` stays green; the tests that drive a
  `TurnRunner` do not change.

**Phase 3 — memory and observability.** Done, except the store.

- `resourceId` is the worktree, `thread` is the run (`afk-runner`).
- The store is `InMemoryStore`: the memory of a run lives in the process, so a run that
  restarts loses its context. A `MastraCompositeStore` / `LibSQLStore` is the next step,
  and the README does not promise memory before it is there.
- Usage and the record are read from the agent's answer.

**Phase 4 — the switch.** Done.

- Mastra is the only engine. `--engine pi|mastra` and `--agent-dir` are usage errors.
- Removed: `@quintinshaw/pi-dynamic-workflows`, `@gotgenes/pi-permission-system`,
  `@earendil-works/pi-coding-agent`, `src/pi-tools.ts`, `src/version.ts`, `src/index.ts`,
  `.pi/settings.json`.
- **Acceptance:** `npm run check` is green, and no file in the tree imports the Pi SDK.

## 5. What was lost, and what came instead

| Lost                                        | Why                                   | What came instead                                                     |
| ------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------- |
| Pi's OAuth and its catalogue of providers   | a Mastra gateway is an API key        | the MiniMax gateway; `--model` names a Mastra model reference         |
| `$skill` as an SDK discovery                | Mastra's skills are directories       | the `$name` convention stays; the runner reads the directories itself |
| the Pi guard's deny mechanism               | it is another mechanism               | the runner's own deny filter, over the same patterns                  |
| the turn's failure as `stopReason: "error"` | Mastra throws                         | the same `Error`, settled on the last assistant message               |
| the recoverable review failure              | it was the engine's, not the runner's | a failed review stops the run: the finding stays on the issue         |
| the version gate                            | there is no SDK to gate               | `@mastra/core` is pinned exactly, at 1.81.0                           |
| the package's public API                    | it exported a version check           | the package is a `bin`                                                |

## 6. Risks

- **The API is moving.** 1.81.0: `.branch()` runs every true condition rather than the
  first one, and there is no `.doWhile` — only `.dountil`. The version is pinned exactly.
- **The store.** Without one, the memory lives only in the process: a run that restarts
  loses its context. No worse than before, but the README must not promise "memory".
- **The contract.** The one place it could move is "system prompt — not a user turn". It
  has its own test.

## 7. Links

- `contract/afk-runner.md`, `contract/merge.md` — what binds the runner.
- `docs/decisions/2026-11-05-pi-is-gone.md` — the decision that supersedes the one this
  plan was written for.
- `docs/decisions/2026-11-02-the-session-is-a-workflow.md` — the shape that stays.
- `docs/decisions/2026-11-01-the-work-is-a-conditional-graph.md` — the branch that
  stays.
- `docs/decisions/2026-11-05-the-runner-is-a-command-and-not-a-pi-extension.md` — the
  door that is already gone.
