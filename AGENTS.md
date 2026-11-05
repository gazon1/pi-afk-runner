# AGENTS.md

The rules for working on this repository. They are short on purpose; the documents they point at
carry the detail.

## What this repository is

A **command**: a TypeScript program, written against Mastra's API, that takes an issue labelled
`ready-for-agent`, works it in an isolated worktree, opens a pull request and has a second agent
review it. **The work pipeline never merges**; landing is the separate, opt-in `--merge` mode, and
it only lands what the work pipeline opened and reviewed.

It is a **separate repository** from the one it operates on, on purpose — the target is a Kotlin
Multiplatform application with its own gates, and a JavaScript toolchain inside it would put the
runner's code under the app's gates. The reasoning is in
[docs/decisions/2026-11-05-the-runner-is-a-command-and-not-a-pi-extension.md](docs/decisions/2026-11-05-the-runner-is-a-command-and-not-a-pi-extension.md).

The whole life of an issue — the states it is derived into, the plans they run, and every way a run
can end — is [docs/lifecycle.md](docs/lifecycle.md). A change to the selection, the claim, the
review loop or the release path is a change to that document.

## Working here through the runner

This repository is also a target for its own runner: `ready-for-agent`, an issue
whose body is the brief, and `scripts/setup-worktree.sh` prepare a worktree,
`./check.sh` is the gate the runner's prompt names, and `justfile` answers the
other two commands that prompt runs. Work comes back as a pull request with a
review that opens with `<!-- agent-review -->`; nothing merges itself.

## The check

```bash
mise install    # once: Node and the linters pinned in mise.toml
npm ci          # install what the lockfile says
./check.sh      # typecheck, lint, format, Knip, test, build, jactionlint
```

One command, and CI runs the same one. `npm run check` is the fast subset — typecheck, lint,
format, Knip, test, build — for a change that does not touch `.github/`. `npx vitest run` alone
is not enough: the build copies the prompt files next to the module, and a command that does not
build is a command that cannot run.

The vulnerability and secret scans need the network and a database, so they live in
`.github/workflows/security.yml` and run on every pull request and weekly. Run them by hand with
`mise exec -- osv-scanner scan source --lockfile=package-lock.json` and
`mise exec -- betterleaks git .` when a change touches dependencies.

Three rules a check cannot express, and the check that backs each:

- `contract/`, `docs/practices/`, `skills/` and `pipelines/` are copies from the target
  repository. A content change is fixed in the original and copied again; the formatter
  reformats a copy, and the next copy will need the same pass.
- `dist/` is built, never edited. The build writes it and CI checks the entry points it promises.
- A lint, format or scan finding is fixed, not silenced. An exception is one path and one rule,
  carries a reason, and needs a human decision.

**Do not run the target repository's gates here.** The `./check.sh`, `just gate` and Gradle build
of the repository this runner operates on belong to that checkout; there is no Gradle in this
repository. The `./check.sh` above is this package's own gate.

## The engine

A run works on **Mastra**, and Mastra is the only engine. The run, the gates, the record
and the contract do not know what the engine is underneath — the seam is the session
(`AgentSession`, `SessionFactory` in `src/session.ts`).

The runner's own description of a tool is in `src/tools.ts`, and the engine's object
over it is in `src/mastra/tools.ts`. The tools a turn ends on — the triage's decision,
the scope's decision, the related issues to batch, the review's verdict — are in
`src/decisions/`, one decision per file. The tool that packs the repository for the
agent is in `src/packing.ts`. The guard's rules are in `src/guard.ts` and the
engine applies them (`src/mastra/guard.ts`); the run's journal — the file a run writes —
is in `src/journal.ts`, and the run's log — the lines the reader sees — is in
`src/mastra/log.ts`. One description, one carrier, one spelling: a rule written twice is a
rule whose two copies drift.

The **graph** — the states a session moves through — runs on Mastra's workflow engine
(`@mastra/core/workflows`). It is a set of components in `src/workflow/`: the states,
the tokens the branch is keyed by, the errors, the step that runs one state, the
straight line, the work session, the review loop. The engine carries the states, the
branch and the loop; the rules of the run (the deadline, the stop, the cut-off) stay the
runner's own.

The decision is in
[docs/decisions/2026-11-06-the-graph-runs-on-the-mastra-workflow-engine.md](docs/decisions/2026-11-06-the-graph-runs-on-the-mastra-workflow-engine.md).

