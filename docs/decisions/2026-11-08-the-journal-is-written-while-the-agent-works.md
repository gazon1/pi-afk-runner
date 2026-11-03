---
title: The journal is written while the agent works
status: accepted
date: 2026-11-08
authors: MiniMax Code
deciders: Singularity Developer
tags: [journal, session, engine, observability]
---

# The journal is written while the agent works

## Context

A run of issue 1812 (2026-11-03) looked hung. The terminal printed thirty-odd tool calls and
then nothing for the better part of an hour; there was no new line, and no log file to look
at either.

The process was alive and not stuck in the runner. It was inside **one** tool call:

```
sh -c cd …/afk-worktrees/issue-1812 && HOME=/home/max timeout 3000 python3 -m unittest discover -s scripts/tests
```

The agent had decided to run the target's own Python test suite with a fifty-minute timeout,
and it did — the suite drags in the detekt governance scripts and an emulator module, and it
ran for many minutes. The runner's own gate runner never starts a shell with a `timeout`
wrapper, so this was the agent's own choice, made inside the workspace's `execute_command`.

Two things made it look like a hang rather than like a long call. The **journal** is written
when the turn ends: `logTurn` runs after `agent.generate` resolves, and Mastra answers with
the whole turn at once, so a turn that is inside a tool call has written nothing. And the
**artifacts** are written at the boundaries too: the record in `build/diagnostics/issue-<n>/`
appears when a step ends, and the gates log appears when the runner runs gates — and this run
had no gates, so there was no gates log to miss.

## Idea

The journal says what the agent is doing **while it is doing it**. A call that takes an hour
is still a call, and a reader has to be able to tell the two apart.

## Decision

**The engine hands each tool call over as the model makes it.** Mastra's `generate` reports a
`tool-call` chunk when the model asks for the call and **before** the tool runs — the tool's
answer comes later, as a `tool-result`. The session writes that chunk to the journal at once.

**The turn that ends writes only what the engine did not hand over.** The calls are written
once: the session remembers the calls it has written (`toolCallId`), and `logTurn` skips them.
A call the engine never handed over — a turn that failed before the chunks came — is still
written when the turn ends, so nothing is lost.

**The line is spelled once.** `toolCallLine` in `src/mastra/log.ts` writes the line, and both
paths use it: the call that is written while it runs and the call that is written when the
turn ends read the same.

**A refusal is written too.** The guard's refusal comes back as the call's result, and it is
written as its own line (`↳ Refused: …`). A call that was refused is over, and a reader has
to see that it is over — a refused call that is silent looks exactly like a call that runs.

**The record file stays what it is.** `build/diagnostics/issue-<n>/<runId>.md` holds the
*steps* of the run and is written at the boundaries; the journal is the stream of the run. The
live lines make the stream honest — they do not make the record file a log.

**The journal is also a file.** `build/diagnostics/issue-<n>/<runId>.log` is written while the run
works: the file is there before the session starts and grows as the lines come, so a run that is
killed leaves behind what it was doing when it died. The runner's factory is wrapped once, and every
session the run opens — the work session, the review, the fixes — writes to it. The file is a
witness, not a gate: a line that cannot be written is dropped and the run goes on.

## Rationale

**Why the call and not the result.** The result says the call is over; the call says the
agent is inside it. The thing a reader cannot see is the difference between "the run stopped"
and "the run is waiting", and the call is the side that shows the waiting.

**Why a chunk and not a timer.** A heartbeat would keep saying "still here" without saying
what for. The engine already knows the exact thing that is running, and it knows it before
the tool starts — so there is nothing to poll and nothing to guess.

**Why the calls are not written twice.** The journal is one fact per line, and a line that
appears twice reads as two calls. The turn that ends has the full list; the engine has the
same list, earlier; the ids are what says which line has already been written.

## Consequences

- A turn that is inside a long tool call now shows the call in the journal, and a reader can
  see what it is waiting for.
- The end of a turn no longer repeats the calls it made — the journal shows the calls in the
  order they happened, and the turn's own words at the end.
- A run that is killed inside a call still shows the call it was making.
- A refused call shows the refusal, so it does not read as a call that runs.
- The run leaves a journal file beside its record, written while the run worked. A run that is
  killed leaves the file, and the file says what it was doing.
- The guard refuses the test suite itself
  ([2026-11-05-a-run-gates-nothing-and-builds-nothing](2026-11-05-a-run-gates-nothing-and-builds-nothing.md)):
  a suite is a gate, and this run does not gate the tree.

## Links

- `src/mastra/session.ts` — the `onChunk` that writes the call, and the calls it has written.
- `src/mastra/log.ts` — `toolCallLine`, and the turn that writes what is left.
- `src/journal.ts` — `journalFactory`, the wrapped factory that writes the journal file, and how a
  call is spelled.
- `src/runner.ts` — the work run that opens the journal.
- `2026-11-05-a-run-gates-nothing-and-builds-nothing.md` — the run that gates nothing, and the
  guard that refuses a suite.
