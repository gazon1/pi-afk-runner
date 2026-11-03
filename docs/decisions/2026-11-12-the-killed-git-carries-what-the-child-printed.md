---
title: The killed git's failure carries what the child printed
status: accepted
date: 2026-11-12
authors: MiniMax Code
deciders: Singularity Developer
tags: [git, timeouts, bound]
---

# The killed git's failure carries what the child printed

## Context

A `git` that is killed at the bound raises `CommandTimedOut`. That failure is the record of a
hung `git`, and it was built in two ways.

When the child obeyed the request to stop, the failure carried what the child had printed:
simple-git hands over what it collected when the call ends. When the child ignored the request,
the run stopped waiting at the hard stop and the failure was built with empty output — the
same failure class, empty. Nothing said which of the two endings had happened, and the record
of a hung `git` held no evidence at all.

The bound itself is one rule — see
[2026-11-05-the-bound-is-one-rule.md](2026-11-05-the-bound-is-one-rule.md) — and the `git` runs
through simple-git — see
[2026-11-05-the-git-runs-through-simple-git.md](2026-11-05-the-git-runs-through-simple-git.md).
What was missing was what the failure says.

## Idea

The failure says both things: what the child printed, or plainly that it printed nothing, and
which of the two endings it was — the child that was stopped, or the child that ignored the
request and was left behind.

## Decision

**`CommandTimedOut` carries the ending and says the output in its own message.** The ending is
`"stopped"` or `"ignored"`, and the message names the command, the bound, the ending and the
printed output — the text when there is any, and plainly that there is none when there is not.

**The ending and the wording live in `src/bound.ts`, beside the rule.** The two endings are the
bound's own, and the words that say them — and the words that say what the child printed — are
written once there, so that the failure for `git` and the failure for `gh` say the same thing in
the same words.

**The output of a `git` that ignores the request is read while the child is still there.**
simple-git keeps the child's output in buffers it hands over when the call ends, and a call that
ignores the request never ends. The runner therefore reads the child's own streams through
simple-git's output handler (`outputHandler(command, stdout, stderr, args)`), keeps them, and
builds the hard-stop failure from what it read.

## Rationale

The output is the only evidence there is, so it belongs in the failure's own words: a reader of
a record reads the message, and a message that says nothing about the output is a record with no
evidence in it. A child that printed nothing says so plainly, so that an empty failure is read
as an empty child and not as a lost one.

The two endings are told apart because they are two different facts about the host: a child that
stopped is gone, and a child that ignored the request is still running there.

Reading the child's streams through the output handler is the only way to have the output of a
child that never answers. The library that ran the child hands its output over when the call
ends, and this call does not end.

## Consequences

The failure of a killed `git` names the command, the bound, the ending and the printed output.

A `git` that is left behind now says so in the failure that reports it. What happens to that
child on the host is a separate question, and this decision does not answer it.

The `gh` path asks the same question and is not touched here.

## Links

- `src/git.ts` — `CommandTimedOut`, `gitFailure`, `runGitWithTimeout`
- `src/bound.ts` — `withHardStop`, the rule the two paths share, and the wording of the two
  endings
- [2026-11-05-the-bound-is-one-rule.md](2026-11-05-the-bound-is-one-rule.md)
- [2026-11-05-the-git-runs-through-simple-git.md](2026-11-05-the-git-runs-through-simple-git.md)
