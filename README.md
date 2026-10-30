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

## Development

```bash
npm ci          # install what the lockfile says
npm run check   # typecheck, lint, test, build
```

## Licence

Apache-2.0.
