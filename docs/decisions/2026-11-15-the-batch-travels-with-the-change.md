---
title: The batch travels with the change
status: accepted
date: 2026-11-15
authors: MiniMax Code
deciders: Singularity Developer
tags: [runner, session, review, record, queue]
---

# The batch travels with the change

## Context

A run may work more than one issue. The related turn decides which of the
other open `ready-for-agent` issues belong beside the one in hand, and the
batch is worked as one change.

The batch reached the **plan** and stopped there. The plan was written with
the batched issues' acceptance criteria in hand, and the implementation
followed the plan — so the criteria were in the run, but only in one turn.

Two turns never saw them. The **scope** turn, which decides whether the work
fits one run, ran before the plan and without the batch: it judged the volume
of one issue while the change was several. And the **review** and the **fix**,
the sessions that judge the change and repair it, never saw the batched issues
at all: the promise that the change meets their criteria was made to nobody
and checked by nobody.

And the batch left no trace. The batched issues were never written to — the
issues a run files are linked to each other, and the issues a run *batches*
are not. The record named the issue and the steps, and the batch was in
neither: a reader of the queue saw the issues as unrelated, and a reader of
the record could not say what the change was for.

## Idea

The batch is **one piece of work**, and every turn that judges that work
sees the criteria it is judged against.

## Decision

**The batched briefs reach the scope turn and the plan's turn, read once.**
The runner reads the briefs of the issues the related turn batched — then,
and not before — and hands them above the instruction of the turn that
judges the volume of the change and of the turn that writes the plan. One
read serves both: a brief read twice is a brief read twice.

**The batch travels to the review and to the fix.** The reviewer judges the
whole diff against every issue in the batch, and a fix that answers the
review and breaks another issue's criteria is not a fix. The briefs travel
with the prompts, fenced as untrusted data, exactly as the issue's own brief
travels.

**The record names the batch.** A section of its own: the issues the change
covered, by number and title. The diff alone cannot say what a change was
for.

**The batched issues are linked to the run.** The same `**Related:**` the
leftovers use, in a comment on the batched issue: one spelling of the link,
one meaning. A link that cannot be posted does not fail the run.

## Rationale

The batch is a promise about the change, and a promise that only one turn
knows about is a promise nobody keeps. The review is the turn that says
whether the change does what the issue asked; when the change covers three
issues, the review has to hold it to all three briefs, and it can only do
that if it has them.

The scope turn is the same argument earlier. It answers "does this fit one
run?", and the run it judges is the whole change — the issue in hand and the
batched ones. Judging one issue's volume and then working three is how a
run ends up too big to be one change.

Reading the briefs once is what makes this cheap. The runner already reads
the batched briefs for the plan; the scope turn asks for the same answer, and
a second read of a hundred issues' briefs is a cost the run pays for nothing.

The record and the links are what make the batch visible to a person. The
issues a run *files* are linked to each other, because a reader of the queue
should see that they are one piece of work; the issues a run *batches* are
the same piece of work seen from the other side, and the queue should say so
too.

## Consequences

- The review and the fix judge the change against the batch's criteria, so a
  change that drops one of them is caught instead of shipped.
- The scope turn judges the volume of the whole change, so a batch that does
  not fit one run is split instead of half-worked.
- The briefs are read once, whichever turns ask for them: the run pays for
  the batch once.
- The record names the batch, so a run that worked several issues can be read
  without the transcript.
- The batched issues carry a link to the run that worked them, so a reader
  of the queue sees that they belong together.
- A brief that cannot be read does not stop the run: the turn is written
  without it, and the batched issue keeps its criteria in its own issue.

## Links

- `src/session.ts` — the batched issues' briefs, the resolver that reads them
  once, and the result that carries them out of the session.
- `src/runner.ts` — the review and the fix, the record's batch section, and
  the link the batched issues carry.
- `src/prompts/00-related.md` — the turn that decides the batch.
- `src/prompts/00-scope.md` — the turn that judges the volume of the change.
- `docs/decisions/2026-11-14-the-related-issues-are-fetched-not-searched.md` —
  where the batch is fetched and where it first reached the plan.
- `docs/decisions/2026-11-13-the-next-issues-are-grouped-by-volume.md` — the
  other side of the same coin: the next issues are grouped by volume.
