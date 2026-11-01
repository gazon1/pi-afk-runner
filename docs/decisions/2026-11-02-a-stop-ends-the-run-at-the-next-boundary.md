---
title: A stop ends the run at the next boundary, and the door watches one session
status: accepted
date: 2026-11-02
authors: Command Code
deciders: Singularity Developer
tags: [extension, stop, session, review, front-door]
---

# A stop ends the run at the next boundary, and the door watches one session

## Context

The live front door kept **two** session handles and one working flag, and between them they made
`/afk-runner-stop` unreliable in three ways.

**A stop between two of the agent's turns did nothing.** The door set its `stopped` flag only on the
path that aborts a turn, and the prompt array asks that flag before every turn. A stop typed in the
window between two turns therefore left the flag unset: the array read false, sent the next prompt,
and the run went on to its push, its pull request and its review. The human asked to stop and the run
carried on.

**The flag was read by one step only.** `options.stopped` reached the session step and nothing else.
A stop that arrived while the run was pushing, opening the pull request or reviewing it was read by
nobody, and the run finished the steps it had left. "Stop" meant "stop" only while the agent happened
to be in a turn.

**The door watched the wrong session.** A run drives two sessions through the same factory: the work
session and the review session. The door recorded the first as `workSession` and overwrote `session`
with the second. So `working` was set only from the work session's events, the abort reached the work
session — which the prompt array had already disposed of by the time the review started — and the log
mirrored the work session alone, so the reviewer's lines never reached the log the human was watching.

## Idea

Two rules, both of them about the run rather than about the agent:

- **A stop is a flag, and the run asks it everywhere.** The run ends at the next boundary — the next
  turn, the next step — whatever the agent is doing. The turn is cut only when there is one to cut.
- **One session in flight.** The door keeps one handle for the session the run is driving now, and
  everything it knows about the run — whether a turn is running, what the log shows — comes from that
  session's events.

## Decision

**The door sets `stopped` whenever a run is under way.** A turn is cut only when one is running; the
message says which of the two happened, and never claims to have stopped a run it could not reach.

**The flag reaches the step loop.** `runSteps` asks `stopped` before every step, and the step that
would have run does not. A stopped run is a failed run: the record is written and the release path
runs — which releases the claim when the pull request is not open yet, and keeps it when it is, so
the next run resumes at the review.

**One handle for the session in flight.** The door records the session the run is driving now — the
work session first, the review's session after it — and knows whether a turn is running from that
session's `agent_start` and `agent_settled` events. The log is that session's lines. The work
session's transcript is still what `/afk-runner-attach` opens, because that is the session a human
wants to carry on from.

## Rationale

**Why the flag and not the abort.** The abort cuts one turn. A stop that only cuts a turn lets the
run carry on to the steps it has left, which is what a human who typed "stop" did not ask for. The
flag is what the run already asks before every turn; asking it before every step too costs one
comparison and ends the run where a human expects it to end.

**Why the step loop rather than a second path.** The steps own what a failure releases: the claim,
the worktree and the record. A stop that took a path of its own would duplicate that state and drift
from it. Making the stop a failure is what the run already knows how to do.

**Why one session rather than two.** The door's job is to describe the run in flight. Two handles and
a flag that only one of them sets cannot describe it: during the review the door believed the agent
was idle, so it refused a stop and let a human switch into a session while the reviewer was running.
One handle, read from the session's own events, cannot drift from the run.

**Why the work session's transcript stays the one to attach.** The attach opens a chat with the
run's history. The review's session is the reviewer's own, and a human carrying on from it would
carry on from a conversation about somebody else's change.

## Consequences

- A stop ends the run at the next boundary. A run stopped between two steps fails at the step that
  did not run, and the record names it.
- The CLI's interrupted run stops at the next step boundary too, and its exit code is the step the
  run stopped at.
- `/afk-runner-stop` says what it did: the turn was cut, or there was no turn to cut.
- `/afk-runner-attach` refuses while the review is running, because the review is a turn.
- The log shows the session in flight, so the reviewer's lines replace the work session's once the
  review starts.

## Links

- `src/extension.ts` — `liveFrontDoor`: `stop`, `abandon`, `mirror`, and the factory callback.
- `src/runner.ts` — `runSteps` and `RunOptions.stopped`.
- `src/session.ts` — `runPromptArray`, which asks the flag before every turn.
- `test/extension.test.ts` — the door's stop, the session in flight, and the log.
- `test/runner.test.ts` — `test_a_stopped_run_ends_at_the_next_step_boundary` and
  `test_a_stop_between_two_turns_ends_the_run_before_the_push`.
- `docs/decisions/2026-10-31-an-interrupted-run-releases-its-claim.md` — the CLI's stop, which this
  decision extends to the front door.
