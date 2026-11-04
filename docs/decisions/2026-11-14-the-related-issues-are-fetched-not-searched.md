---
title: The related issues are fetched, not searched for
status: accepted
date: 2026-11-14
authors: MiniMax Code
deciders: Singularity Developer
tags: [runner, prompt, session, queue, tokens]
---

# The related issues are fetched, not searched for

## Context

A run may work more than one issue: the related turn decides which of the
other open `ready-for-agent` issues belong beside the one in hand, and the
batch is worked as one change.

The turn did the finding itself. Its instruction said to list the other open
issues, read the brief of the ones that looked related, and decide — so the
model spent a search of its own: `gh issue list`, a read of a body here and
there, and the whole of it in the turn's context. The runner already had the
queue: it had just read it to choose the issue in hand.

And the turn's result went nowhere. The batch was recorded and nothing else
happened — the model that decided it was the only one that knew what the other
issues were about, and the criteria of a batched issue reached the diff only
because that model remembered them.

## Idea

The related issues are **fetched** by the runner and handed to the turn, and
the turn decides.

## Decision

**The runner fetches the candidates.** One read — the open `ready-for-agent`
issues that nobody has claimed — and the turn is given the number and the
title of each. The issue in hand is not among them.

**The pool carries titles, not bodies.** A candidate's brief is read when the
title leaves the model in doubt: `gh issue view <n> --json body,comments`.
The bodies of a hundred candidates would cost more than the turn they are read
in, and the titles in this repository's queue say what the issue is about.

**The turn does not search.** The instruction says the list is above it, that
the list is the whole pool, and that a candidate's brief is read only when its
title leaves the model in doubt. The search is the runner's read; the decision
stays the model's.

**The fetched issues are data, not instructions.** The list travels in a
fence, like the issue's own body, and the fence is above the turn's
instruction so the instruction the model reads last is the instruction. The
rule that says it is data and not instructions names the fence: the pool is
other people's text in a public repository.

**The batch reaches the plan.** The runner reads the briefs of the issues the
turn batched — then, and not before — and hands them to the plan's turn, above
its instruction. The plan is written with their acceptance criteria in hand,
and the implementation follows the plan.

**The batch may only name a fetched issue.** The decision tool refuses a
number that is not in the fetched set, and says so. The record is what the run
is judged by, and a number nobody fetched is nobody's issue.

## Rationale

The queue read is a read the runner makes anyway; making it again for the
related turn costs one call and buys the whole pool. A search by the model
costs the model its context — the list of issues, the bodies it read to judge
them — and it costs the run its determinism: two runs of the same issue see
different candidates.

The title is the payload, not the body. The title says what the issue is
about, and it is what tells a reader whether the issue belongs beside the one
in hand; a body per candidate would fill the turn's context with work the
model may never need. The titles are a read the runner makes anyway — the
queue read — and the bodies are the read the model asks for, one candidate at
a time.

The pool is read where the turn is about to run, and not where the run
started: a sweep's queue is hours old by its last issue, and a stale pool
would offer the model issues the sweep has already filed.

The refusal is the bound. The tool's other bounds are the runner's — at most
three leftovers a run, nothing that is already open — and this one is the
same: the batch is a record of a choice between the issues the runner
fetched, and a number outside that set is a mistake the runner can name.

## Consequences

- The related turn starts from the pool instead of from a search: the model's
  context holds the candidates, not the hunt for them.
- The candidates are the queue's issues, so an issue another run is working is
  not among them — the batch never takes an issue somebody else has claimed.
- The batch reaches the plan: the runner reads the batched issues' briefs
  when the plan's turn runs, so the change meets their acceptance criteria
  too. A brief that cannot be read does not stop the run — the plan is
  written without it, and the batched issue keeps its criteria in its own
  issue.
- The turn is opt-in (`--batch-related`), and this change does not change
  that: a run that does not ask for the batch does not fetch the issues.

## Links

- `src/gh.ts` — the queue read the pool comes from.
- `src/session.ts` — the pool, the fence, the untrusted-input rule, and the
  batched briefs that travel with the plan.
- `src/decisions/related.ts` — the decision tool and the refusal.
- `src/prompts/00-related.md` — the turn, which no longer searches.
- `docs/decisions/2026-11-13-the-next-issues-are-grouped-by-volume.md` — the
  other side of the same coin: the next issues are grouped by volume.
