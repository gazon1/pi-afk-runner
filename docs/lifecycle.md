# The life of an issue

One issue, from the queue to a landed change. The runner keeps no state of its own: everything this
document says is **derived** from what is visible on GitHub and on the remote — the labels, the
pull request, the review comment, the branch (`src/runner.ts`, `deriveState`).

What derives the state is seven observables:

| | Observable | Question | Where it is read |
|---|---|---|---|
| `L` | `claimLabel` | does the issue carry `agent-in-progress`? | `gh issue list` |
| `P` | `pullRequest` | is there an open pull request from `agent/issue-<N>`? | `gh pr list` |
| `V` | `reviewComment` | does it carry a comment opening with `<!-- agent-review -->`? | `gh pr list --json comments` |
| `W` | `reviewVerdict` | what does the newest of them state — `pass`, `fail`, or nothing? | the same read |
| `C` | `recountLabel` | does the pull request carry `agent-reviewed`? | `gh pr list --json labels` |
| `R` | `workBranch` | does `agent/issue-<N>` on the remote carry commits the base does not? | `git ls-remote` |
| `A` | `stale` | is the issue older than `--stale-after-ms` (a week)? | the issue's `updatedAt` |

## The states

| State | Derived when | The run's plan |
|---|---|---|
| `Queue` | no claim label | `work` |
| `Failed` | a pull request with a review whose newest verdict is `fail` — claimed or not | `rework` |
| `Claimed` | claim, no pull request, no work on the branch, fresh | `none` — somebody else is working |
| `Orphaned` | claim, no pull request, no work on the branch, stale | `reclaim` |
| `Pushed` | claim, no pull request, the branch carries work | `pull request` |
| `Opened` | claim, pull request, no marked review | `review` |
| `Reviewed` | claim, pull request, a marked review that is not `fail`, no `agent-reviewed` | `re-count` |
| `Counted` | the same, with `agent-reviewed` | `none` — the runner is done |

`Failed` is asked **before** the claim, and that is the whole point of it: a review that said fail
is work that is not done, and it is worked again whether the claim stayed on the issue or not.

```
                 ┌──────────────────────────── claim kept ────────────────────────────┐
                 │                                                                    │
Queue ──work──► claim ──► worktree ──► session ──► gates ──► push ──► PR ──► review ─┤
  ▲                │                                                                  │
  │                └── skip/split ──► closed                                            │
  │                                                                                    │
  │                              fail / no change / exhausted                           │
  │                                        │                                           │
  │                                        ▼                                           │
  └──── claim released ── Orphaned ◄── Failed ◄─────────────────────────────── fail ────┘
                                     │  ▲
                              rework │  │ pass
                                     ▼  │
                        branch + review ─┴──► Counted ──► (a human merges, or --merge)
```

## What each plan runs

