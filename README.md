# pi-afk-runner

An AFK queue runner for [Pi](https://github.com/earendil-works/pi-coding-agent): it takes an
issue labelled `ready-for-agent`, gives it an isolated git worktree, runs an agent on it, opens a
pull request, and has a second agent review that pull request.

**The work pipeline never merges.** A human merges — or the separate, opt-in merge pipeline does,
when it is asked to: `--merge` lands reviewed pull requests, and nothing lands before its review
and its CI say so.

## Status

The runner works end to end: claim, worktree, agent, push, pull request, review and re-count have
been run against a real GitHub repository, unattended and through the live chat. It is not published
to npm yet — attach it to a Pi session with `--extension`, or install it from a checkout. The plan
and the specification live in the repository this runner operates on — see
[the change directory](https://github.com/gazon1/sing/tree/main/openspec/changes/afk-issue-agent-pipeline)
and [the contract](https://github.com/gazon1/sing/blob/main/docs/architecture/afk-runner.md).

## The contract

This runner is written against contracts that another repository owns, and those contracts change
when that repository changes. The binding is written down there:
**[the AFK runner contract](https://github.com/gazon1/sing/blob/main/docs/architecture/afk-runner.md)** —
the queue selector, the brief's marker, the review's marker and verdict, the re-count label, the
registry entries a landed change carries, and the worktree recipe.

The **merge** mode is not part of that contract — the work pipeline never merges — so its binding is
this repository's own: [contract/merge.md](contract/merge.md).

## The components

This is an **assembly**. The mechanics come from ready-made Pi packages, pinned to exact versions
in `package.json` and in `.pi/settings.json`:

| Component | Version | What it does |
|---|---|---|
| `pi-queue-steer-factory` | 0.17.11 | the steer queue: a human's correction, delivered at a turn boundary |
| `@gotgenes/pi-permission-system` | 42.0.0 | the guard: what must never be touched |

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
`.pi/settings.json`, which lists the ten components the runner is built from, and loads them
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
| `pi-queue-steer-factory` | the steer queue behind the live chat's corrections |
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

### What the target repository must provide

The runner works a repository it does not own, and it asks that repository for three things. A
repository without them fails at the worktree step, and nothing after it runs:

- `scripts/setup-worktree.sh` — run inside every new worktree before anything else. It is the
  repository's own recipe: the `core.bare` repair, the per-worktree `core.hooksPath`, the `.env` copy
  and the private build home;
- the labels `ready-for-agent` (the queue), `agent-in-progress` (the claim) and `agent-reviewed`
  (the re-count);
- an issue whose brief is a comment opening with `## Agent Brief`, or — when there is no such
  comment — the issue's body. An issue with neither is refused rather than worked.

A model has to resolve, too: `--model <provider/id>` names one; without it the CLI uses the first
model of the first provider with a credential, and the live chat uses the model of the session it
was started in.

### The pipeline — the steps a run takes

The steps are the runner's own: claim → worktree → session → push → pull request → review →
re-count. A repository that wants a different order, or a gate of its own, says so in
`.afk-runner/pipeline.yml` (or `.afk-runner/pipeline.yaml`):

```yaml
steps:
  - claim
  - worktree
  - session
  - gates
  - push
  - pull-request
  - review
  - re-count

gates:
  - ./check.sh
  - just docs-audit
```

`steps` is the ordered list of the steps the run takes, chosen from the runner's own kinds —
`claim`, `worktree`, `session`, `gates`, `push`, `pull-request`, `review`, `re-count`. The file
says which steps happen and in what order; what each step *does* is the runner's, and the run's
state machine is the one it has always been. A kind the runner does not know is refused when the
file is read — before the run claims an issue, not half-way through it.

The `claim` step is the one a pipeline cannot leave out: the claim is what stops two runners
working the same issue, and the runner does not let a file give that up.

`gates` is the list of commands the `gates` step runs, in the worktree, in order. A gate that
exits non-zero stops the run: the claim is released and nothing is pushed. A repository that
declares no gates runs none.

A repository with no pipeline file runs the steps it ran before: the list above without the
gates step, which runs only what the repository declares.

### From Pi — the live chat

```bash
pi install npm:pi-afk-runner          # or, from a checkout: pi install -l --approve ../pi-afk-runner
cd /path/to/the/repository/you/want/to/work/in
pi --approve
```

The extension loads with the session. It registers two commands:

```
/afk-runner-version              which Pi this is, and whether this extension supports it
/afk-runner-run [--issue <N>]    work one issue, in a session this extension owns
/afk-runner-stop                 stop the run under way
/afk-runner-attach               open the run's session as this chat, history and all
```

`/afk-runner-run` takes the CLI's options, and two of them are defaults rather than
requirements: the **repository** is the checkout's `origin` (start Pi in the repository you want
worked), and the **model** is the one the session is already running on. `--repo` and `--model`
override them.

`/afk-runner-run` starts a run in the session the runner owns — a session whose `cwd` is the
worktree, created by the same factory the CLI uses — and returns while it works. The footer then
carries one line:

```
#42 · Fix the thing · session
```

which is the issue, its title, and the step the run has reached. The line is a session entry as well
as a footer: open the session again and the line the run ended on is still there.

Above the editor, six lines of the run itself — the agent's tool calls and the lines it says, as it
says them — so a run can be watched from the session that started it:

```
→ bash: ./check.sh
· The suite is red on the auth module; I will fix the fixture first.
→ edit: shared/src/jvmTest/.../SecureSessionManagerTest.kt
```

While a run is under way, anything typed into the host session is **steering**: it is queued, and
delivered into the work session at its next real boundary — after the assistant turn that is
running, before the next model call. Images travel with it. Slash commands and `!` shell lines are
left to the host session. One run at a time; a second `/afk-runner-run` says so.

`/afk-runner-attach` is how a human gets into the work session: it is headless while it runs, but
its transcript is a Pi session file, and the command switches this chat to it — the whole
conversation, and you can carry on from it. It refuses while the agent is working (stop first, or
wait for it to settle) and restores the worktree if the run's own cleanup already removed it.
`/afk-runner-run` makes that same switch as soon as the work session exists, so the run can be
watched from this chat; when the run's cleanup then removes the worktree the chat is sitting in, the
run puts it back before it ends.

`/afk-runner-stop` cuts the agent's turn the way the deadline does: the run fails where it stands
and its failure path releases the claim and the worktree, while the branch keeps the commits it has.
Killing the process instead leaves the claim to go stale.

### From the CLI — unattended

```bash
pi-afk-runner --checkout ~/work/singularity          # --repo defaults to that checkout's origin
```

A systemd timer runs it every hour; the unit passes `--all`, so one invocation drains the queue — it
works every eligible issue in turn, each one to the end of its journey (claim, worktree, agent,
push, pull request, review, re-count) — and then stops.

The **exit code says which step the run reached**, because a scheduler has nothing else to read:
`0` is a finished run, `1` says an issue could not be worked, `10`..`80` are the steps, `75` says
another runner holds the lock and `76` says the lock could not be taken. The unit and the codes are
in [systemd/](systemd/README.md).

The lock is a real `flock`, held for the whole run: a lock file a killed runner leaves behind would
block the next one for ever, and a marker is not a lock — adding a label is idempotent. It is **per
issue**: `--issue <N>` takes `issue-<N>.lock`, so several runners may work different issues on one
host at once, while `--all` (and a run that picks the queue's first issue) takes the one queue lock
and then each issue's own lock as it works it.
It needs `flock(1)`, so the host is a Linux workstation; elsewhere the runner says the lock is
unusable rather than running two of itself.

### What a run leaves behind

- a branch `agent/issue-<N>` and a pull request on it, carrying a review that opens with
  `<!-- agent-review -->`;
- the `agent-reviewed` label on that pull request, which is what makes the review gate count it;
- the issues the run filed for the work that follows from its own: each labelled `ready-for-agent`,
  each with a brief opening with `## Agent Brief`, so the next run picks them up. At most three a
  run, and never a second copy of something that is already open;
- a record under `build/diagnostics/issue-<N>/` in the checkout.

The worktree itself is scratch and is removed when the run finishes, successful or not: the branch
holds the work — unless this chat was switched into the run's session, in which case the worktree is
put back first, because a chat whose working directory is gone can read nothing. The claim label stays
on the issue until it closes — an issue without it is back in the
queue — so the target repository's own workflow removes it on close
(`.github/workflows/afk-label-cleanup.yml` in the repository this runner was written for).

## Merging — the separate pipeline

The work pipeline stops at a reviewed pull request. Landing it is a **separate, opt-in mode**:

```bash
pi-afk-runner --checkout ~/work/singularity --merge
```

It reads the open pull requests against `--base` (default `main`) and considers only the ones whose
branch is `agent/issue-<N>` — the work pipeline's own. A pull request is a candidate when its
**newest** marked review comment says `**Verdict:** pass`, it carries `agent-reviewed`, it is not a
draft, and the repository's own CI tool (`scripts/ci-verdict.py`) says the run was a success. Anything
else is reported and left alone; the next run reads it again.

For each candidate it makes a worktree on the branch, merges the current base into it, and lands it
**only when the branch does not move** — the commit CI judged is the commit that lands. When the
branch has to move — the base moved under it, a conflict had to be resolved, or the gate failed — an
agent resolves the worktree, the runner runs the repository's gate (`./check.sh`), pushes, and posts a
fresh review of the new diff. That pull request is **not** merged in the same run: it lands on the
next one, once CI has judged the new commit. A merge never lands a commit CI has not seen.

Each pull request's record goes under `build/diagnostics/merge/pr-<N>/`. A failed step is reported
with its name and the pull request stays open; a skipped pull request is not a failure. A merge takes
its own lock — `merge.lock` — and not the work lock, so a merge and the work runs do not wait for each
other.

The decision is recorded in
[docs/decisions/2026-11-02-the-merge-pipeline-is-separate.md](docs/decisions/2026-11-02-the-merge-pipeline-is-separate.md).
The contract's "never merges" is the **work** pipeline's rule; this mode is the explicit exception,
and it only lands what that pipeline opened and reviewed.

## What is in this repository

| Directory | What it is |
|---|---|
| `src/` | the runner: the queue, the claim, the worktree, the session, the push, the pull request, the review, the record |
| `test/` | the suite, in the repository it operates on's sandbox — real `git` in a temporary directory, stubbed `gh` and stubbed agent |
| `contract/` | **a copy** of the contract this runner binds to, taken from the repository it operates on — see [contract/README.md](contract/README.md) |
| `docs/decisions/` | the decisions behind the runner and the practices it inherits |
| `docs/practices/` | the working practices: the agent's rules, the coding standards, the test rules, the order of the checks, the gate registry, the docs lifecycle |
| `skills/` | the skills the runner's agent uses — the review, the gates, the change workflow, the decision log, the issue triage, and how to write for agents. The package ships them, and the work session's skill paths carry them, so a prompt may name one of them |
| `pipelines/` | the CI workflow the runner's verdict tool reads |
| `systemd/` | the service and the timer that run it unattended, and what the exit codes mean |

`contract/`, `docs/practices/`, `skills/` and `pipelines/` are copies from the repository this
runner operates on. The runner **runs** that repository's copies — the ones here are for the
tests, for the reader, and for the agent's own working rules. The skills are also **shipped**:
the package carries them and the work session's skill paths point at them, so that a skill a
prompt names is a skill the runner carries rather than one the host happens to have.

## Development

```bash
npm ci          # install what the lockfile says
npm run check   # typecheck, lint, test, build
```

## Licence

Apache-2.0.