## A run gates nothing and builds nothing

A run runs **no** gate unless it is told to: the command line (`--gate`) or the repository's own
`.afk-runner.json` in the root of the checkout. The tree the agent leaves is the tree that is
pushed, and the pull request's own CI judges it.

Nothing in a run builds either: the guard refuses `./gw`, `./gradlew`, `./check.sh` and the
`just` gates, and the prompts say the same. The agent judges its change by reading it, and the
verify turn says what it did not check.

A run that _is_ told to run gates runs them in the `gates` step, and the **agent does not run
them**: an instruction to run a gate is not a gate. A gate that refuses the change goes back to
the agent as a turn, with the gate's own output, and the gates run again on what it fixed.

The merge door is a separate, opt-in mode and keeps the full `./check.sh`. The decisions are in
[docs/decisions/2026-11-05-a-run-gates-nothing-and-builds-nothing.md](docs/decisions/2026-11-05-a-run-gates-nothing-and-builds-nothing.md)
and
[docs/decisions/2026-11-05-the-workflow-runs-the-gates.md](docs/decisions/2026-11-05-the-workflow-runs-the-gates.md).

## The contract comes first

Before changing anything that **binds** — the queue selector, the labels, the brief's marker, the
review's marker and verdict, the registry entries, the worktree recipe — read
[contract/afk-runner.md](contract/afk-runner.md). It is a copy of the contract the target
repository owns, and the target's copy is the one that counts.

When the target's contract changes, copy it again. See
[contract/README.md](contract/README.md) for the rule.

Anything in the **merge** mode binds to [contract/merge.md](contract/merge.md) instead. That
contract is this repository's own, not a copy: the target's contract describes a pipeline that
never merges, and landing is the opt-in exception.

## The practices

The working practices are copied from the target repository and apply here too:

| Document                                                                     | What it settles                                                                  |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [docs/practices/AGENTS.md](docs/practices/AGENTS.md)                         | the house rules: the decision log, the commits, the long runs, the gates         |
| [docs/practices/CODING_STANDARDS.md](docs/practices/CODING_STANDARDS.md)     | the conventions no gate can check: consistency, naming, the level of abstraction |
| [docs/practices/tests.md](docs/practices/tests.md)                           | fakes over mocks, the tags, the diagnostics, the ban list                        |
| [docs/practices/verification.md](docs/practices/verification.md)             | the order of the checks, and what a failed test means                            |
| [docs/practices/ci.md](docs/practices/ci.md)                                 | the gate suite, and what CI's verdict means                                      |
| [docs/practices/registering-a-gate.md](docs/practices/registering-a-gate.md) | how a check becomes a gate                                                       |
| [docs/practices/doc-maintenance.md](docs/practices/doc-maintenance.md)       | when a document is written, changed or deleted                                   |

Two of them change here rather than transfer: the **tags** are a Kotlin convention and do not
apply to a TypeScript suite, and the **ban list** names Kotlin tools.

## The skills

[skills/](skills/) holds the skills the runner's agent uses — the review, the gates, the change
workflow, the decision log, the issue triage — and
[writing-for-agents](skills/writing-for-agents/SKILL.md), which is how this repository's own
documents are written.

A prompt in `src/prompts/` may name a skill, and then the skill has to be one **the work session
has**: a skill of the target repository's `.agents/skills`, or one of these. The runner reads the
directories itself (`src/mastra/skills.ts`) and hands them to the agent, so a skill the runner
depends on is a skill the runner carries. A skill that exists only on the host that happens to run
the runner is not one a prompt may name — the run has to be the same on every host.

A prompt names a skill as `$<name>`, and the suite reads that shape: every `$name` in a prompt is
a skill the runner carries, and a session on a host with no skills of its own has it anyway.

## One commit, one thought

A commit is one idea, and it builds and passes its own gates on its own. A diff over a hundred
files reads badly and bisects badly.

The message says what changed and why, in the style the target repository uses. When a commit
changes the contract, the registry or the plan, the regenerated files go in with what produced
them.

## A decision is a record

When a change picks between two reasonable options, changes a contract between layers, or needs a
non-obvious workaround, it gets a record in [docs/decisions/](docs/decisions/) — `Context / Idea /
Decision / Rationale / Consequences / Links` — and the digest is regenerated. A typo, a formatting
fix and a new function that follows an existing pattern are not decisions.
