---
title: The implement turn says where the work has to stay too
status: accepted
date: 2026-11-02
authors: MiniMax Code
deciders: Singularity Developer
tags: [runner, prompt, session, stash, worktree, git]
---

# The implement turn says where the work has to stay too

## Context

`2026-11-02-the-work-is-the-tree-and-not-the-stash.md` settled where the work
is: the tree is the work's, the run keeps the tree and commits it on the
branch, and a stash is not part of what the next run continues.

It settled it for the verify turn. The turn that actually writes the change —
the implement turn, where the agent makes the change and runs the gates — said
only that the runner commits whatever is left in the worktree. It never said
that the work has to stay in the tree while the turn runs, and it never
mentioned the stash.

An agent that stashes its change to get a clean tree for a gate therefore
leaves an empty tree behind: the run commits the empty tree, and the change
sits in the repository's own stash, where nothing says which entry is whose
and the runner never looks.

The tree is the only place the run looks, so the turn that writes the work is
the turn where the rule matters most.

## Idea

The rule belongs in the turn that writes the work, in that turn's own words,
at the point where the agent is about to change files: the work is the tree's,
the run keeps the tree, and a stash is not part of what the next run continues.

The two turns must not drift into different claims about the same thing, so
the wording says the same things in the same terms.

## Decision

**The implement turn says that the work is the tree's.**
`src/prompts/02-implement.md` tells the agent, next to what it already says
about the runner committing the tree, that the work stays in the tree while
the turn runs, and that a stash is not part of what the next run continues.

**The implement turn keeps the rules it has.** The runner commits the tree, and
the agent does not commit or push itself.

**The verify turn's wording does not change.** It already says what this asks
for.

**The runner's behaviour does not change.** It keeps the tree and does not read
the repository's stash.

## Rationale

**Why the prompt and not the runner.** As in the decision this extends: a stash
belongs to the repository rather than to an issue, and nothing says which entry
is whose, so the runner cannot continue one — and does not try to.

**Why the implement turn and not only the verify turn.** The verify turn sees
the work already made; by then a stash has already lost it. The turn that
writes the change is the last point at which the agent can be told where the
work has to be.

**Why a stash of the agent's own is still allowed.** The rule is about where
the *work* is. An agent may take a measurement with a stash, or park something
for a moment, as long as the work it is making is in the tree.

**Why the wording is the same rule, not the same sentence.** The two turns
read differently to an agent in them, and each says it where the agent reads
it — but neither may claim something the other does not.

## Consequences

- The implement turn tells the agent where the work has to stay while the turn
  runs.
- An agent that stashes its change anyway leaves an empty tree; the run keeps
  the empty tree, and the stash stays in the repository, unread.
- The verify turn keeps its wording, and the two turns say the same thing.
- The runner is unchanged.

## Links

- `src/prompts/02-implement.md` — the turn that says it.
- `src/prompts/03-verify.md` — the turn that already said it.
- `test/runner.test.ts` — the implement turn's rule.
- `docs/decisions/2026-11-02-the-work-is-the-tree-and-not-the-stash.md` — the
  rule this extends to the turn that writes the work.
