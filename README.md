# pi-afk-runner

An AFK queue runner: it takes an issue labelled `ready-for-agent`, gives it an isolated git
worktree, runs an agent on it, opens a pull request, and has a second agent review that pull
request. The agent runs on [Mastra](https://mastra.ai) — the runner's only engine.

**The work pipeline never merges.** A human merges — or the separate, opt-in merge pipeline does,
when it is asked to: `--merge` lands reviewed pull requests, and nothing lands before its review
and its CI say so.

## Status

The runner works end to end: claim, worktree, agent, gates, push, pull request, review and re-count
have been run against a real GitHub repository, unattended. It is not published to npm yet — build
it from a checkout and run the command. The plan and the specification live in the repository this
runner operates on — see
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

This is an **assembly**. The mechanics come from ready-made packages, pinned to exact versions in
`package.json`:

| Component | Version | What it does |
|---|---|---|
| `@mastra/core` | 1.81.0 | the engine: the agent, the workspace, the model gateway |
| `@mastra/memory` | 1.40.0 | the memory a run's turns live in |
| `@mastra/schema-compat` | 1.3.17 | the tool schemas, from typebox to Standard Schema |

Three things are irreducibly ours: the **exclusive claim** (a remote ref carrying a nonce — a
label cannot be a lock, because adding one is idempotent), the **binding to the contract above**,
and the **record** of a run.

## The version pin

The runner drives Mastra's API, against Mastra's own types. When Mastra changes that interface, a
runner written against the old one does not fail loudly — it fails by doing the wrong thing.

So the runner pins the version it was written for **exactly**, in `package.json`. The pin is the
gate: `npm ci` installs that version and nothing else, so a runner that stops is recoverable and a
runner that half-works is not. The package exports nothing — it is a **command**, not a library —
so there is no public API to keep compatible.

## Install

The runner is a **command**: it takes the lock, works one issue — or, with `--all`, every eligible
issue one after another — writes the record and gives the lock back.

### From a checkout

```bash
git clone <this repository> pi-afk-runner
cd pi-afk-runner
npm ci                 # install what the lockfile says
npm run build          # compile, and copy the prompt files next to the module
node dist/cli.js --checkout ~/work/singularity
```

`npm link` puts the same command on the `PATH` as `pi-afk-runner`.

### What the install brings

The work session runs in a **Mastra agent**, and it carries:

- the runner's own **skills** — the review, the gates, the change workflow, the decision log, the
  issue triage, and how to write for agents. The package ships them, and the run hands them to the
  agent, so a prompt may name one of them;
- the target repository's own **skills**, under `.agents/skills`. A skill the target declares wins
  over the runner's copy, so a skill is carried once;
- the **guard**: the rules that say what must never be touched — `*.env`, `*.pem`, and the command
  that would file a leftover behind the runner's bounds. The rules are the runner's own
  (`src/guard.ts`) and they are applied over the agent's tools;
- the runner's own **decision tools**: `agent_issue_decision`, `agent_scope_decision`,
  `agent_review_verdict`, `agent_leftover`, and the one that records the run's outcome;
- the **pack**: `agent_pack_codebase` hands the agent the repository as one document — the file
  tree and the files' contents — so it reads an area of the repository in one call instead of
  file by file. The pack is [repomix](https://github.com/yamadashy/repomix), and it is the
  runner's own: the repository's `repomix.config.*` is never loaded, the files the guard
  refuses are not in the pack, and nothing is fetched from the network. The pack holds the
  files as they are — no comment is stripped and no file is reduced to its structure — and the
  twenty-four megabytes of tree-sitter grammars repomix carries for that reduction are dropped
  by the install: the target repository is written in Kotlin, and repomix has no grammar for
  it. The decision is in
  [docs/decisions/2026-11-09-the-pack-drops-the-grammars-it-cannot-use.md](docs/decisions/2026-11-09-the-pack-drops-the-grammars-it-cannot-use.md).

Two things are **not** packages, on purpose. The **guardrail** — the rule that an issue body is
data — is a string in the code, because a rule read from disk can vanish without a word. And the
**rules of the run** — the deadline, the stop, the cut-off — are the runner's own, not the
engine's: the **graph** (`src/workflow/`) runs on Mastra's workflow engine, and the engine carries
the states, the branch and the review loop, and is told none of the runner's rules.

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

A model has to resolve, too: `--model <provider/id>` names one; without it the runner uses
MiniMax's own default. The key comes from the environment — `MINIMAX_API_KEY` — and the runner
holds no credential of its own.

### The gates a run runs

**A run runs no gate, and nothing in it builds.** The tree the agent leaves is the tree that is
pushed, and the pull request's own CI is what judges it. The work pipeline does not spend minutes
in a Gradle daemon before the review even starts — the speed is the point, and what is not checked
is said, not hidden.

**The agent may not build either.** The guard refuses the commands that build or gate — `./gw`,
`./gradlew`, `./check.sh`, `just gate`, `just tcheck-evals`, `just docs-audit` — and the
implement, verify and next turns say the same in words: do not build, do not compile, do not run
the checks; judge the change by reading it. The verify turn reports **what it did not check**.

**Which gates run is the repository's own business**, in two layers. The command line wins:

```bash
pi-afk-runner --gate "./check.sh --fast,just docs-audit" --gate-timeout-ms 900000
```

Then the repository's own file, in the root of the checkout the run works — `.afk-runner.json`:

```json
{ "gates": ["./check.sh --fast", "just docs-audit"], "gateTimeoutMs": 900000 }
```

Nothing else: a run that nobody told to gate runs no gate, and the contract's list is not a
fallback. A file that cannot be read ends the run where it stands — a runner that quietly fell
back to a list the repository did not ask for would judge a tree by somebody else's rules.

When a run *is* told to run gates, they run in the worktree, on the tree the agent left, in the
`gates` step between the session and the push. A gate that does not pass ends the run there: the
claim is released, the work stays on the local branch, and nothing is pushed. The record carries
the tail of what the gate printed, so a failed run says which gate failed and why. The whole of
what the gate printed goes to a file beside the record — `<the run's id>-gates.log` — and the
record names it: the record is a document a person reads, and the whole build log is kept without
being read. A gate that passed leaves no log behind.

The **agent does not run the gates** either: an instruction to run a gate is not a gate. A gate
that refuses the change goes back to the agent as a turn, with the gate's own output, and the
gates run again on what it fixed; a gate that refuses twice ends the run.

The run's budget is divided into three **reserved** shares: the session keeps two hours, the gates
keep an hour each — the same the merge door gives the same gate — and the review keeps what is
left. A run with no gate reserves no gate budget and carries a smaller ceiling. A smaller ceiling
(`--deadline-ms`) is a smaller run all the way through. A gate that is killed, or that never
started, has no exit code, and the record does not claim one.

**The host needs the repository's own tools** — for the gates a run was told to run. `just` and
whatever those gates call have to be on the machine the run works on. A gate that could not run
says so: `the gate just tcheck-evals could not run: just is not on this host` is not the same as
a gate that refused the change. The tools of a checkout live in **that checkout's own** venv, and
the repository's setup script says where: the gates run with the PATH it printed — or with the
venv it names when that venv was already there — so the gate CLI of that worktree is found rather
than somebody else's.

**The merge door is a separate mode and keeps its gate.** `--merge` still runs the full
`./check.sh` before it lands anything: that is the contract of the merge mode, and it is opt-in.

### The command — unattended

```bash
pi-afk-runner --checkout ~/work/singularity          # --repo defaults to that checkout's origin
```

A systemd timer runs it every hour; the unit passes `--all`, so one invocation drains the queue — it
works every eligible issue in turn, each one to the end of its journey (claim, worktree, triage,
scope, agent, gates, push, pull request, review, re-count) — and then stops.

`--all --workers N` works **N issues at once**. The issues are still worked one by one — each one to
the end of its journey — but N of them are in flight together, so a sweep of ten issues on a host
that can carry four takes four rounds instead of ten. It needs `--all`: the flag means "the whole
queue", and there is no queue to spread without one. One worker is the default, so nothing changes
for a run that does not name it. Each issue takes its own lock, so the workers never meet on the
same issue, and the lines they write name the issue they belong to (`issue 42 — [claim] ok — …`).

The **exit code says which step the run reached**, because a scheduler has nothing else to read:
`0` is a finished run, `1` says an issue could not be worked, `10`..`80` are the steps, `75` says
another runner holds the lock and `76` says the lock could not be taken. A run that stopped at the
gates leaves `45`, so a red gate is not read as an issue that could not be worked. The unit and the
codes are in [systemd/](systemd/README.md).

A sweep that works several issues at once ends with the code of the **failure of the issue with
the smallest number**: the order the failures happen in says nothing about the sweep, and the same
sweep says the same thing every time.

A finished run ends with a **summary** — the facts a reader wants, one per line, because a summary
is read line by line and a table wraps:

```
issue 42 — Fix the thing
pull request: #1040
review: pass
duration: 3m 12s
tokens: 12345
cost: $0.42
record: /path/to/the/checkout/build/diagnostics/issue-42/2026-10-30T09-00-00-000Z-abcdef12.md
```

The tokens and the cost are **absent** when the provider reported none — a zero is a number, and a
number a reader would trust. With `--all`, every issue gets one line and the sweep ends with its
total.

The lock is a real `flock`, held for the whole run: a lock file a killed runner leaves behind would
block the next one for ever, and a marker is not a lock — adding a label is idempotent. It is **per
issue**: `--issue <N>` takes `issue-<N>.lock`, so several runners may work different issues on one
host at once, while `--all` (and a run that picks the queue's first issue) takes the one queue lock
and then each issue's own lock as it works it.
It needs `flock(1)`, so the host is a Linux workstation; elsewhere the runner says the lock is
unusable rather than running two of itself.

### The run's branches

The work session is a graph, and two of its nodes decide whether the rest runs:

- **Triage.** The first turn decides whether the issue should be worked at all.
  `skip` closes it with the reason and the queue moves on. A decision the agent
  did not make is `work`, because the issue was labelled `ready-for-agent`.
- **Scope.** When the issue is being worked, the second turn decides whether it
  fits one run. `split` files two to eight smaller issues, chains each to the
  one before it (`**Depends on:** #N`), links them from the original and closes
  it. A parent whose pull request has not been merged yet holds its children out
  of the queue.

A `skip` or a `split` is a finished run: no branch is pushed and no pull request
is opened. The decisions are tools, `agent_issue_decision` and
`agent_scope_decision`; the graph is the runner's own.

The review is a loop, not a single pass. A `fail` verdict buys a fix turn (a
fresh session) and a push, and the fixed diff is reviewed again, up to three
times or until the run's deadline leaves no budget. A fix that changes nothing — the branch's head did not move — stops the
loop: there is nothing to push and nothing to review again. A review that was
cut off — by the deadline or by a human's stop — stops it too: it stated no
verdict, so there is nothing to fix and nothing to review again, and the run's
record says what cut it off. A review that still fails leaves its finding on
the issue and fails the run: the claim is released, the branch and the pull
request stay, and the next run continues them.

A review that **stated no verdict** — the reviewer answered, but never called
the verdict tool — gets a second turn in the same session: it is told what is
missing and ends the review with the verdict it reached. A review that already
stated its verdict ends there, and the first verdict stands: a second one
cannot change it.

A **small change** — a few files, a few dozen lines — skips the repository's
pre-push hook; an explicit `--no-verify`, or its absence, decides the rest. The
runner's own gates are not part of that rule: a run that was told to run them runs
the whole list on every worked issue, because they are the run's own verdict and
not the repository's hook. CI still gates landing in the merge mode.

### The engine

A run works on **Mastra**: a Mastra agent with Mastra's tools, its own memory and a Mastra model
gateway (`--model provider/model`, the key from the environment). The run, the gates, the record
and the contract do not know what the engine is — the seam is the session.

The engine's module is loaded only when a session is asked for, so a run that never starts one does
not pay for it. Its memory lives in the process for now, so a run that restarts loses its context.

### The model pool

Which models a run may use is the **host's** business, not the repository's: the pool is a file —
`models.yaml` in the agent's directory (`--agent-dir`), or the file `--pool` names. It says which
model is preferred, when one of them is at its peak tariff, and which one needs a proxy:

```yaml
models:
  - model: minimax/MiniMax-M3
    priority: 100
  - model: minimax/MiniMax-M2.7
    priority: 50
    peak:
      - "00:00-16:00"
    timezone: UTC
```

`--show-pool` says what the file means right now — which model would be used and why the others are
not — and runs nothing. A run moves between the models when one of them runs out of its limit, and
a model whose limit is gone stays out for the whole run. When no model can be used, the run stops
with the code `3`: there was no step to run, and a sweep stops there instead of failing every issue
in the queue.

`--model` wins over the pool: a named model is a decision, and the pool does not overrule a
decision. The file's `effort` is read and refused when it is not a level, and reported — the engine
has no thinking level to set. `models.example.yaml` is a filled-in example.

### What a run leaves behind

- a branch `agent/issue-<N>` and a pull request on it, carrying a review that opens with
  `<!-- agent-review -->`;
- the `agent-reviewed` label on that pull request, which is what makes the review gate count it;
- the issues the run filed for the work that follows from its own: each labelled `ready-for-agent`,
  each with a brief opening with `## Agent Brief`, so the next run picks them up. At most three a
  run, and never a second copy of something that is already open;
- or, for a split, the two to eight smaller issues it filed instead of working the original,
  chained by `**Depends on:**` so they run in order;
- a record under `build/diagnostics/issue-<N>/` in the checkout, and — when a gate failed — the
  log of what it printed beside it.

The worktree itself is scratch and is removed when the run finishes, successful or not: the branch
holds the work. The claim label stays
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

Each pull request's record goes under `build/diagnostics/merge/pr-<N>/`, and the journal of the merge
— the session's lines, written while it works — is the file beside it: a merge that is killed leaves
the journal behind, and it says what the merge was doing when it died. The sweep writes a journal of
its own, under `build/diagnostics/merge/` beside those directories: it holds the pull requests the
sweep considered, the ones it left alone and why, and the pull request it was working on when it
stopped, and a sweep that is killed leaves it behind. A failed step is reported
with its name and the pull request stays open; a skipped pull request is not a failure. A merge takes
its own lock — `merge.lock` — and not the work lock, so a merge and the work runs do not wait for each
other.

The sweep has one wall-clock, the same `--deadline-ms` the work run has: the conflict resolution, the
gate and the fresh review take shares of what is left when their turn comes, and a pull request it
does not start before the clock is gone is left for the next run, with that reason.

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
