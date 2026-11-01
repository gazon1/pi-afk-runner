---
title: The runner reads the whole queue in one call, and every gh call is bounded
status: accepted
date: 2026-11-01
authors: Command Code
deciders: Singularity Developer
tags: [cost, gh, git, selection]
---

# The runner reads the whole queue in one call, and every gh call is bounded

## Context

The runner's selection reads two lists: the queue, and the issues somebody has claimed. The claimed
list is every issue the runner has ever worked — the claim label stays on an issue until the issue
closes, and the issue closes when the pull request lands. For every one of those issues the runner
asked GitHub for the pull request of its branch (`gh pr list --head <branch>`) and the remote for
the branch itself (`git ls-remote`, then two fetches and a `rev-list`).

Two things were wrong with that.

**The cost grew with the history.** A run that had worked two hundred issues asked two hundred
questions before it did any work, and every run after it asked the same questions again: the claim
of an issue nobody is working on any more is still a claim. After a few months of hourly runs that
is hundreds of process spawns per run, and the number only grows.

**The `gh` call had no bound.** The git runner kills a command after fifteen minutes
(`COMMAND_TIMEOUT_MS`); the `gh` runner had none. A `gh` that hung on a black-holed network left
the run in `select` with the host's lock held, and the only way out was killing the process.

## Idea

Read the state of the whole queue at once, and bound every `gh` call the way the git runner bounds
its commands.

## Decision

**The open pull requests are read once, with `gh pr list --json`, and matched by head branch.**
The branch is the runner's own name for the work — `agent/issue-<N>` — so it is what an issue's
pull request is found by.

**The branches that carry work are read once for all the issues.** One `ls-remote --heads` says
which work branches the remote has, one `fetch` brings them down, and one
`for-each-ref --no-merged <base>` says which of them the base does not have — which is the question
`gh pr create` asks, and the one
`2026-10-31-a-branch-with-no-commits-is-not-work.md` decided.

**Every `gh` call is killed after `GH_TIMEOUT_MS`** — the same bound the git runner gives its
commands — and the failure names the command that hung. The bound is the **runner's**, not only the
child's: the run stops waiting at the bound whether the `gh` obeys the kill signal or not.

## Rationale

**Why the pull requests are read once.** The runner's own history is what made the list long, and
the list is not a queue: it is everything the runner has ever touched. Asking about one issue at a
time made the cost of a run a function of the past rather than of the work in front of it. One
read of the open pull requests is one request, whatever the runner has worked.

**Why the branches are read once.** The same argument, for the same reason: `agent/issue-<N>`
branches accumulate, and the question "does this branch carry work" is the same question for all
of them. The comparison is still the count — a branch whose commits the base already has carries
no work — so the semantics do not move; only the number of calls does.

**Why the branch is only asked about when there is no pull request.** The derivation stops at the
pull request: an issue with one is `Opened`, `Reviewed` or `Counted`, and what its branch carries
does not change that. So the branches are compared for the issues that have no pull request, and an
issue the runner worked — whose pull request is open — adds no call of its own and no comparison.

**Why the base is fetched once and not per issue.** The base is what a branch is counted against,
and it is read once for the whole selection — in the same fetch as the branches. The claim reads
the base again, and that read stays: the base may move between the steps, and a claim taken from a
base that has moved is a claim the push cannot fast-forward onto. What the observation no longer
does is fetch the base once per claimed issue, which is what made the cost of a run a function of
the queue's history.

**Why the timeout is the git runner's bound.** The two runners make the same kind of call to the
same kind of network, and one of them was bounded and the other was not. A bound that is fifteen
minutes for `git` and none for `gh` is not a decision; it is an oversight.

**Why the bound is the runner's and not only the child's.** `execFile` asks the child to stop and
then waits for it: a `gh` that ignores the signal keeps the call open, and the run waiting on it,
for as long as it likes — measured, not assumed. The unit's `TimeoutStartSec` is `infinity`, so
systemd is not the backstop any more (`systemd/README.md`), and the runner's own bound is.

**Why the failure names the command.** A run that stops in `select` holds the host's lock, and the
person looking at it has to know which call hung. `gh pr list timed out after 900000ms` says it;
`gh failed (1) and said nothing` does not.

## Consequences

- A run's calls do not grow with the number of issues the runner has ever worked: the pull
  requests are one `gh` call, the branches are one `ls-remote` and one `fetch`, and an issue with
  an open pull request costs neither.
- A `gh` that never exits is killed after fifteen minutes, and the run says which call it was.
  The run stops waiting at the bound whether the `gh` obeys the kill signal or not.
- The output cap of the `gh` call stays at 32 MiB.
- The bulk fetch is a wildcard over the runner's own branches (`refs/heads/agent/*`): one call, a
  command line that does not grow with the queue, and a branch that was deleted between the
  `ls-remote` and the fetch is simply not there. A fetch that named the branches one by one would
  fail on it, and take the whole selection with it.
- The bulk branch read fetches the remote's work branches into a private namespace
  (`refs/afk/work-<pid>-<n>`) and removes them again. A run killed between the fetch and the
  removal leaves them behind — the same as the private refs `fetchCommit` leaves.
- The count of the commits a branch carries is now read with `for-each-ref --no-merged` rather than
  with `git rev-list --count`. The question is the same one; the answer is the same. A branch that
  was deleted between the `ls-remote` and the `fetch` is not fetched, and a branch that is not
  there carries nothing.

## Links

- `src/gh.ts` — `allOpenPullRequestsArgs`, `readAllOpenPullRequests`, `runGhWithTimeout`,
  `GhCommandTimedOut`, `GH_KILL_GRACE_MS`.
- `src/git.ts` — `branchesWithWork`, `COMMAND_TIMEOUT_MS`.
- `src/runner.ts` — `chooseIssue`, `observeIssue`, `pullRequestsByBranch`.
- `test/runner.test.ts` — `test_the_calls_do_not_grow_with_the_issues_the_runner_has_ever_worked`,
  `test_a_gh_that_never_exits_is_killed_at_its_timeout`,
  `test_a_gh_that_ignores_the_kill_signal_does_not_hold_the_run`,
  `test_the_pull_request_of_a_claimed_issue_is_found_by_its_branch`,
  `test_the_work_of_every_branch_is_read_in_one_go`.
- `docs/decisions/2026-10-31-a-branch-with-no-commits-is-not-work.md` — what counts as work on a
  branch.
