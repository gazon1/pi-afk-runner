# The run runs on Mastra — the plan

The decision this plan implements:
[2026-11-05-the-run-runs-on-mastra.md](../decisions/2026-11-05-the-run-runs-on-mastra.md).
The boundary it settles: **Mastra replaces the runner's agent runtime and the runner's
graph.** The seams (`AgentSession`, `SessionFactory`, `TurnRunner`) and the contract stay
where they are.

Verified against `@mastra/core` 1.81.0 (the types in
`node_modules/@mastra/core/dist`), a local run of `createWorkflow` + `createStep` +
`.branch()` with no server, the typebox → `toStandardSchema` conversion from
`@mastra/schema-compat`, `@mastra/core/storage` (`InMemoryStore`, `InMemoryMemory`,
`MastraCompositeStore`), and `@mastra/core/test-utils` (`createMockModel`,
`MockProvider`).

---

## 1. The boundary

| | Today | Chosen |
|---|---|---|
| The runner's sessions (work, review, merge resolution) | a Pi session (`src/cli.ts:482` `piSessionFactory`) | **Mastra `Agent` + `Memory`** |
| The graph engine | `@quintinshaw/pi-dynamic-workflows` (`src/workflow.ts:307` `runEngine`) | **Mastra Workflow** |
| The decision tools | Pi `defineTool` + typebox | **one description (`src/tools.ts`), two adapters** |
| Skills | Pi `additionalSkillPaths` (`src/cli.ts:391`), `$name` in prompts | **Mastra skills by directory**; the `$name` rule stands |
| The guard | `@gotgenes/pi-permission-system` (`src/guard.ts:91`) | **the same rules, over Mastra's own hook** |
| The model | Pi `modelRuntime` (`src/cli.ts:595` `pickModel`) | **a Mastra gateway** (the MiniMax one from `mastra-app`) |
| The live door (`src/extension.ts`) | a Pi extension: steers into the run's session, opens the Pi transcript | **gone** — the runner is a command ([2026-11-05-the-runner-is-a-command-and-not-a-pi-extension](../decisions/2026-11-05-the-runner-is-a-command-and-not-a-pi-extension.md)) |

The alternative — replace the engine only and keep the self-written session — is not
what was chosen: it leaves the self-written session in place, and Mastra would then
supply only the graph.

## 2. What is replaced, and by what

| Today | File | On Mastra |
|---|---|---|
| Three script strings (`LINEAR_SCRIPT` `:120`, `WORK_SCRIPT` `:141`, `REVIEW_SCRIPT` `:190`) | `src/workflow.ts` | one `createWorkflow` for the graph, a `createStep` per state |
| `runEngine` / `turnAgent` | `src/workflow.ts:307`, `:248` | Mastra steps; the `TurnRunner` seam (`src/workflow.ts:104`) stays as it is |
| the review's `gate` (review → fix → review) | `src/workflow.ts:451` `runReviewGate` | `.dountil(step, condition)`; the attempt is one step |
| the Pi session (`createAgentSession`, `DefaultResourceLoader`) | `src/cli.ts:482-531` | `new Agent(...)` + `agent.generate(prompt, {abortSignal, threadId, resourceId})` |
| `AgentSession` (`prompt`/`abort`/`dispose`/`messages`) | `src/session.ts:429` | stays the **interface**; the implementation is `src/mastra/session.ts` |
| `SessionFactory` | `src/session.ts:441` | stays the **seam**: `mastraSessionFactory` beside `piSessionFactory` |
| the five decision tools | `src/session.ts:844`, `:923`, `src/leftovers.ts:93`, `src/session.ts:1271`, `:1317` | **described once** in `src/tools.ts`; Pi's `defineTool` and Mastra's `createTool` build their own object from it; typebox through `toStandardSchema`; the **holder pattern stays** |
| skills discovery | `src/cli.ts:391`, `src/session.ts:264` | the directories themselves, read by the runner (`src/mastra/skills.ts`) and handed to the agent |
| the guard's deny list | `src/guard.ts:54`, `:91` | the **same list**, over Mastra's `beforeToolCall` hook |
| the model | `src/cli.ts:595` | `Mastra` gateways; the MiniMax gateway from `mastra-app` (`src/mastra/gateways/minimax.ts`) moves here |
| usage (`usageFromMessage` `src/session.ts:337`) | `src/session.ts` | `answer.usage` — tokens only, no cost |
| the Pi transcript | `src/extension.ts:96`, `:570` | gone with the door; the run's own log file under `build/diagnostics/issue-<N>/` is what a human reads |

