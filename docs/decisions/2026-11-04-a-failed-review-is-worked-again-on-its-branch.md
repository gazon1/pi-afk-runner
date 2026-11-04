---
title: A review that said fail is worked again, on its own branch
status: accepted
date: 2026-11-04
authors: Command Code
deciders: Singularity Developer
tags: [runner, review, state, worktree, claim]
---

# A review that said fail is worked again, on its own branch

## Context

A run ends on a review that never passed. It commented its findings on the issue, threw, and the
release path let the claim go. The branch and the pull request stayed, as they are meant to
(`2026-11-02-a-run-that-did-not-finish-leaves-its-work.md`), and the comment said what the next run
was supposed to do:

> The branch and the pull request are kept. The next run picks this issue up and fixes what the
> review found.

Nothing did that reliably. The state was derived from six observables, and none of them was the
verdict: the issue had no claim, so it derived as `Queue`, and `Queue` means "claim it and work it"
— the four turns of a fresh run, against a branch that already carried the change and a pull
request whose review had already failed. The finding was one comment among many in the issue's
data. On a host whose checkout did not have the branch, `git worktree add -b` made it from the
base, the push was refused as a non-fast-forward, and the run failed without touching the work.

The two states that did read the pull request made it worse. `Reviewed` meant "count the review"
and `Counted` meant "the runner is done with it", so an issue whose claim *survived* a failed
review — a release that could not reach GitHub, a run stopped between the review and the release —
was reported as `already reviewed` or `already counted` for ever, and never worked again.

## Idea

The verdict is an observable, and a failed review is a **state of the work**: the branch, the pull
request and the findings are the work in progress, not a finished pull request and not an empty
queue.

## Decision

**The newest marked review comment's verdict is the seventh observable.** `W` joins `L`, `P`, `V`,
`C`, `R` and `A` in the derivation, read with the gate's own rule (`src/gh.ts`,
`newestReviewVerdict`).

**`Failed` is a derived state, and it is asked before the claim.** A pull request with a review
that said fail derives `Failed` whether or not the claim is still on the issue. The claim is a
pointer at the pull request; it is not what makes a review count.

**`Failed` plans `rework`.** The rework is a run that:

| Step | What it does |
|---|---|
| claim | takes the claim over — the ref is replaced, the branch is kept — whether the claim is still on the issue or not |
| worktree | continues the branch — from the local branch, or from the remote's tip when the checkout has none |
| session | is told it is a rework: the failed review arrives as data above the issue, and a rule in the system prompt says the branch is the work in progress |
| gates, push, pull request | as a work run; the push is a fast-forward and the open pull request is found, not duplicated |
| review | reviews the new diff, and its comment decides the gate as the newest one |

**A failed review keeps the claim.** The run that stops on a review no longer passes the claim
back. The claim is what points the next run at the pull request, and it is what the target
repository sees as "somebody is on this". Only the worktree goes, and the unfinished work is
committed to the branch before it does.

**The rework takes the claim over rather than inheriting it.** The ref is what excludes a second
runner — a claim that is only extended is a claim two runners both believe is theirs. So the
rework deletes the ref and claims again under a new nonce, the way the reclaim does, with the one
difference that the branch is kept: it carries the work the review judged. A claim left resting for
a week is therefore not a hole: two hosts that pick the same failed issue up cannot both work it.

**A failed review is worked before the rest of the queue.** Among the claimed issues, and among the
queue's, the ones whose pull request carries a failed review come first — still oldest-first inside
each group. The work is further along than any other: the branch is pushed, the pull request is
open, and the findings are already written down.

**The queue reads the open pull requests once.** An issue can be back in the queue — the claim
released by an older runner, or taken off by a human — while its pull request still carries a failed
review. The selection reads every open pull request in one call, matched to the queue by branch, the
same read the claimed issues already pay for. It finds the issues whose review failed, plans the
rework for them rather than a fresh run, and puts them in front of the rest.

## Rationale

**Why the verdict and not "there is a review".** A review that passed is the end of the run; a
review that failed is work. Both have a marked comment on the pull request, so the comment's
existence cannot tell them apart, and a runner that treated them alike would work every passed
pull request a second time.

**Why it is asked before the claim.** The states a claim can be in (`Claimed`, `Pushed`, `Opened`,
`Reviewed`, `Counted`) all answer "how far did this run get". A failed review answers a different
question — "is this work done" — and its answer does not change when the claim is released.

**Why the claim is kept.** The release exists so a claim nobody is working does not hold an issue
out of the queue. A failed review is different: the issue is not available to work again from
scratch, it is available to *continue*, and the claim is the only thing that says which pull
request "continue" means. The staleness window still takes it over if the runner dies.

**Why the review travels verbatim.** `fixPrompt` already gives a fix turn the findings verbatim
rather than a summary, for the same reason: a summary is a second reading by somebody who did not
review the diff. The rework reads the review as the runner posted it.

**Why the remote branch is where a missing local branch starts.** A retry on a host whose checkout
never had the branch made it from the base, wrote the change a second time, and was refused by the
push. The work a previous run pushed is the work this run continues, and it is on the remote.

**Why the re-review is not a second review of one diff.** The contract says the runner reviews
once, because a `pass` after a `fail` on the *same* diff would turn a red pull request green
without the change moving. A rework moves the diff before it reviews, so the newest comment judges
a change that was not judged before, which is what the re-review is for.

## Consequences

- An issue whose review failed is worked again until a review passes, and it is worked before the
  rest of the queue each time. What stops it is the label `ready-for-agent` coming off, or the issue
  closing — the same lever as any other queue work.
- The selection pays one `gh pr list` per run that takes the queue, for the open pull requests it
  matches by branch. A claimed run already paid for that read; a queue run did not.
- The rework is a full run of the graph, not a fix turn: the triage, the scope and the four turns
  run against the branch. A triage that decides the issue is already done still closes it, and that
  is said in the comment the run leaves.
- The rework's diff is against the base the claim recorded. A branch that is older than the base
  may need the merge mode's rebase before it lands; the rework itself does not rebase.
- A pull request whose review failed now makes its issue `Failed` — one more state to know when
  reading a run's own record.
- `ReviewStatedNoVerdict` leaves no marked comment, so its issue derives `Opened` and is reviewed
  again rather than reworked. That is intended: the review is what is missing there.

## Links

- `src/runner.ts` — `deriveState`, `planFor`, `chooseIssue`, `prepareWorktree`, and the release
  path that keeps the claim.
- `src/session.ts` — `REWORK_SECTION`, `reworkData`, and `startAgent`'s `rework` option.
- `src/gh.ts` — `newestReviewComment` and `newestReviewVerdict`.
- `docs/lifecycle.md` — the whole life of an issue, state by state.
- `docs/decisions/2026-11-02-a-run-that-did-not-finish-leaves-its-work.md` — the branch a failed
  run leaves.
- `docs/decisions/2026-10-30-a-failed-runs-branch-is-continued.md` — the branch a retry continues.
- `contract/afk-runner.md` — the review's marker and verdict, and "the runner reviews once".
