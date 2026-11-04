---
title: The reminder says the same thing in different words
status: accepted
date: 2026-11-14
authors: Command Code
deciders: Singularity Developer
tags: [session, engine, model]
---

# The reminder says the same thing in different words

## Context

The acceptance run of the reasoning fix showed the reminder as it is. The review's turn read for
a long time, and the engine told it, on every step past the eighth, the same sentence — six
times, the same words:

> You have read enough. Stop exploring and call the agent_review_verdict tool now, with the
> verdict you reached and the findings you found.

The model answered the reminder instead of the work:

> The system is repeatedly telling me to stop...
> I keep getting blocked...

It called the verdict tool in the end, but three of its steps went to the argument with the
instrument.

That is the instrument as the decisions left it: the reminder comes on every step past the
threshold, and the same words were said every time
([2026-11-05-the-engine-tells-the-model-when-a-turn-ends-on-a-tool](2026-11-05-the-engine-tells-the-model-when-a-turn-ends-on-a-tool.md),
[2026-11-11-the-engine-tells-the-model-when-a-turn-has-read-enough](2026-11-11-the-engine-tells-the-model-when-a-turn-has-read-enough.md)).
The behaviour — the reminder on every step — was measured then, on one review. The words of the
repeats were never a question.

A reminder that repeats itself reads as a stuck loop, and a model that sees a stuck loop argues
with the loop instead of doing the work. The run above spent three of its steps on that argument.

## Idea

The instrument's behaviour stays; its words change. The same request in different words is a
request the model reads as a request.

## Decision

**The first reminder says it in full; the repeats say it in fewer words.** The engine's own
reminder — the one that names the verdict tool — explains itself once: *you have read enough,
stop exploring and call the tool now, with the verdict you reached and the findings you found*.
The repeats drop the explanation and keep the request: *stop exploring and call the tool now*,
then *call the tool now, with the verdict you reached and the findings you found*, then *call the
tool now*.

**The repeats come round again after the last.** A turn that reads for a long time is told more
than three times, and the words keep coming round rather than running out.

**The session's own feedback carries its repeats with it.** `TurnFeedback` takes the repeats
beside the first words, and `WORK_FEEDBACK` names them: the work session's reminder says the same
thing in fewer words each time it comes round. A feedback that names no repeats is said the same
way every time — the one that says them is the caller.

**The counter of the reminders belongs to the turn.** A turn that starts says the first words
once more, whatever the turn before it said last.

**The behaviour does not change.** The reminder still comes on every step past the threshold;
only the words of the repeats differ.

## Rationale

**Why the words change.** The reminder is not the only message the model reads: the diff, the
code, the tests and the plan are. A message that repeats itself word for word is read as a loop
that is stuck, and the model answers the loop. The same request in different words is read as a
request that is still open, and the model does the work instead.

**Why the repeats come round.** A turn that reads for a long time is told more often than three
times, and a list of words that runs out leaves the turn with the last word repeated — the same
loop in a shorter dress. The words come round, and every telling says the same thing.

**Why the counter belongs to the turn.** The turn is what the counter counts: a turn that starts
has not been reminded yet, and it is told the full words first, so that a turn in a long session
is not reminded in the middle of its work with the shortest words of a turn before it.

**Why the words stay with the one that says them.** The engine's own reminder is the engine's
words, and the session's feedback is the session's words — the work session's reminder points at
the turn's own instruction, and that is the session's business, not the engine's. The engine
carries the repeats of a feedback the way it carries the feedback itself: as the caller's own
words.

**Why the behaviour stays.** The behaviour was measured then and settled: the reminder comes on
every step past the threshold, because a turn that reads forever is cut off by the step limit
otherwise. What the run above showed is that the words were wrong for a repeating reminder — not
that the reminder is wrong. Whether the reminder is said once or on every step is a measurement
that has not been made, and it is asked for in
[#380](https://github.com/gazon1/pi-afk-runner/issues/380).

## Consequences

- A model that reads for a long time is told the same thing in different words, and spends its
  steps on the work instead of on the instrument.
- The reminder still comes on every step past the threshold: a turn that ends on the verdict tool
  is still pushed to it.
- The engine's reminder and the session's feedback have the same shape: the first words and the
  repeats.
- `TurnFeedback` takes one field more, and a feedback that names no repeats keeps the old
  behaviour.
- The counter of the reminders is the turn's, and a turn starts over with the first words.

## Links

- `src/mastra/session.ts` — the reminder of the engine, its repeats and the counter.
- `src/session.ts` — `TurnFeedback` and `WORK_FEEDBACK`.
- `2026-11-05-the-engine-tells-the-model-when-a-turn-ends-on-a-tool.md` — the reminder that names
  the tool, and the threshold of eight steps — **the words clause replaced** here: the repeats say
  the same thing in fewer words.
- `2026-11-11-the-engine-tells-the-model-when-a-turn-has-read-enough.md` — the work session's
  feedback and the threshold of twelve steps — **the words clause replaced** here: the repeats say
  the same thing in fewer words.
- [#380](https://github.com/gazon1/pi-afk-runner/issues/380) — the measurement of the behaviour
  itself.
