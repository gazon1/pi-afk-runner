# AGENTS.md

The rules for working on this repository. They are short on purpose; the documents they point at
carry the detail.

## What this repository is

A **Pi extension**: a package Pi loads, written in TypeScript, that takes an issue labelled
`ready-for-agent`, works it in an isolated worktree, opens a pull request and has a second agent
review it. It never merges.

It is a **separate repository** from the one it operates on, on purpose — the target is a Kotlin
Multiplatform application with its own gates, and a JavaScript toolchain inside it would put the
extension's code under the app's gates. The reasoning is in
[docs/decisions/2026-10-30-the-afk-runner-is-a-pi-extension.md](docs/decisions/2026-10-30-the-afk-runner-is-a-pi-extension.md).

## The check

```bash
npm run check   # typecheck, lint, test, build
```

One command, four checks. `npx vitest run` alone is not enough — the build copies the prompt
files next to the module, and a package Pi loads that does not build is a package Pi cannot load.

**Do not run the target repository's gates here.** `./check.sh`, `just gate` and the Gradle build
belong to the repository the runner operates on; there is no Gradle in this repository.

## The contract comes first

Before changing anything that **binds** — the queue selector, the labels, the brief's marker, the
review's marker and verdict, the registry entries, the worktree recipe — read
[contract/afk-runner.md](contract/afk-runner.md). It is a copy of the contract the target
repository owns, and the target's copy is the one that counts.

When the target's contract changes, copy it again. See
[contract/README.md](contract/README.md) for the rule.

## The practices

The working practices are copied from the target repository and apply here too:

| Document | What it settles |
|---|---|
| [docs/practices/AGENTS.md](docs/practices/AGENTS.md) | the house rules: the decision log, the commits, the long runs, the gates |
| [docs/practices/CODING_STANDARDS.md](docs/practices/CODING_STANDARDS.md) | the conventions no gate can check: consistency, naming, the level of abstraction |
| [docs/practices/tests.md](docs/practices/tests.md) | fakes over mocks, the tags, the diagnostics, the ban list |
| [docs/practices/verification.md](docs/practices/verification.md) | the order of the checks, and what a failed test means |
| [docs/practices/ci.md](docs/practices/ci.md) | the gate suite, and what CI's verdict means |
| [docs/practices/registering-a-gate.md](docs/practices/registering-a-gate.md) | how a check becomes a gate |
| [docs/practices/doc-maintenance.md](docs/practices/doc-maintenance.md) | when a document is written, changed or deleted |

Two of them change here rather than transfer: the **tags** are a Kotlin convention and do not
apply to a TypeScript suite, and the **ban list** names Kotlin tools.

## The skills

[skills/](skills/) holds the skills the runner's agent uses — the review, the gates, the change
workflow, the decision log, the issue triage — and
[writing-for-agents](skills/writing-for-agents/SKILL.md), which is how this repository's own
documents are written. When a prompt in `src/prompts/` names a skill, that skill is one of these.

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