## 3. What does not change

`src/git.ts`, `src/gh.ts`, `src/claim.ts`, `src/lock.ts`, `src/budget.ts`,
`src/gates.ts`, the run record (`writeRunRecord` `src/runner.ts:1361`, `renderRecord`
`:1310`), the deadline and the cut-off (`src/session.ts:747-761`, `cutOffMessage`
`:492`), `src/merge.ts` (except for its session, which goes through the same
`SessionFactory`), the CLI (`src/cli.ts`), the prompts (except for the skills' carrier),
`contract/afk-runner.md`, `contract/merge.md`.

**The contract does not move:** `contract/afk-runner.md` names no session, no workflow
module, no decision tool and no engine. One thing has to be re-checked: "system prompt
— not a user turn" (the untrusted input rule) has to survive the move to Mastra.

## 4. The phases

Each phase is its own pull request, green on `npm run check`, and none of them is
"everything at once".

**Phase 0 — the decision.** Done: the ADR above, this plan, the digest regenerated.

**Phase 1 — the Mastra agent beside Pi (the seams do not move).** Done.
- `src/mastra/agent.ts`: the `Agent` — the system prompt from `systemPromptSections`,
  the tools, the skills, the memory.
- `src/mastra/session.ts`: `AgentSession` on Mastra — `prompt` → `agent.generate`,
  `abort` → `AbortController.abort()`, `messages` → the last assistant message,
  `dispose` → the end of the thread.
- `src/tools.ts` + `src/pi-tools.ts` + `src/mastra/tools.ts`: the runner's own
  description of a tool, and each engine's adapter over it. The five decision tools
  keep their names, their schemas and their holder.
- `src/mastra/skills.ts`: the skill directories the run carries — the runner's own and
  the target's `.agents/skills` and `.pi/skills`.
- `src/mastra/log.ts`: the run's own log (today's `onEvent`).
- `src/mastra/guard.ts`: the deny list `src/guard.ts:54` holds, over Mastra's
  `beforeToolCall` hook.
- `src/mastra/model.ts` + `src/mastra/gateways/minimax.ts`: the model as
  `provider/model`, and the MiniMax gateway.
- `piSessionFactory` (`src/cli.ts:482`) and `mastraSessionFactory` side by side; the
  choice is `--engine pi|mastra`, Pi by default, and the Mastra module is loaded by a
  dynamic import so a Pi run does not pay for it.
- **Acceptance:** `test/mastra.test.ts` — the tools mean the same thing on both
  engines, the guard refuses the same things, the skills are the same ones, a failed
  turn says so the way Pi says it, and the flag chooses. The runner's own suite
  (`test/runner.test.ts`) is untouched and still green, because the seam did not move.

**Phase 2 — the Mastra graph (the engine).**
- `src/mastra/graph.ts`: the run's graph, declared:

  ```
  intake → triage → branch{skip → close-skip | work → scope} → branch{split → split | fits → brief}
         → implement → verify → next
  ```
- The branches are **mutually exclusive**: Mastra runs *every* true condition, not the
  first one.
- `src/mastra/review.ts`: the attempt (fix → review) as one step, plus the `dountil`.
- `src/workflow.ts`: `WORKFLOW_STATES`, `WORKFLOW_ACTIONS`, `WorkflowState`,
  `StateOutcome`, `TurnRunner`, `StatesResult`, `runStates`, `runWorkSession`,
  `runReviewGate` — **the same signatures**; only the engine call changes.
  `cutOffError` / `isCutOff` / `stateFailure` map onto Mastra's statuses
  (`success | failed | suspended | tripwire | paused | bailed`).
