# The AFK runner — the contract it binds to

This document is for whoever writes the runner: the author of the `pi-afk-runner` extension, or
anyone reading it later. It states **what this repository guarantees**, because those guarantees
are what the runner is written against, and they are the things that change when this repository
changes.

The runner itself is a Pi extension in its own repository. The decision is recorded in
`docs/decisions/2026-10-30-the-afk-runner-is-a-pi-extension.md`; the plan is
`docs/plans/2026-10-30-afk-issue-agent-pipeline.md`.

## Install and run

The runner is a Pi package, in its own repository:
**[gazon1/pi-afk-runner](https://github.com/gazon1/pi-afk-runner)**. Its instructions are there —
the components it is built from, the install, and the two ways to run it (from Pi, as the live
chat; from the CLI, unattended). The short version:

```bash
git clone https://github.com/gazon1/pi-afk-runner && cd pi-afk-runner
npm ci && npm run build
pi install -l --approve ./        # `--approve` is not optional: trust is per run
```

## What the runner does

One issue, one worktree, one pull request, one review of that pull request. It never merges.

```
select → claim → worktree → session → push → pull request → review → re-count → done
```

Its state lives in GitHub and in git, not in a file of its own: the issue's labels, the branch
`agent/issue-<N>`, the pull request, the review comment. A run that dies leaves those behind, and
a later run re-derives the state from them.

## The intake contract

| This repository guarantees | Where |
|---|---|
| The label `ready-for-agent` means "a human has judged this issue specified" | `.agents/skills/triage/SKILL.md:33-45` |
| The brief is the authoritative task, and a brief comment's first line is `## Agent Brief` | `.agents/skills/triage/AGENT-BRIEF.md:3,42` |
| The agent brief is behavioural, names no file paths, carries acceptance criteria and explicit scope boundaries | `.agents/skills/triage/AGENT-BRIEF.md:9-37` |
| The label `agent-in-progress` is the runner's claim marker | `gh label list` |

**The brief is the comment that opens with `## Agent Brief`.** The runner passes the body and the
comments to the agent and tells it, in the system prompt, which one is the contract.

**When no comment carries the marker, the brief is the issue's body.** The queue this runner was
built for was labelled before the marker was agreed, and its briefs are in the bodies — a runner
that found no brief would take an issue with no contract at all. An issue with neither — no
comment carrying the marker and an empty body — is **refused**, not worked: a runner that cannot
find the contract says so instead of handing an agent an empty task.

The issue body is **untrusted input**. The repository is public, so anybody can write one. The
runner fences it, labels it as untrusted, and puts the rule that it is not to be obeyed in the
**system prompt** — not in a user turn, where an injection would compete with it.

## The claim

The claim is two things, and both are needed.

**The label** `agent-in-progress` is what a human sees, and it is what moves the issue's
last-update time — the staleness signal the runner uses to recognise a claim left behind by a run
that died. It goes on **first**.

**The ref** is what makes the claim exclusive. The label cannot: adding a label is idempotent, so
two runners both "win" it. The runner creates a ref carrying the claim, with a **nonce in its
message** so that its object is never identical to the one already there. Git refuses to update an
existing ref without `--force`, and a differing object is always rejected — while a plain push of
the *same* object answers "Everything up-to-date" and exits 0, which is why the nonce is not
optional.

If the ref creation is rejected, another runner holds the issue: the runner removes the label it
just added and moves on. It must not leave a claim behind.

## The worktree

A worktree on `agent/issue-<N>`, created from `origin/main`.

**`scripts/setup-worktree.sh` must run in it before any other command.** A generic worktree
extension cannot do what that script does, and this repository needs all of it:

| What | Where |
|---|---|
| the `core.bare` repair — a worktree of a bare main checkout is not usable | `scripts/setup-worktree.sh:182-183` |
| the per-worktree `core.hooksPath` — the pre-push hook must be this repository's | `scripts/setup-worktree.sh:197-209` |
| the `.env` copy — the canonical checkout holds it, a worktree does not | `scripts/setup-worktree.sh:268-286` |
| the per-checkout venv and the private Gradle home — two builds at once must not share a cache | `scripts/setup-worktree.sh:311-335`, `docs/decisions/2026-10-04-gradle-daemon-isolation.md` |

The layout of the checkout is resolved through `config/git-layout.sh`, not re-derived: two scripts
that need the same facts used to keep separate copies, and they drifted.

## The gates the agent runs

The set the repository's own review skill names
(`.agents/skills/code-review-pr-workflow/SKILL.md:40-50`):

```bash
./check.sh            # the static gates, the JVM tests, the Android assemble, detekt
just tcheck-evals     # the agent workflow evals
just docs-audit       # frontmatter, doc sizes, dead references, the digest
```

**Not `just gate`.** It is three steps, and the third runs the Maestro agenda flows on a device
(`.just/tests/mod.just:190-220`, `docs/decisions/2026-10-04-one-gate-recipe.md`), which an
unattended host does not have. `SKIP_MAESTRO=1` skips it and the recipe says in its own output
that a run without the flows "does not gate the flows". `just gate` is also not a superset: the
same ADR records that it does not run `docs-audit` or `find-unwired-surfaces`.

## The pull request and its review

| This repository guarantees | Where |
|---|---|
| The review comment must **open** with `<!-- agent-review -->` — a comment that merely quotes the format is not a review | `scripts/ci/check-agent-review.py:164-178` |
| The verdict line's value is exactly `**Verdict:** pass` or `**Verdict:** fail` | `scripts/ci/check-agent-review.py:146-149` |
| The **newest** marked comment decides; a newest comment with no verdict decides nothing rather than falling back to an older `pass` | `scripts/ci/check-agent-review.py:216-238` |
| A `fail` verdict fails the gate | `scripts/ci/check-agent-review.py:233-237` |
| The gate does not judge the comment's author — "separate" is a fact about the session, not the login | `scripts/ci/check-agent-review.py:88-94` |
| The review must be **re-counted**: a comment does not start a CI run, and a run started by the comment has its checks counted on the default branch | `.github/PULL_REQUEST_TEMPLATE.md:38-39`, `docs/architecture/verification.md:126-128` |

So the runner applies the label `agent-reviewed` **to the pull request** after the comment lands.
Without that, the pull request stays red.

**The runner reviews once.** The gate decides on the newest marked comment, so a second review
overrides the first — a `pass` after a `fail` would turn a red pull request green on a review of a
different diff.

**The runner quotes every finding that mentions a verdict.** The gate counts the verdict lines of
a comment, and a comment that states two decides nothing. The runner therefore quotes anything
containing the word — **wider** than the gate's own rule at
`scripts/ci/check-agent-review.py:146-149`. That is deliberate: the gate's rule may be widened
later, and a runner that copied it exactly would then fail to quote a finding that looks like a
verdict, so the comment would state two and the gate would say it decides nothing. The pull request
would be red with no review on it, and nothing would say why.

### What the runner says about CI

The runner reads CI with the repository's own tool, `scripts/ci-verdict.py`, and it says what the
tool says — the workflow, the run and the conclusion, or nothing at all.

**The tool's exit code is its verdict**: 0 when the CI succeeded, 1 when it did not, 2 when there
is no run, 3 when the runs could not be read
(`scripts/ci-verdict.py:48-52`). It prints the line and *then* exits with that conclusion, so a
red CI is a non-zero exit and the answer travels with the failure. The runner asks for `--json`
and reads the answer whether the exit code was zero or not — reading only the success path would
report a red CI as no CI at all, which is the one case a reader is looking for.

The line the runner reports is the run that **judged the commit**, not the one the re-count has
just started — so the runner reads it before it applies the label, and says which run it is.

## When the pull request lands a change

A change directory under `openspec/changes/` needs two more files in the pull request:

| File | What | Where |
|---|---|---|
| `.specify/issues/<slug>.yaml` | the registry entry, pointing back at the change **by slug** | `scripts/check-issue-registry.py:28-35` |
| `.specify/reviews/<slug>.md` | the verdict file, with `pr:` naming **this** pull request and `documents:` carrying the digest | `scripts/check-review-verdicts.py:19-29` |

The `documents:` digest is computed by `scripts/check-review-verdicts.py --digest <slug>` — the same
implementation the gate uses, so the recorded value and the checked value cannot disagree. The
review gate checks the pointer too: a change whose contract the pull request moves must carry a
verdict naming that pull request (`scripts/ci/check-agent-review.py:313-354`).

A bug fix, a docs change and a test-only change need none of this — but the runner has to decide
which kind of change it is making.

## What the runner must never do

- **Merge.** Not the pull request, not anything. The `agent-reviewed` label exists so a *review* is
  re-counted, not so a change lands unattended.
- **Push outside `agent/issue-<N>`.** The only other ref it may write is its own claim ref. The
  branch prefix is the guard that keeps a successful injection from reaching further than one
  pull request a human reviews.
- **Change a gate.** The runner is not a check that runs on every commit, so it is not registered in
  the gate registry and does not need a positive control. It does not modify
  `.github/workflows/ci.yml`, the gate scripts, or the review gate's own rules.
- **Run two builds at once.** `./gw` gives each worktree a private `GRADLE_USER_HOME`
  (`gw:84-85`), and the detekt verdict in the pre-push hook takes about nine minutes for a
  `shared/` change. One issue at a time.
- **Send the run's content anywhere.** The record stays on the machine, under
  `build/diagnostics/issue-<N>/`. Issue bodies are attacker-writable; a third-party telemetry
  service would be a channel for them.

## The record

A run writes to `build/diagnostics/issue-<N>/`: the session's events, the steps the runner took, and
the outcome. The issue number plus a run identifier correlates the events of one run — the
identifier is needed because the same issue can be reclaimed and worked twice.

The record has one job: let a person reconstruct what happened without the runner's process. A
record that cannot distinguish "the push failed" from "the agent failed" is not a record.
