---
title: The engine tells the model when a turn ends on a tool
status: accepted
date: 2026-11-05
authors: MiniMax Code
deciders: Singularity Developer
tags: [review, verdict, session, engine]
---

# The engine tells the model when a turn ends on a tool

## Context

The second turn
([2026-11-05-a-review-that-stated-no-verdict-gets-a-second-turn](2026-11-05-a-review-that-stated-no-verdict-gets-a-second-turn.md))
did not fix the review of pull request #1804: the run still ended with
`the review of pull request 1808 stated no verdict`, and the second turn came back with
nothing at all.

A spike that repeated the review outside the runner showed what was happening. The review
session's own answer:

```
FINISH: tool-calls
STEPS: 40
TOOLS: mastra_workspace_execute_command, mastra_workspace_execute_command, … (60 calls)
TEXT: I'll start by understanding the repository and the PR.
HOLDER: {}
```

The reviewer did not stop. It found something else to read, and then something else again, for
forty steps, until the engine's step limit ended the turn. The turn ended with tool calls
outstanding, and the verdict tool was never among them.

**The model was not asked to end.** The review prompt says the verdict tool is the last
action, and the tool's own description says the same — but a prompt is what the model reads
*before* it starts reading. Forty steps later, the model has read the diff, the code, the
tests and a good deal of the repository, and the sentence that told it to stop is a sentence
from a long way back.

## Idea

The engine pushes the model between its own steps: after a turn has taken enough steps to
have read what it needed, the engine says, in the conversation itself, that the turn ends
with a tool — and names the tool.

## Decision

**A session may name the tool its turn ends on.** `SessionFactory` takes `finalTool`: the
tool the turn must end on. The review session is given the verdict tool; a turn that decides
nothing has no final tool, and is left alone.

**The engine says it between the steps.** Mastra's `onIterationComplete` runs after every
iteration of a turn, with the calls that iteration made. After
`FINAL_TOOL_AFTER_STEPS` (eight) steps, the engine adds one message to the conversation:
*you have read enough, call the tool now, with the verdict you reached and the findings you
found*. The message goes to the model as part of its next step — it is not a prompt, and it
is not a new turn.

**The engine says it once.** The engine remembers that the final tool was called: a turn that
already ended on it gets no reminder, and a turn that did not gets the reminder on every
step past the eighth, until the model calls the tool.

**The step limit is a ceiling, not a plan.** The session's own limit is `MAX_STEPS` (40),
above Mastra's default of five. A review of a real diff needs more than five steps, and the
default ends such a turn with nothing decided.

## Rationale

**Why the engine, and not the prompt.** The prompt is read once, at the start of a turn that
lasts forty steps. The engine's step hook is the only place that is *inside* the turn. A
reminder that arrives while the model is still exploring is a reminder the model acts on; a
reminder that was sent forty steps ago is a rule it has already moved past.

**Why eight steps.** Measured, not guessed: the same review with the reminder after the
eighth step called the verdict tool on the ninth, having read the diff, the code and the
tests. The number is the engine's, and the runner does not name it — the runner names the
tool, and the engine knows how to push a model.

**Why the tool is named.** The reminder says *stop exploring*; the model that does not know
which call ends the turn has to guess it. Naming the tool makes the reminder an instruction
rather than a hint.

**Why this and not a shorter turn.** The review's own value is that it reads: the whole
diff, the code it touches, the tests. Capping the steps lower would make the review a
guess — the runner could not tell a reviewer that read everything and found nothing from a
reviewer that read a little and stopped.

**Why the run's own second turn still stands.** The second turn is the fallback for a
reviewer that ends its turn in prose. The engine's reminder is what makes the first turn
end on the tool. The two are not alternatives: the reminder makes the common case work, and
the second turn catches the case where the model ignored it.

## Consequences

- A review session tells the model, after eight steps, that the turn ends on the verdict
  tool. The review of #1808 now reaches a verdict on the ninth step.
- `SessionFactory` grew one field (`finalTool`), and the Mastra session one constant
  (`FINAL_TOOL_AFTER_STEPS`).
- The session's step limit is the runner's own (40) instead of Mastra's default (5).
- A turn with no final tool is unchanged: the engine says nothing, and the turn ends when
  the model ends it.
- The engine's step hook is Mastra's, so the nudge is Mastra's. Another engine that can push
  a model between its steps implements the same seam; one that cannot leaves the turn to the
  prompt.

## Links

- `src/mastra/session.ts` — the step limit, the step hook, and the reminder it adds.
- `src/session.ts` — `finalTool` on the session factory, the seam the runner drives.
- `src/runner.ts` — the review session names the verdict tool.
- `2026-11-05-a-review-that-stated-no-verdict-gets-a-second-turn.md` — the fallback for a
  reviewer that still ends in prose.
- `2026-11-05-pi-is-gone.md` — the session is the seam; the engine underneath it is not.
