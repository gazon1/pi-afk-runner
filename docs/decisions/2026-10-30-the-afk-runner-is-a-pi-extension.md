---
title: The AFK runner is a Pi extension, assembled from ready-made parts
date: 2026-10-30
status: accepted
tags: [process, tooling, agent, github]
---

## Context

Seventy-six issues carry `ready-for-agent`, each with an agent brief that
`.agents/skills/triage/AGENT-BRIEF.md:3` calls "the authoritative specification that an AFK agent
will work from". The intake contract exists and is maintained. The executor does not: nothing in
this repository reads the `agent-in-progress` label, creates a worktree for an issue, or opens a
pull request on anyone's behalf.

Everything else the runner would need is already here, and has been for a while: the worktree
recipe (`scripts/setup-worktree.sh:5-8`), the review gate
(`scripts/ci/check-agent-review.py:137-238`), the verdict-file gate
(`scripts/check-review-verdicts.py:19-29`), the issue registry
(`scripts/check-issue-registry.py:28-35`), the re-count label, and the triage state machine.

What was missing was a decision about **where the runner lives, what language it is written in, and
how much of it is written at all**. The plan went through three answers
(`docs/plans/2026-10-30-afk-issue-agent-pipeline.md`):

1. A Python script in this repository that shells out to `pi --mode json -p`.
2. A TypeScript Pi extension in its own repository, built on the Pi SDK.
3. The same extension, but **assembled from ready-made Pi extensions** rather than written.

The third answer came out of reading the ecosystem rather than the codebase. The npm keyword that
marks a package as a Pi package is `pi-package`, and the registry holds **13 036** of them
(2026-10-30). The Pi package itself ships **70+ example extensions** under
`examples/extensions/`, versioned with Pi.

## Idea

Write the runner as a TypeScript Pi extension that depends on ready-made Pi extensions for the
mechanics — the worktree, the delegation, the guard, the cron, the pull request, the structured
verdict, the auto-commit, the system prompt — and writes only the three things that are specific
to this repository: the exclusive claim, the binding to this repository's contract, and the record
of a run.

## Decision

**1. The runner is a TypeScript Pi extension, in its own repository, built on the Pi SDK.**

