---
title: The next issues are grouped by volume
status: accepted
date: 2026-11-13
authors: MiniMax Code
deciders: Singularity Developer
tags: [runner, prompt, queue, session, tokens]
---

# The next issues are grouped by volume

## Context

A run works one issue. The issue that comes after it is another run: another
session, another context — the repository is read again, the brief is read
again, the contract is read again. The context is the largest part of a run's
cost, and it is paid per issue.

The runner files the next issues in two places. The fourth turn files the
**leftovers** — the work that follows from what was just done, at most three a
run, one issue each. The scope turn files the **pieces** of an issue that did
not fit one run: two to eight smaller issues, chained so they run in order.
Each of those is a run of its own.

Nothing looked at their size. A leftover worth one line and a leftover worth a
refactor each became an issue, and each issue became a context.

## Idea

The next issues are grouped by **volume**: work that together still fits one
run becomes one issue, and work that does not keeps an issue of its own.

## Decision

**The grouping happens where the issues are created, and it is the model's
judgement.** The fourth turn groups the leftovers before it files them; the
scope turn groups the pieces before it orders them. The rule is in the two
prompts, and in the leftover tool's own guidelines.

**A grouped leftover is one issue and one brief.** The brief carries one
`**Summary:**` line and one acceptance criterion list per leftover, each under
a heading that names it — the criteria stay checkable, and each of them is
still somebody else's to verify.

**A grouped piece is one piece.** A piece too small to need a run of its own
goes into the piece beside it; no piece is so big that it would not fit one
run. The pieces keep their order, so the dependency chain is unchanged.

**The bounds stay, and the tool counts them.** At most three leftovers a run,
counted by the leftovers and not by the issues: one issue that carries two
leftovers uses two of the three. The tool counts them by the brief's
`**Summary:**` lines — one per leftover — so the bound it holds is the bound
the prompt promises. A brief that names no leftover is refused: a bound that
cannot be counted is not a bound.

**No new tool and no new field.** A grouped issue is an ordinary issue with an
ordinary brief; the runner files it, labels it `ready-for-agent`, and the next
run takes it like any other.

**The issues of one run are linked to each other.** The brief of the issue
filed later names the ones filed before it — `**Related:** #N` — and the
earlier issues carry the link back in a comment. The link is a nicety: a
comment that fails does not fail the filing with it, and the run's issues stay
filed.

## Rationale

Grouping by **volume** and not by topic is the point. Grouping by topic is
what the related turn already does — it batches the issues that are one change
wearing several titles, and it is right there. What was missing was the other
half: the small work that shares no topic with anything, and that still costs a
whole context each because it is an issue of its own.

The size of the work is what a run's context can hold, so it is the right unit
to group by. A merge by topic that crossed areas would make a diff that cannot
be reviewed as one change; a merge by volume keeps every merged piece small
enough to be one change.

The rule stays in the prompts because volume is a judgement about the code, and
the model is the only one that has read the code. The runner holds the bounds;
the model holds the judgement. That split is the one this repository already
uses everywhere else.

## Consequences

- The queue holds fewer issues, each a little bigger. The next run reads one
  brief instead of several, and pays one context instead of several.
- A leftover's own criteria are still in the brief, under their own heading, so
  the review still judges each of them.
- The bound of three leftovers a run is now a bound on the work filed, not on
  the issues filed: one issue of three leftovers is at the bound, and the tool
  refuses the fourth leftover however few issues carry them.
- A leftover too big to share a run keeps its own issue — grouping is for what
  is small, and a merged issue that does not fit a run buys nothing.
- The issues of one run carry each other's numbers, so a reader of the queue
  sees that they belong together without reading every body. `**Related:**` is
  not a dependency marker, so the link never holds an issue out of the queue.

## Links

- `src/prompts/04-next.md` — the fourth turn, where the leftovers are grouped.
- `src/prompts/00-scope.md` — the scope turn, where the pieces are grouped.
- `src/leftovers.ts` — the tool the leftovers are filed with, and its bounds.
- `src/session.ts` — `splitIssue`, which files the pieces and chains them.
- `docs/decisions/2026-11-02-the-fourth-turn-asks-what-follows.md` — the fourth
  turn and the bounds this decision keeps.
- `docs/decisions/2026-11-01-the-work-is-a-conditional-graph.md` — the split
  and the dependency chain.