- `@quintinshaw/pi-dynamic-workflows` leaves the dependencies.
- **Acceptance:** `test/workflow.test.ts` runs on the Mastra engine; the tests that
  drive a `TurnRunner` stay as they are.

**Phase 3 — memory and observability.**
- `resourceId` is the repository, `threadId` is the run (the issue and the attempt).
  `observationalMemory` needs a thread id — without one Mastra throws
  `OBSERVATIONAL_MEMORY_THREAD_ID_REQUIRED`.
- The store: `InMemoryStore` in the tests, `MastraCompositeStore` / `LibSQLStore` in
  the runs — without a store the memory lives only inside the process.
- Usage and the record are read from the agent's answer; the log file replaces the Pi
  transcript.
- **Acceptance:** the run record (`src/runner.ts:1361`) carries the same fields.

**Phase 4 — the switch.**
- `mastraSessionFactory` becomes the default; the Pi implementation stays behind a flag
  for a while.
- Removed: `@quintinshaw/pi-dynamic-workflows`, `@gotgenes/pi-permission-system`, the
  Pi session code (`src/cli.ts:29-33`, `:396-462`, `:482-531`), and
  `@earendil-works/pi-coding-agent` **from the run** (the peer dependency stays until the
  last Pi session is gone).
- **Acceptance:** `npm run check` is green; the Pi session's tests are untouched.

## 5. What breaks

| Lost | Why | The way round |
|---|---|---|
| Pi's OAuth and its catalogue of providers | a Mastra gateway is an API key | the MiniMax gateway and whoever else; `--model` names a Mastra model reference now |
| `$skill` as an SDK discovery | Mastra's skills are tools | the `$name` convention stays; the runner reads the directories itself |
| the Pi guard's deny mechanism | it is another mechanism | the runner's own deny filter, with the same patterns |
| the turn's failure as `stopReason: "error"` | Mastra throws | the same `Error` out of the adapter |
| the Pi provider's OAuth catalogue | — | the same row as the models |

## 6. Risks

- **The API is moving.** 1.81.0: `.doWhile` does not exist (only `.dountil`),
  `.branch()` runs every true condition, `createStep(agent, {structuredOutput})` has
  the input `{prompt}` and the output `{text}`. Pin the version and hide it behind our
  own types; the beta dynamic workflows are not used.
- **The size.** Phases 1 and 2 are the bulk of the work; phases 3 and 4 are smaller.
- **A big bang bisects badly.** The phases are cut so that each one is green on its
  own.
- **The store.** Without one, the memory lives only in the process: a run that restarts
  loses its context. That is no worse than today (the Pi transcript did not restore a
  state either), but the README must not promise "memory" until a store is there.
- **The contract.** The one place the contract could move is "system prompt — not a
  user turn". It gets its own test in phase 1.

## 7. To answer before phase 2 (the spike)

1. `.branch()` after `.then()`: does the following `.then()` continue each branch's path
   (needed for `scope → brief → implement → …`)?
2. Where does the result of a `createTool` call land in the agent's answer, and where
   does a `structuredOutput` land?
3. What does a run look like when a step throws (the status, and where the original
   error sits) — the mapping for `stateFailure`.
4. `agent.generate` with and without a `memory`: where does `usage` come from?
5. `createMockModel` (from `@mastra/core/test-utils`) as the test fake: can it return
   tool calls?

## 8. Links

- `contract/afk-runner.md`, `contract/merge.md` — what binds the runner.
- `docs/decisions/2026-11-05-the-run-runs-on-mastra.md` — the decision this plan
  implements.
- `docs/decisions/2026-11-02-the-session-is-a-workflow.md` — the shape that stays.
- `docs/decisions/2026-11-01-the-work-is-a-conditional-graph.md` — the branch that
  stays.
- `docs/decisions/2026-11-05-the-runner-is-a-command-and-not-a-pi-extension.md` — the
  door that is already gone.
- `/home/max/orca/workspaces/mastra-app` — the working MiniMax gateway and the Mastra
  primitives that were checked.
