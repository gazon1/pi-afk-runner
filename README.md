# pi-afk-runner

An AFK queue runner for [Pi](https://github.com/earendil-works/pi-coding-agent): it takes an
issue labelled `ready-for-agent`, gives it an isolated git worktree, runs an agent on it, opens a
pull request, and has a second agent review that pull request.

**It never merges.** A human merges.

## Status

Early. The package, its version gate and its tests exist; the runner does not yet. The plan and
the specification live in the repository this runner operates on — see
[the change directory](https://github.com/gazon1/sing/tree/main/openspec/changes/afk-issue-agent-pipeline)
and [the contract](https://github.com/gazon1/sing/blob/main/docs/architecture/afk-runner.md).

## The contract

This runner is written against contracts that another repository owns, and those contracts change
when that repository changes. The binding is written down there:
**[the AFK runner contract](https://github.com/gazon1/sing/blob/main/docs/architecture/afk-runner.md)** —
the queue selector, the brief's marker, the review's marker and verdict, the re-count label, the
registry entries a landed change carries, and the worktree recipe.

## The components

This is an **assembly**. The mechanics come from ready-made Pi packages, pinned to exact versions
in `package.json` and in `.pi/settings.json`:

| Component | Version | What it does |
|---|---|---|
| `pi-subagents` | 0.84.0 | delegation in an isolated context, in its own process |
| `pi-advisor-flow` | 0.14.3 | the executor/advisor flow |
| `@quintinshaw/pi-dynamic-workflows` | 3.15.0 | the multi-step workflow |
| `pi-lens` | 4.4.7 | live lint and format feedback inside the turn |
| `@gotgenes/pi-permission-system` | 42.0.0 | the guard: what must never be touched |
| `agents-cron` | 0.15.0 | cron, isolated runs, the run store |
| `@signalridge/pi-worktree` | 1.4.5 | the worktree |
| `@narumitw/pi-github-pr` | 0.49.8 | the pull request and its checks |
| `@drix10/agent-flow` | 1.2.7 | the builder / reviewer / QA roles, as skills |

Three things are irreducibly ours: the **exclusive claim** (a remote ref carrying a nonce — a
label cannot be a lock, because adding one is idempotent), the **binding to the contract above**,
and the **record** of a run.

## Two things to know before running it

**`--approve` is not optional.** Project-local packages load only when the project is trusted, and
the trust is granted **per run** — there is no persistent trusted-project list. A session started
without the flag loads the global packages and silently ignores `.pi/settings.json`.

```bash
pi --mode rpc --approve
```

**`pi list` does not show project-local packages.** It lists the user's. To see what this project
actually depends on, read `.pi/settings.json`.

## The version gate

An extension is code that runs inside the agent, against the agent's own API. When Pi changes that
interface, an extension written against the old one does not fail loudly — it fails by doing the
wrong thing.

So the extension declares the range of Pi it was written for and **refuses to run outside it**. A
runner that stops is recoverable; a runner that half-works is not.

```ts
import { assertInstalledPiVersion } from "pi-afk-runner";

await assertInstalledPiVersion(); // throws PiVersionMismatch outside the pinned range
```

## Install

The runner is a **Pi package**: Pi loads it, and the components it is built from are Pi packages
too.

### From a checkout

```bash
git clone <this repository> pi-afk-runner
cd pi-afk-runner
npm ci                 # install what the lockfile says
npm run build          # compile, and copy the prompt files next to the module
pi install -l --approve ./
```

That last command registers the extension with the Pi in this directory. Pi reads
`.pi/settings.json`, which lists the nine components the runner is built from, and loads them
along with the extension itself.

**`--approve` is not optional.** Project-local packages load only when the project is trusted, and
the trust is granted **per run** — there is no persistent trusted-project list. A session started
without the flag loads the global packages and silently ignores `.pi/settings.json`, and the
runner's components are simply not there. `pi list` does not show project-local packages either; to
see what this project actually depends on, read `.pi/settings.json`.

### From npm, once it is published

```bash
pi install npm:pi-afk-runner
```

### What the install brings

| Package | What it does |
|---|---|
| `pi-subagents` | the reviewer: delegation in an isolated context, in its own process |
| `pi-advisor-flow` | the executor/advisor flow |
| `@quintinshaw/pi-dynamic-workflows` | the multi-step workflow |
| `pi-lens` | live lint and format feedback inside the turn |
| `@gotgenes/pi-permission-system` | the guard: what must never be touched |
| `agents-cron` | cron, isolated runs, the run store |
| `@signalridge/pi-worktree` | the worktree |
| `@narumitw/pi-github-pr` | the pull request and its checks |
| `@drix10/agent-flow` | the builder / reviewer / QA roles, as skills |

Two things are **not** packages, on purpose. The **guardrail** — the rule that an issue body is
data — is a string in the code, because the CLI's `--append-system-prompt` silently ignores a
missing file and a rule read from disk can vanish without a word. And the **version gate** — the
refusal to run against a Pi this package was not written for — is the same kind of thing.

## Run

### From Pi — the live chat

```bash
cd /path/to/the/repository/you/want/to/work/in
pi
```

The extension loads with the session. It registers one command:

```
/afk-runner-version
```

which says which Pi the session is running against and whether that Pi is one this extension
supports.

### From the CLI — unattended

```bash
pi-afk-runner --run-once
pi-afk-runner --run-once --repo gazon1/sing
```

A timer or a systemd unit runs it every N minutes; one invocation takes one issue from the queue
and works it to the end of its journey — claim, worktree, agent, push, pull request, review — and
then stops.

> **The CLI entry point does not exist yet.** It is task T011 of the plan, and this section
> describes the command it will provide. Until then the extension loads in Pi and the pieces can be
> driven by hand, but there is nothing to run unattended.

### What a run leaves behind

- a pull request on the branch `agent/issue-<N>`, carrying a review that opens with
  `<!-- agent-review -->`;
- the `agent-reviewed` label on that pull request, which is what makes the review gate count it;
- a record under `build/diagnostics/issue-<N>/` in the worktree.

## What is in this repository

| Directory | What it is |
|---|---|
| `src/` | the runner: the queue, the claim, the worktree, the session, the push, the pull request, the review, the record |
| `test/` | the suite, in the repository it operates on's sandbox — real `git` in a temporary directory, stubbed `gh` and stubbed agent |
| `contract/` | **a copy** of the contract this runner binds to, taken from the repository it operates on — see [contract/README.md](contract/README.md) |
| `docs/decisions/` | the decisions behind the runner and the practices it inherits |
| `docs/practices/` | the working practices: the agent's rules, the coding standards, the test rules, the order of the checks, the gate registry, the docs lifecycle |
| `skills/` | the skills the runner's agent uses — the review, the gates, the change workflow, the decision log, the issue triage, and how to write for agents |
| `pipelines/` | the CI workflow the runner's verdict tool reads |

`contract/`, `docs/practices/`, `skills/` and `pipelines/` are copies from the repository this
runner operates on. The runner **runs** that repository's copies — the ones here are for the
tests, for the reader, and for the agent's own working rules.

## Development

```bash
npm ci          # install what the lockfile says
npm run check   # typecheck, lint, test, build
```

## Licence

Apache-2.0.