| Plan | Steps |
|---|---|
| `work` | claim → worktree → session → gates → push → pull request → review → re-count |
| `reclaim` | the same, after taking over a stale claim and deleting the branch it left |
| `rework` | the same, with the claim kept (or taken when it is gone), the branch continued, and the failed review as the session's task |
| `pull request` | worktree at the pushed commit → open the pull request → review → re-count |
| `review` | worktree at the pushed commit → review → re-count |
| `re-count` | worktree at the pushed commit → apply `agent-reviewed` (and write the change's verdict file) |
| `none` | nothing; the sweep moves to the next issue |

The **claim** is a label plus a remote ref carrying a nonce. The label is what a human sees and what
moves the issue's clock; the ref is what makes the claim exclusive.

The **worktree** is created from the base the claim recorded, on `agent/issue-<N>`. When the branch
is already on the remote, it starts at the remote's tip: the work a previous run pushed is the work
this run continues. It is scratch — it is removed when the run ends, and the branch keeps the work.

## Every way a run ends

| Where it stops | The claim | The branch | The pull request | The state afterwards |
|---|---|---|---|---|
| **pass** | kept | pushed | this commit reviewed, `agent-reviewed` applied | `Counted` |
| **fail** (a review said fail, or the fix changed nothing, or the deadline ran out in the loop) | **kept** | pushed, with the fix's commits | the fail comment is the newest review | `Failed` → the next run is a rework |
| **no verdict** (the review never called the tool, twice) | kept | pushed | no marked comment was posted | `Opened` → reviewed again |
| **cut off** (a review or a fix that ran into the deadline) | released | pushed | the review that was there, if any | `Queue` (worked again, continuing the branch) or `Failed` (if a fail is the newest review) |
| **stopped by a human** (a signal, after the push) | kept | pushed | as it was | `Opened`, `Reviewed`, `Counted` or `Failed` — the next run picks it up from there |
| **gate refused twice** | released | the work is committed locally | none | `Queue`; nothing was pushed |
| **session cut off** | released (kept if the run was stopped and a pull request exists) | the unfinished work is committed to the branch | — | `Queue` |
| **push or pull request failed** | released | local commits stay | — | `Queue` or `Pushed` |
| **triage: skip** | released | — | — | the issue is closed with the reason |
| **scope: split** | released | — | — | the parent is closed, the pieces are filed with `**Depends on:**` |
| **claim lost the race** | the winner's | — | — | the label is left alone; the run stops |
| **killed outright** | left behind, and stale after a week | kept on the remote | — | `Orphaned` → the reclaim takes it over and deletes the branch |

A run that does not pass the review leaves the finding on the issue as a comment, so a person — and
the next run, which reads the issue's comments as data — can see what was wrong.

## The review loop

One run reviews until it passes or the attempts run out (`src/workflow/review-gate.ts`):

1. **Review.** A fresh session reads the diff against the brief and ends on the verdict tool. Pass
   → the run is done. Fail → the findings are quoted on the pull request, `agent-reviewed` is
   applied, and the loop takes a fix turn.
2. **Fix.** A fresh session, given the findings verbatim, changes the tree; the runner commits,
   runs the gates, and pushes. A fix that leaves the head where it was stops the loop (`no
   change`). A gate that refuses the fix stops the run.
3. **Again.** The new diff is reviewed from the top, up to four reviews in one run.

A review that states no verdict gets a second turn in the same session; the first verdict stands if
there is one.

## The rework

The one plan that is not "go further" and not "start again". It happens when the newest review on
the pull request says `fail`:

- **The claim** is taken over, not inherited: the ref is deleted and claimed again under a new
  nonce, with the branch kept. The ref is what keeps a second runner out, so two hosts cannot both
  rework one issue — while the branch, which carries the work the review judged, stays. The state
  does not depend on the claim being there: a released claim is simply claimed again.
- **The order.** A failed review is worked before the rest — first among the claimed issues, then
  among the queue's, oldest first inside each group. The branch is pushed, the pull request is open,
  and the findings are already written down: it is the work that is furthest along.
- **The worktree** is the branch: what the review judged, plus every commit a later run added.
- **The session** is a full run of the graph, and it is told what it is. The failed review arrives
  as data above the issue, and a system-prompt rule says the branch is the work in progress — so
  the triage does not read it as work that landed, and the implement turn answers the findings
  instead of writing the change again.
- **The review** judges the new diff. The gate reads the newest marked comment, so this review is
  the one that decides.

## What a human can do

| Want | Do | What happens |
|---|---|---|
| stop the runner working an issue | remove `ready-for-agent` | it leaves the queue: both the queue and the claimed read ask for that label |
| hand a claimed issue back to the queue | remove `agent-in-progress` | the claim is gone; a pull request whose review failed still makes it `Failed`, so it is a rework, not a fresh start |
| ask for another attempt | post a comment opening with `<!-- agent-review -->` and stating `**Verdict:** fail` | the newest review decides, and the issue is a rework on the next sweep |
| accept the change | merge the pull request, or run `--merge` | the issue closes when the branch lands |
| stop a run in flight | the stop signal | the claim is released, unless the run had already pushed — then it is kept, with the pull request |

## Known limits

- A failed review is worked again on **every** sweep until a review passes or `ready-for-agent`
  comes off. There is no attempt counter across runs: the counter is per run, and the issue only
  stops when somebody stops it.
- A **passed** review whose claim was released derives `Queue`, so it is worked again from the
  branch rather than counted. The mechanism that would plan a re-count there needs a claim, and a
  claim nobody holds is not one the runner may act on.
- The rework's diff is against the base the claim recorded, and the rework does not rebase. A branch
  that is older than the base waits for the merge mode's rebase before it lands.
- The pull request is never closed by the runner. A work the runner gave up on keeps its pull
  request open, red, with the verdict that stopped it.
