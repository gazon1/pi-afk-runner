---
title: The merge pipeline is separate, and opt-in
status: accepted
date: 2026-11-02
authors: Command Code
deciders: Singularity Developer
tags: [merge, review, ci, pipeline, contract]
---

# The merge pipeline is separate, and opt-in

## Context

The work pipeline opens a reviewed pull request and stops. The contract says it **never merges** —
a human lands the change — and that is deliberate: the review a human reads, and the CI on the
pull request, are the two things between an agent's diff and `main`. A runner that also merged
would remove the only human gate the design has.

The queue that motivates the runner is worked unattended, though, and somebody still has to land
what the agent opened. Leaving that entirely manual gives the queue a ceiling: a pile of green,
reviewed pull requests and no one to merge them.

## Idea

Keep the **work** pipeline's never-merge guarantee exactly as it is, and add a second, opt-in mode
that lands what the work pipeline opened. The two pipelines do not merge their behaviour: the work
mode never merges, and the merge mode never works an issue. `--merge` is the explicit switch.

## Decision

**The merge pipeline is a separate CLI mode, `--merge`, and only lands pull requests the work
pipeline opened.**

- Its candidates are the open pull requests whose branch is `agent/issue-<N>`, against `--base`.
- A candidate lands only when its **newest** marked review comment says `**Verdict:** pass` (the
  gate's own rule: the newest marked comment decides, two verdicts decide nothing), it carries
  `agent-reviewed`, it is not a draft, and the repository's own `scripts/ci-verdict.py` states a
  successful run.
- The pipeline merges the current base into the branch in a worktree. **It lands a pull request only
  when the branch does not move.** A branch that has to move — a conflict, or the base's arrival
  breaking the gate — is resolved by an agent, gated by the repository's own `./check.sh`, pushed,
  and freshly reviewed; it lands on the **next** run, once CI has judged the new commit.
- No candidate is merged twice, and the host lock is the work pipeline's, so the two never run at
  once.

## Rationale

**Why a separate mode rather than a merge step in the sweep.** The contract binds the work
pipeline, and the safety property is "a successful injection reaches one pull request a human
reviews". A merge step in that pipeline would make every sweep a potential landing. A separate
mode keeps the default path's guarantee unchanged, and makes landing something someone asks for.

**Why the newest review decides.** The gate's own rule is the newest marked comment, and a comment
that states two verdicts decides nothing
(`2026-09-26-code-review-process.md`). A merge gate that read any `pass` in the history would land
a change a later review had blocked.

**Why the commit that lands is the commit CI judged.** GitHub's CI is per commit. A branch that
moved after CI ran is a branch whose new commit has no CI yet, and merging it would land a diff
nothing tested. So a moved branch is synced, gated, reviewed and **left**: the next run lands it
against a CI that has now judged it. The timer model makes that a delay of one tick, not a manual
step.

**Why the gate runs only on a moved branch.** An unchanged branch is the commit CI already gated;
running the target's `./check.sh` again for every merge costs a great deal and decides nothing new.
A moved branch is the one whose green is not yet known, so it is the one that pays for the gate.

**Why the merge agent commits nothing.** The runner commits and pushes, for the same reason the
work pipeline does: the push stays under the runner's control, and the identity is its own.

## Consequences

- The work pipeline is unchanged: `runOnce`, `--all` and the live chat still never merge, and the
  existing test that says so still passes.
- Landing is a second timer (or an explicit `--merge`), and it can only land what the work
  pipeline opened and reviewed.
- A pull request that needs a conflict resolved takes two runs: one to sync and re-review it, one to
  land it once CI is green.
- `test/merge.test.ts` is the guard: a pass is read the gate's way, a fail or a missing review is
  not a candidate, a red CI is not a candidate, and a conflicting branch is resolved, pushed and
  reviewed but not landed in the same run.

## Links

- `src/merge.ts` — the pipeline, the merge agent's prompt, and the per-pull-request record.
- `src/gh.ts` — `readOpenPullRequests`, `newestReviewVerdict`, `mergePullRequest`.
- `src/cli.ts` — `--merge`, and the mode's own reporting.
- `test/merge.test.ts` — the guard.
- `contract/afk-runner.md` — the work pipeline's contract, whose "never merges" this mode is the
  explicit exception to.
- `docs/decisions/2026-09-26-code-review-process.md` — what a review is, and what the gate counts.
