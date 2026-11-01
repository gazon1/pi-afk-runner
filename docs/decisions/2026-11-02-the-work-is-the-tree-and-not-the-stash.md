---
title: The work is the tree, and a stash is not work the next run continues
status: accepted
date: 2026-11-02
authors: MiniMax Code
deciders: Singularity Developer
tags: [runner, prompt, session, stash, worktree, git]
---

# The work is the tree, and a stash is not work the next run continues

## Context

A run keeps the work that is in the worktree: what the agent left in the tree
is committed on the branch, and the next run continues that branch
(`2026-11-02-a-run-that-did-not-finish-leaves-its-work.md`).

A stash is not the tree. It lives in the repository's own `refs/stash`, it is
not part of any branch, and the next run's worktree does not carry it.

This was not hypothetical. A run that wanted to know whether the failures it
saw were the base branch's stashed its changes, ran the suite again on a clean
tree, and was cut off by the deadline before it could unstash. The work
survived — in a place the next run does not read. The decision above had
closed the gap of uncommitted files in the tree; it had not closed the gap of
work the agent had taken out of the tree.

## Idea

The run cannot continue a stash: a stash belongs to the repository rather than
to an issue, and nothing says which entry is whose. So the agent does not put
the work it is making into a stash. The tree is where the work is, and the run
keeps the tree.

## Decision

**The verify turn says that the work is the tree's.** `src/prompts/03-verify.md`
tells the agent what the run keeps — the tree, committed on the branch — and
that a stash is not part of what the next run continues.

**The rule about a long suite on a stashed tree stays.** The verify turn still
says that a failure the base branch already has is named, not re-run into.

**The runner does not read, move or delete the repository's stash.** It never
did, and it does not now: the stash is the repository's, and the runner's
business is the tree and the branch.

## Rationale

**Why the prompt and not the runner.** The runner could look for a stash and
apply it — and it would have nothing to go on. A stash entry carries a
message and a date, not the issue it belongs to; a repository's stash is the
repository's, and a run that picked one entry out of it would be guessing.
Which entries a run may touch is not a question the runner can answer, so the
answer is that it does not touch them.

**Why the agent may keep a stash of its own.** A stash is scratch: the agent
may take a measurement with one, or park something for a moment. The rule is
about where the *work* is. An agent that stashes its work and leaves an empty
tree has put the work where the run cannot reach it, and the run keeps an
empty tree.

**Why the tree and not the branch.** The branch carries what has been
committed; the tree carries what has not. The run commits the tree before the
worktree goes, so the tree is enough — and the tree is the one place the work
is unambiguous.

**Why this is not a change to the runner.** The runner's behaviour is already
right: it keeps the tree and it does not read the stash. What was missing was
the agent's side of the same rule.

## Consequences

- The verify turn tells the agent where the work is, and that a stash is not
  where the next run looks.
- An agent that stashes its work anyway leaves an empty tree; the run keeps
  the empty tree, and the stash stays in the repository, unread.
- The repository's stash is the repository's: the runner does not read it, move
  it or drop it.
- A stash made by an agent for its own reasons is left alone.

## Links

- `src/prompts/03-verify.md` — the turn that says it.
- `src/runner.ts` — `preserveUnfinishedWork`, which keeps the tree and not the
  stash.
- `test/runner.test.ts` — the prompt's rule, and the runner leaving the
  repository's stash alone.
- `docs/decisions/2026-11-02-a-run-that-did-not-finish-leaves-its-work.md` —
  the run that did not finish keeps its work on the branch.
