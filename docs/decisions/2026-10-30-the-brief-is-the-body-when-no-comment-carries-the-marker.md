---
title: The brief is the issue's body when no comment carries the marker
status: accepted
date: 2026-10-30
authors: MiniMax Code
deciders: Singularity Developer
tags: [runner, brief, intake, contract, tolerance]
---

# The brief is the issue's body when no comment carries the marker

## Context

The runner's intake contract says the brief is the **comment** that opens with `## Agent Brief` —
the target repository's own convention, from `.agents/skills/triage/AGENT-BRIEF.md`.

The repository does not follow it. Of the 73 open issues labelled `ready-for-agent`, **not one**
carries a comment with that marker; the briefs are in the **issue bodies**, written in the shape the
triage skill describes but not under its heading. The label was applied by hand, and the brief was
never posted as a comment.

So the contract described a format that does not exist in the repository it binds to, and a runner
that followed it exactly would take an issue, find no contract, and hand an agent an empty task.

## Idea

Read the brief from the body when the marker is absent, and say which one it found.

## Decision

**The brief is the first comment that opens with `## Agent Brief`. When no comment does, the brief
is the issue's body.** An issue with neither — no marker comment and an empty body — is **refused**:
the run fails loudly at the session step instead of handing an agent an issue with nothing in it.

The runner says where the brief is in the **system prompt**, in its own section, next to the
untrusted-input rule. Not in a user turn: the text it talks about is untrusted, and a statement
about untrusted text belongs where untrusted text cannot reach. The first prompt says both shapes
are possible, so an agent that never receives the section can still work out which it has.

The body is fenced as untrusted input whichever of the two it turns out to be — the fence does not
depend on the brief's role.

## Rationale

The alternative is to post 73 briefs as comments. That is the convention the repository's own
triage skill states, and it is the right thing for the *next* issue. But it is 73 human decisions
about issues that were already judged specified enough to work, and the runner cannot make them:
the brief's content is a human's judgement about the work, and the body already carries it.

The marker stays the first choice. The target repository's convention is the contract, and a body
that happens to contain the marker is still only a body — so the runner looks at the comments
first, and only falls back when there is no marker anywhere.

The refusal is the part that matters most. A runner that cannot find the contract must say so
rather than work on something: an agent handed an empty task invents one, and its invention lands
in a pull request on a public repository.

## Consequences

- The runner accepts a brief in either place. The contract document says so, in both the target
  repository and the copy this repository keeps.
- The `ready-for-agent` label no longer implies the marker is present. It implies a human judged
  the issue specified — which is what the triage skill says it means, and is the truer guarantee.
- An issue with an empty body and no marker comment is refused. Such an issue needs a brief, not
  a runner.

## Links

- `src/session.ts` — `findBrief`, the `brief` system prompt section, and the refusal.
- `src/prompts/01-brief.md` — the first prompt says both shapes are possible.
- `contract/afk-runner.md` — the intake contract, in this repository and in the target one.
