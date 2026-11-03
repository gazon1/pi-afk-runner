---
title: The run's record names the pack
status: accepted
date: 2026-11-09
authors: MiniMax Code
deciders: Singularity Developer
tags: [packing, record, diagnostics, tools]
---

# The run's record names the pack

## Context

The pack was decided on 2026-11-07 and unit-tested, but no run had ever packed a real tree
for a real agent. The pack's own tests pack a temporary worktree and a faked packer, and the
parts that only show up in a real run were unchecked: that the tool is in the runner's tool
set at all, that the document reaches the model, that the agent's own `include` and `ignore`
reach the packer, and that a pack of a real tree fits the budget the runner has.

A run of the runner against issue 275 of this repository — the runner working on its own
repository, with the pack in the work session's tool set — packed this repository. What it
found:

| What was packed | Files | Tokens |
|---|---|---|
| the tree alone (`structureOnly`) | 175 | 2 231 |
| `src/mastra` | 8 | 8 345 |
| `src` | — | refused: 124 760, and the context holds 60 000 |

So the pack is good for **an area of the repository, not the repository**: a directory is a
document the model reads, and this repository's `src` is twice what the context holds. It
costs **the tokens it says**: `src/mastra` is 8 345 tokens of context, and that is what the
agent spent to have the engine's half of the code in front of it in one call. The tree alone
costs 2 231 tokens and says where everything is.

The pack was also checked against the guard's policy, with the guard's own decision
(`isProtectedPath`): **no file in either pack is one the policy refuses.** The check covered
the eight files of `src/mastra` and the repository's whole tree — 178 files, a superset of
what the tree pack held — and the policy refused none of them. The pack holds nothing the
guard would have kept from the agent.

What the run could not say was what it had read. The record named the issue, the steps and
the outcome, and nothing about the pack: a reader could not tell what the run had paid for
the context it read, and the claim that the pack "is of the worktree, and of nothing else"
was made by a decision nobody had exercised.

The agent read the packed document and used it: the engine's adapter drops everything but
the text the model reads, which is why the pack's own details never reached the run. The
pack showed where that was decided.

## Idea

Let the pack report what it holds, and let the record say it.

## Decision

**The pack tool tells the run what it packed.** The tool's own `details` — the path, the
files, the tokens — are what a run can say about a pack, so the tool hands them to the run
through `onPack` when the pack is made. A refusal is not a pack, and is not reported as one.

**The record names every pack the run made.** The work session's and the review's, each with
the session that made it, the path that was packed, the number of files and the number of
tokens. The record is the file a reader is sent to, and a run that read a document cannot say
what it read.

**The pack is checked against the guard's own policy.** The check is the guard's decision and
not a second copy of it: the tool already makes the pack again without the files the policy
refuses, and refuses a pack that still holds one.

## Rationale

**Why the tool reports and the runner does not go and look.** The pack's details are the
pack's own; the engine's adapter drops everything but the text the model reads, and the
runner's record cannot depend on the engine. The tool is the runner's, so the tool says what
it did.

**Why the record names the pack and not the journal.** The journal is the agent's own lines,
and it is the evidence behind the record — but a reader reads the record first, and a run
that cannot say what it read cannot be weighed. The pack is a document the model carried for
the rest of the turn: it is part of what the run cost, and it belongs in the run's account of
itself.

**Why the check is the guard's decision.** The policy's rules live in one place, and a second
copy of them would drift — the same reason the pack applies the policy rather than keeping
its own list of the files nobody hands to an agent.

## Consequences

- The pack tool reports what it packed, and only a pack that was made.
- The record grows a section: a run that packed says so, and a run that did not has no
  section. The record says what happened, not what might have.
- The pack's own promise is now exercised by a run: the tree is the worktree's, the policy's
  files are not in it, and the numbers the tool reports are the numbers the run paid.
- The pack's budget is unchanged. Sixty thousand tokens is still the bound, and the refusal
  still says how to pack less: one directory, or the tree alone.
- The run that packed above was made by a build from before this decision, so its own record
  does not carry the section. A run made with this build names its pack.

## Links

- `src/packing.ts` — the tool, and the details it reports.
- `src/guard.ts` — the policy, and the decision on it.
- `src/runner.ts` — the record, and the two sessions that pack.
- `test/packing.test.ts`, `test/runner.test.ts` — the report, and the record that names it.
- [2026-11-07-the-repository-is-packed-for-the-agent.md](2026-11-07-the-repository-is-packed-for-the-agent.md) —
  the pack itself: the tool, the policy applied to it, and the bound.
