# The merge pipeline — its contract

This contract is **this repository's own**. The target's
[`afk-runner.md`](afk-runner.md) describes the **work** pipeline, and that pipeline never merges.
Landing is a second, opt-in mode, and the rules below are what binds it. They live here so the mode
has one place that says what it guarantees, and so the work contract keeps saying what it always
said.

## What it does

`pi-afk-runner --merge` reads the open pull requests against the base (default `main`) and lands
the ones the work pipeline opened. It is separate from `--all`: the work mode never merges, and
this mode never works an issue. The two modes take different host locks — work is per issue, merge
is its own — so a merge runs beside the work runs. What keeps it from landing work in flight is
its candidates: a pull request is landed only once its review and CI have judged it.

It lands with `gh pr merge --squash --delete-branch`.

## A candidate

A pull request is a candidate when all of these hold:

| This repository guarantees | Where |
|---|---|
| its branch is `agent/issue-<N>` — the work pipeline's own | `src/merge.ts` |
| it is not a draft | `gh pr list --json isDraft` |
| its **newest** comment that opens with `<!-- agent-review -->` states `**Verdict:** pass` | `src/gh.ts` |
| it carries `agent-reviewed` | the re-count label |
| the repository's own `scripts/ci-verdict.py` states a successful run — its `exit` is `0` | the target's tool |

Anything else is named and left alone. A skipped pull request is not a failure.

## What the head that lands is

A candidate lands only when this run does not move its branch. The commit that lands is the commit
the review and the CI judged — not one produced while the run was checking. The landing names that
commit (`gh pr merge --match-head-commit <sha>`), so a branch that moves in the window between the
check and the merge is refused by GitHub rather than landed.

A branch that has to move — the base moved under it, a conflict had to be resolved, or the gate
failed — is synced, gated with the repository's own `./check.sh`, pushed and freshly reviewed, and
then **left for the next run**. It lands once CI has judged the new commit. A merge never lands a
commit CI has not seen.

**Immediately before the merge the pull request is read again, and the branch is read again.** A
`fail` posted, or a push made, while the run was working stops the merge: the step fails and the
pull request stays open.

## What it may do

- Merge a candidate, and only a candidate.
- Push `agent/issue-<N>`, and nothing else.
- Run the repository's gate, `./check.sh`, on a branch that moved.
- Write its record under `build/diagnostics/merge/pr-<N>/`.

## What it must never do

- Land a pull request the work pipeline did not open.
- Land a commit whose CI is not green.
- Land a branch this run did not check.
- Work an issue, or open a pull request.
- Push outside `agent/issue-<N>`.
