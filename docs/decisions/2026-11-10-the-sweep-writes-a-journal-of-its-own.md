---
title: The merge sweep writes a journal of its own
status: accepted
date: 2026-11-10
authors: Command Code
deciders: Singularity Developer
tags: [journal, merge, observability]
---

# The merge sweep writes a journal of its own

## Context

The merge door writes a journal for every pull request it starts, under
`build/diagnostics/merge/pr-<N>/`, beside that pull request's record. The sweep itself wrote
nothing.

A sweep reads the open pull requests, filters them into candidates and the rest, and works the
candidates one at a time. A sweep that is killed between two pull requests — while it reads the
candidates, or after one has landed and before the next has started — left behind only the
directories of the pull requests it had already started. Nothing said which pull requests the
sweep considered, which it left alone and why, or where it stopped.

The per-pull-request journals cannot say it. A pull request the sweep left alone never had a
journal: it was read, it was judged, and it was left. Those decisions are the sweep's, and they
were the ones a reader could not reconstruct from the directories.

## Idea

The sweep writes a journal of its own, in the shape the per-pull-request journal already has, so
a reader who knows how to read one journal reads the other.

## Decision

**The sweep's journal is spelled in the same module as the other journals'.** Its directory is
`build/diagnostics/merge/` — the directory the per-pull-request directories are in — and its header
names the sweep. The sweep is not a *subject*: a subject names a run by its number, and the sweep
has none — it is the run that works on the pull requests. The file's name, its path and the writer
that appends to it are the ones the other journals use.

**The file is there before the candidates are read.** A sweep that dies while it reads them has
written nothing at all, and its death has to be visible.

**The sweep's own lines go in it.** The pull requests it considered, the ones it left alone and
why, the one it was working on when it died, and how the sweep ended.

**The sessions the sweep opens write to it too.** The session factory is wrapped with
`journalFactory`, the way the per-pull-request merge wraps it. A wrapped journal keeps the
listener it already had, so the sweep's file and the pull request's own file both hold the lines
of the session they share.

## Rationale

**Why the sweep's own file and not a line in each pull request's journal.** A pull request the
sweep never started has no journal to hold a line, and the sweep's own decisions — read this one,
left that one alone — are not about any single pull request.

**Why the file is there from the start.** The journal is a witness: it says what the run was
doing when it died. A file written when the sweep ends says nothing about a sweep that was
killed, and the sweep is the part of the merge door that dies — it works for hours, over a
budget, while the pull requests it starts each have their own record.

**Why a wrapped journal keeps its listener.** The sweep opens the pull request's sessions, and
the lines of one session belong in both files. A wrapper that replaced the listener would put
them in the inner file only, and the sweep's file would hold nothing but its own lines — not
the shape of the other journals, which the brief asks for.

## Consequences

- `build/diagnostics/merge/` holds one journal file per sweep run, beside the `pr-<N>`
  directories.
- The journal's module spells the sweep's file too, and a subject still names a run by its
  number: the sweep has no number, so it is not a subject, and the record is unchanged.
- The merge contract says the sweep writes this file (`contract/merge.md`).

## Links

- `src/journal.ts` — the subject's kinds, the file's shape, and the writer that drops a line it
  cannot write.
- `src/merge.ts` — the sweep's journal, and the lines the sweep writes.
- `test/merge.test.ts` — the sweep's journal, its lines, and the file a dead sweep leaves.
- `test/journal.test.ts` — the sweep's directory and header, and the lines two journals share.
- `contract/merge.md` — what the merge mode may write.
- `2026-11-08-the-journal-is-written-while-the-agent-works.md` — the journal the merge door
  already kept.
