---
title: The engine tells the model when a turn has read enough
status: accepted
date: 2026-11-11
authors: Command Code
deciders: Singularity Developer
tags: [session, engine, work, tree]
---

# The engine tells the model when a turn has read enough

## Context

The run of issue 286 read the repository for twenty steps and changed nothing.

The log of that run shows the turn that implements a change making twenty-one calls — all of them
reads — and ending with the text _I have not yet made the change — the implement turn ended with
reading only_. The runner committed the worktree anyway, and the branch it pushed carried one
file: `.local/state/gh/device-id`, the host's own state, left by a tool the agent ran. The pull
request held no implementation, and the review failed it.

The engine had an instrument for this and the work session did not use it. A turn that ends on a
tool is told, between its steps, that the turn ends there
([2026-11-05-the-engine-tells-the-model-when-a-turn-ends-on-a-tool](2026-11-05-the-engine-tells-the-model-when-a-turn-ends-on-a-tool.md)).
A turn that ends on **nothing** — the turn that implements a change, and the turn that fixes one —
had no such instrument: the model read until the engine's step limit, and the run carried on with
the tree as it was.

## Idea

Two things, in the runner's own words: the engine pushes the model between its steps, in the
session's own words, and the runner checks the tree afterwards — a turn that changed nothing is
given one more chance, and a run that holds no work opens no pull request.

## Decision

**A session may carry a feedback.** `SessionFactory` takes `feedback`: after how many steps the
model is told something, and what it is told. The engine adds it to the conversation between the
steps, the same way the verdict tool's reminder is added — not as a prompt, and not as a new turn.

**The work session's feedback points at the turn's own instruction.** The words are _you have read
enough, do not read any more files, do now what this turn's instruction says: make the change,
call the tool this turn ends on, or say what you found_. They do not name a job. The work
session's turns are not alike — the brief's turn must change nothing, the implement's turn must
change the tree — and a nudge that named one of them would push the wrong turn into editing.
Twelve steps is the number: the triage decides in four calls, the scope in three, and the brief of
the run above reached eleven.

**The turn that implements a change is checked against the tree.** After that turn, the runner
reads the paths that changed against the base. None means the turn changed nothing, and the turn is
given one more chance — in the same session, with the same context, told that the tree is
unchanged. A turn that still changes nothing fails, and the run fails with it.

**The work is the paths that changed, not the commits.** The guard before the push reads the paths
that changed against the base — the branch's own commits, measured from the merge base, and the
tree's own changes on top of them. A commit that carries the host's own state is not the work: the
run of issue 286 made a commit, and the guard let it through.

**The fix's turns carry the same feedback.** The turn that fixes the gates' findings and the turn
that fixes the review's findings are turns that change code, and they are the turns most likely to
read instead.

## Rationale

**Why the engine, and not the prompt.** The prompt is read once, at the start of a turn that lasts
twenty steps. The engine's step hook is the only place that is _inside_ the turn.

**Why the words point at the instruction.** The nudge is one text for six turns. A text that names
the implement's job tells the brief's turn to change the tree — the one turn whose instruction says
it must not — and a plan that is written while the tree changes is not a plan.

**Why one more chance, and not a failure at once.** The turn that changed nothing may have run out
of the turn it was given, not out of the work: the model's own message said it was about to
implement. The second chance costs one turn in a session that already holds the context. A turn
that still changes nothing fails: a second chance that changes nothing is the answer.

**Why the paths and not the commits.** Two questions, two witnesses. The head is the witness for
the review loop — _did the fix move the head_ —
([2026-11-01-a-fix-that-changes-nothing-stops-the-loop](2026-11-01-a-fix-that-changes-nothing-stops-the-loop.md)).
The paths are the witness for the run's work — _is there anything to push_. The run of issue 286
made a commit and the commit was the host's own state; the head moved, and the pull request held
nothing.

**Why git's own rules decide what counts.** An ignored file is the host's business, not the work.
The state a tool leaves behind belongs in the target repository's `.gitignore` — the run of issue
286 added it there — and the runner reads the tree the way git reads it.

## Consequences

- The work session tells the model, after twelve steps, that the reading is over.
- `SessionFactory` grew `feedback`; the Mastra session grew the hook that carries it; the prompt
  array grew `check`, and the retry it gives a turn that changed nothing.
- A run whose tree holds no change fails instead of opening a pull request with nothing in it.
- `git.ts` grew `changedPaths`: the paths that hold the work, against the base.
- The work session's implement turn is the only turn that is checked: the brief's turn changes
  nothing on purpose.
- The digest is derived and could not be regenerated here: `scripts/refresh-decisions-digest.py` is
  not in this checkout.

## Links

- `src/session.ts` — `feedback`, `WORK_FEEDBACK`, the check and the retry.
- `src/mastra/session.ts` — the step hook that carries the words between the steps.
- `src/git.ts` — `changedPaths`.
- `src/runner.ts` — the guard before the push, and the fix's sessions.
- `2026-11-05-the-engine-tells-the-model-when-a-turn-ends-on-a-tool.md` — the same instrument, for
  a turn that ends on a tool.
- `2026-11-01-a-fix-that-changes-nothing-stops-the-loop.md` — the head as the witness, for the
  review loop.
- `2026-11-08-the-session-keeps-its-memory.md` — the session the second chance happens in.
