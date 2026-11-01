---
title: The fourth turn asks what follows, and the runner files the leftovers
status: accepted
date: 2026-11-02
authors: MiniMax Code
deciders: Singularity Developer
tags: [runner, session, prompt, queue, intake]
---

# The fourth turn asks what follows, and the runner files the leftovers

## Context

A run ended with the agent checking its own work. The array was three turns —
brief, implement, verify — and the third one ended by promising a review that
is the **runner's** separate reviewer, in another session, after the pull
request exists. Nothing in the array looked forward.

But the thing that follows from a change is known to the agent that just made
it: a rule that now lives in two places, a name that no longer says what it
holds, a test that is hard to write, a branch that will have to handle the next
case too. It is written down nowhere, and the next run starts from the same
code.

The target repository already owns the other half of the machinery: its triage
skill writes briefs an agent can work, and the label `ready-for-agent` is what
this runner's queue read picks up. A leftover written as a brief is work; a
leftover written in a run's transcript is a note nobody reads.

## Idea

A fourth turn that asks the question — **what logical steps of improvement and
refactoring follow from what was just done?** — and answers it: the cheap ones
are fixed in the run, with the gates run again, and the rest are filed as
issues in the target repository.

## Decision

**The prompt array has four turns.** The fourth asks the question, fixes what
is cheap, files what is not, and ends with one short report: what it fixed, and
what it filed.

**The cheap ones are fixed in the run.** A leftover is cheap when it is small,
when it stays inside the brief's scope, and when the gates stay green. The
gates run again afterwards: a fix that was not gated is not a fix.

**The runner files the leftovers, through a tool — not the agent's shell.** The
tool holds the bounds: at most three a run, and nothing that is already open
in the repository — which is also what stops the same title being filed twice.
The brief is the issue's body and opens with `## Agent Brief`; the issue
carries `ready-for-agent`, so the queue read finds it and the next run takes
it.

**`gh issue create` is denied in the work session.** A shell command is a way
around the bounds the tool holds, so the guard's own policy refuses it — with
a reason that names the tool.

**The brief goes in the body, not in a comment.** The runner reads a body as
the brief when no comment carries the marker, and one `gh` call files it whole.

## Rationale

The agent could open the issues itself, with `gh issue create` in a shell
command. Nothing would then bound the queue: three leftovers a run is a
promise, and a promise the agent can break with one command is not a promise.
The tool is where the bound lives, so the bound is the runner's and not the
model's good intentions.

The body rather than a comment: the target's triage skill writes briefs as
comments, and that is the convention for an issue a human triaged. But a
comment is a second `gh` call that can fail, and an issue whose body is empty
and whose comment never arrived is an issue the runner **refuses** to work — a
half-filed leftover is worse than none. The body is atomic, and the runner's
contract already says a body is a brief when no comment carries the marker.

The body is also the safer of the two: the body is fenced as untrusted input
and read as data, so a leftover that quotes something odd cannot become an
instruction. A brief in a comment is read as the contract, and the runner
writes briefs.

Fixing everything in the run was the other alternative, and it was rejected:
a run that widens its own scope is a run that is no longer working the brief.
The brief's scope is the boundary, and a leftover that would cross it is a
different piece of work — a filed issue, or a line in the report.

No bound at all is what the queue grows for ever from: every run files what it
noticed, and the next run files what it noticed on top of that. Three is
enough to carry the work forward without turning the queue into a backlog
nobody reads.

## Consequences

- The work session carries a tool; the review session does not. A session that
  used to be told apart by "has tools" is now told apart by the tool's name.
- A run leaves issues in the target repository — the first thing this runner
  writes outside the branch it pushes. The bounds are what make that safe.
- The brief of a filed issue is its body, so the marker is in the body.
- A leftover that is already open is refused rather than filed again, and the
  open issues are read rather than the queue: the queue excludes the claimed
  issues, and an issue another run is working is exactly the one a second copy
  would be filed against.
- **The fourth turn's time comes out of the array's budget.** The deadline is
  one wall-clock for the whole array, so a run that spends it on the first
  three turns never reaches the fourth, and a run that spends it in the fourth
  may reach the pull request without a review. The fourth turn is not a fourth
  of the budget; it is what is left of it. A turn that is cut short fails the
  run where it stands, and a cut turn's changes are never committed.
- The fourth turn changes files, so what it changes is gated like the rest of
  the pull request — the agent runs the gates again, with the commands the
  implementing turn ran. The runner's own gate of whatever a turn changed is a
  separate matter.

## Links

- `src/leftovers.ts` — the tool, the bounds and the brief's shape.
- `src/prompts/04-next.md` — the fourth turn.
- `src/session.ts` — the prompt array, the tool the work session is given, and
  the deadline the whole array shares.
- `src/guard.ts` — the policy that refuses `gh issue create` in the shell.
- `src/gh.ts` — the queue label, the brief's marker, and the reads and writes.
- `contract/AGENT-BRIEF.md` — the brief's format, in this repository and in the
  target one.
- The prompt may only name what exists where the agent runs: this turn names
  the tool the work session carries, and no skill.

