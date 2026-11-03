---
title: The issue travels with the turn
status: accepted
date: 2026-11-08
authors: MiniMax Code
deciders: Singularity Developer
tags: [session, workflow, intake]
---

# The issue travels with the turn

## Context

A work session's turns read the issue: the triage judges it, the scope checks it, the
four work turns work on it. The issue reached the session as **two turns of its own** —
`issue-body` and `issue-comments` — that carried the body and the comments as fenced,
untrusted data, ahead of the instructions.

Two things were wrong with that.

The first was the cost. A turn that carries nothing but the issue is a turn the model
spends on reading the repository instead of on the work, and the model spent tool calls
on it: the agents that ran the queue asked for the issue's description instead of reading
it, because a turn that says "here is an issue" is a turn that invites "where is it?". The
work session's graph also carried the intake as its own sub-workflow
(`work-session-intake`), which is a second thing to build, compose and test for what is
one delivery.

The second was the position of the data. The issue arrived in the **oldest** messages of
the conversation, and the session's memory drops the oldest messages first. The issue was
therefore the first thing a long conversation forgot — and by the time the implement turn
ran, the model had a brief it could not see. The agents that said "the issue body isn't in
my context" were right, and the runner had put them there.

The fix/review sessions never had this problem: they hand the brief to their own prompt
as data (`briefFence`, `src/runner.ts`), in the turn that needs it, and the work session
is the odd one out.

## Idea

Deliver the issue's body and its comments as **data in the prompt of the turn that reads
them**.

## Decision

**The issue's data rides with the first turn, above its instruction.** The work session's
nodes carry a block "## The issue, as data" — the body and the comments, fenced and
labelled untrusted — above the first turn's prompt. The instruction is last: the
instruction the model reads last is the instruction, and the data above it reads as what
the issue says rather than as what the model is told to do. The system prompt is
unchanged: the rule that says untrusted text is data and never instructions stays where
untrusted text cannot reach it.

**The intake is gone.** There is no `issue-body` turn, no `issue-comments` turn, no
`work-session-intake` sub-workflow, and no `counts: false` turn node: the issue's data is
not a turn, so there is nothing to count and nothing to compose. The optional
related-issues turn is an ordinary turn of the script, before the triage.

**The data arrives once.** The brief is read once, in the first turn, and the rest of the
session works from what the model already has.

## Rationale

**Why the prompt of the turn, and not the system prompt.** Untrusted text in a system
message is executed more readily than untrusted text in a user message, and the issue
body is written by whoever opened the issue. The rule about untrusted input has to stay
in the system prompt, and the data has to stay in a user message — and the prompt of the
turn is a user message. The fix and review sessions already work this way; the work
session now works the same way.

**Why above the instruction.** The instruction the model reads last is the instruction.
Data below it would end the turn with the issue's own words as the last thing the model
read, and the issue's words are the untrusted ones.

**Why once.** The brief is read once, in the turn that reads it. Every later turn has it
in the conversation.

**Why the intake goes rather than stays.** A turn that carries only data is a turn that
counts against the deadline and spends the model's step budget on reading. The graph
loses a node, a sub-workflow and a test, and gains nothing for it.

## Consequences

- **The graph is smaller.** `work-session-intake` is gone, `GRAPH_NAMES` (which existed
  only to tell the intake apart) is gone, and the intake's turn nodes are gone. The
  related turn is a step of the work session's script, not a sub-workflow of its own.
- **`workSessionNodes` takes the issue, not its parts.** The options `issueBody` and
  `issueComments` are gone; the session hands the whole `IssueDetail` over, and
  `issueData` builds the block. One place builds the block, and one place fences the
  text.
- **The prompts are unchanged.** They already said that the issue's body and its
  comments arrive above as data, and they now do.
- **The turns the run counts go down by the intake's turns.** The work session counts
  six turns, as the prompts do.

## Links

- `src/session.ts` — `issueData`, and the work session's nodes.
- `src/workflow/work-session.ts` — the script, without the intake.
- `src/runner.ts` — the fix and review sessions, which already delivered the brief as
  data in their own prompt.
- `docs/decisions/2026-11-08-the-session-keeps-its-memory.md` — the other half: the
  memory that keeps what the first turn read.
- `docs/decisions/2026-11-06-the-graph-runs-on-the-mastra-workflow-engine.md` — the
  record whose intake clause this replaces.
- `contract/afk-runner.md` — the guarantee that does not change: the runner hands the
  body and the comments to the agent and says in the system prompt which of them is the
  contract.