Pi is `@earendil-works/pi-coding-agent` 1.4.0. Its SDK exports `createAgentSession`,
`AgentSessionConfig.cwd` (the package's `dist/core/agent-session.d.ts:116`), `session.prompt`
(`:553`), `session.steer` (`:574`), `session.abort` (`:654`) and the typed `AgentSessionEvent`
union (`:47-61`). Four things the CLI could not do are one field and three method calls away: the
session's working directory **is** the worktree; the prompt array is three `prompt()` calls in one
session; steering and aborting a turn are API calls rather than a JSONL protocol to hand-roll; and
the events are typed rather than parsed out of a log.

The CLI's `--append-system-prompt` **silently ignores a missing file** (measured). The extension
builds the system prompt itself, so the guardrail is a string and there is no file that can vanish.

**2. The mechanics are installed, not written.**

| Component | Source | Version | Downloads/wk |
|---|---|---|---|
| The reviewer (delegation) | `pi-subagents` | v0.84.0 | 329 003 |
| The executor/advisor flow | `pi-advisor-flow` | v0.14.3 | 18 693 |
| The multi-step workflow | `@quintinshaw/pi-dynamic-workflows` | v3.15.0 | 16 045 |
| Live lint and format feedback | `pi-lens` | v4.4.7 | 26 609 |
| The guard | `@gotgenes/pi-permission-system` | v42.0.0 | 10 648 |
| Cron, isolated runs, the run store | `agents-cron` | v0.15.0 | 2 152 |
| The worktree | `@signalridge/pi-worktree` | v1.4.5 | 47 |
| The pull request and its checks | `@narumitw/pi-github-pr` | v0.49.8 | 93 |
| The verdict, the commit, the system prompt, the steer queue, the event bus | the Pi package's own `examples/extensions/` | ships with Pi | — |

Three signals decide "stable", and they disagree often enough to be worth stating: the number of
published versions (a long history of shipping), the date of the last release (within days means
maintained), and the downloads per week (popularity, not fitness). `pi-worktree` — the unprefixed
one — has not moved since **2026-03-14**, while `@signalridge/pi-worktree` moved on 2026-10-12.
`pi-harness-runtime` has the most versions of anything in the ecosystem (473) and its orchestration
mode is explicitly beta. Prefer the first-party examples, prefer the high-version high-download
packages, and treat a package whose last release is months old as a candidate to read rather than
to depend on.

**3. The claim on an issue is an exclusive remote ref with a nonce — not the label.**

Adding a label is idempotent: a second add exits 0, so two runners both "win" it. And a plain
push of the same object is not exclusive either — git answers "Everything up-to-date" and exits
**0**. Measured on this host against a throwaway repository:

```
$ git push origin "$BASE:refs/heads/afk/claim-42"    # first claim
exit=0
$ git push origin "$OTHER:refs/heads/afk/claim-42"    # a different object
 ! [rejected]  (non-fast-forward)
exit=1
$ git push origin "$BASE:refs/heads/afk/claim-42"    # the same object again
Everything up-to-date
exit=0
```

So the claim ref's message carries a **nonce**, which makes its object unique and its creation
always rejected. The nonce is not decoration; without it the claim is not exclusive at all.

**4. Three things are irreducibly ours.**

The exclusive claim; the binding to this repository's contract — the brief's marker
(`## Agent Brief`), the review's marker and verdict (`<!-- agent-review -->` / `**Verdict:** pass`),
the re-count label (`agent-reviewed`), the registry entry and the verdict file with the digest
(`scripts/check-review-verdicts.py --digest`) — and the record of a run under
`build/diagnostics/issue-<N>/`.

**5. The run's content does not leave the machine.**

`@langfuse/pi-observability-plugin` would give the run traces for free, and was refused: it ships
the run's content to a third-party service, and the content includes **issue bodies, which are
attacker-writable on a public repository**.

## Rationale

**Why not a script in this repository.** A Python script that shells out to the CLI has to work
around two gaps — no `--cwd`, and a system prompt read from a path that may be missing — and it
has to parse a JSON event stream to learn what the agent did. It also puts an unattended tool that
pushes branches inside a repository whose gates assume a human author. The SDK removes the first
two problems; a separate repository removes the third.

**Why not write the whole thing.** The worktree, the delegation, the guard, the cron, the pull
request, the structured verdict, the auto-commit and the system prompt all exist as installable,
maintained packages or as first-party examples inside the Pi package. Writing them would be writing
them worse. `@drix10/agent-flow` goes further and describes this plan's shape almost exactly —
"one agent builds, a second reviews, a third tests, a guard keeps all three out of what they must
never touch", with Pi among its supported harnesses — but it is used 176 times a week against
`pi-subagents`' 329 003. Whether it is the engine or only the reference design is a question the
spike answers, not an argument.

**Why the claim is a ref and not a label.** The label is what a human sees, and it is what moves
the issue's last-update time — the staleness signal. It cannot be the lock, because it is
idempotent. The label goes on **first** so the staleness clock starts; the ref goes on second so
the claim is exclusive.

**Why a separate repository.** A Pi extension is a package Pi loads: it needs a version, a build
and a release. Putting a JavaScript toolchain into a Kotlin Multiplatform application repository
that has none would put the extension's code under the same review and gates as the application it
operates on.

## Consequences

**Better.** The runner is a thin assembly. The parts that are hardest — delegation in an isolated
context, the guard, the scheduler, the pull request — are maintained by other people. The live
chat is not a later phase: `session.steer` is an API call from the first run. The extension's own
Pi version range is checked at start-up, so a runner that half-works against a different Pi stops
instead.

**Worse, and accepted.**

- A second repository, with its own CI, its own release and its own version range.
- **Supply chain.** Six third-party packages run inside the agent. Pi's own documentation says to
  review third-party package source before installing it. Versions are pinned, each package's
  source is read before the first run, and the first-party examples need no install at all.
- **Composition is a claim, not a fact.** Six packages, each with its own idea of what a turn is
  and who owns the session. The spike exists to find out.
- **No second agent program to fall back to.** An extension runs *inside* Pi, so `mcode exec` is
  not a fallback any more. The provider is configured at deployment.
- The claim's nonce is a correctness-critical string, and nothing in the ecosystem enforces it.

## Links

- `docs/plans/2026-10-30-afk-issue-agent-pipeline.md` — the plan this decision implements
- `openspec/changes/afk-issue-agent-pipeline/` — the specification, model, design and verification
- `docs/architecture/afk-runner.md` — the contract the extension binds to
- `docs/decisions/2026-10-04-one-gate-recipe.md` — the gate recipe the runner's prompts name
- `docs/decisions/2026-10-04-gradle-daemon-isolation.md` — why each worktree needs its own Gradle home
- `docs/decisions/2026-10-23-the-bare-flag-lives-in-the-worktree-config.md` — the repair `scripts/setup-worktree.sh` performs
