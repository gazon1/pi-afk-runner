---
title: A cut run's record says which build wrote it, why it was cut, and how far it got
status: accepted
date: 2026-11-02
authors: MiniMax Code
deciders: Singularity Developer
tags: [runner, diagnostics, record, session]
---

# A cut run's record says which build wrote it, why it was cut, and how far it got

## Context

A run of issue 171 in the target repository left a record that said:

```
- session — failed — the agent's session was cut off before its last turn
```

Nothing in it said whether the clock or a human stopped the run, which turn it
was in, or which runner wrote the line. Answering those questions meant reading
the session's own log and the file's modification time — and the log is not
part of the record.

The reason was fixed first: `cutReason` and `cutOffMessage` made the record say
"hit its 120-minute deadline" or "was cut off before its last turn". Two gaps
remained: the record did not say how far the session got, and it did not say
which build wrote it. The second is what made that incident confusing: the run
had started before the fix that would have named the deadline was merged, and
the record could not show that an older binary wrote it.

## Idea

The record is the thing a reader has when the process is gone. Everything about
the run that a reader needs to answer "what happened" belongs in it, and every
piece of it is cheap at write time.

## Decision

**A cut-off message says how far the session got.** The work session's record
reads "the agent's session hit its 120-minute deadline after 4 of 6 turns"; a
human's stop reads the same, with "(4 of 6 turns done)". A session of one turn —
a review, a fix, a merge resolution — says nothing about turns: the last turn is
the only turn there was.

**The record names the runner that wrote it.** Its header carries
`- runner: <package version> <build sha>`. The version is read from the package
beside the module; the commit is written to `dist/build-info.json` by the build.

## Rationale

**Why the count and not the state's name.** The states stay named, and the count comes from the workflow's
own `completed` list and works for every session shape, including the branched
work session; naming the state would be a second source of truth about the
graph. The reader's question — did it get past the implementation? — is
answered by "4 of 6" and the prompt files' order.

**Why the build, not the version alone.** `package.json`'s version changes when
somebody releases; a stale `dist/` keeps the same version. The commit is what a
reader needs when a record's wording does not match the code they are reading —
the incident that prompted this.

**Why the stamp is not in `src/version.ts`.** That module answers the Pi
compatibility question and is about a different version. The record's stamp is
read where the record is rendered.

## Consequences

- A cut run's record says the reason, the progress and the build: a reader no
  longer needs the session log or the file's modification time.
- A record written by a build without the stamp — a run from `src/` — says the
  version alone. The tests run from `src/`; a published package runs from
  `dist/` and carries the commit.
- Every record gains one line; nothing parses the old header.

## Links

- `src/session.ts` — `cutOffMessage`, and `PromptArrayResult.completed/total`.
- `src/runner.ts` — `RUNNER_STAMP`, and the `- runner:` line in the record.
- `scripts/build-info.mjs` — the build stamp.
- `docs/decisions/2026-11-02-a-run-that-did-not-finish-leaves-its-work.md` — what
  a failed run leaves behind, which is the other half of the incident.
- `docs/decisions/2026-11-02-the-session-is-a-workflow.md` — the states stay
  named; the record uses the count, not the state's name.
