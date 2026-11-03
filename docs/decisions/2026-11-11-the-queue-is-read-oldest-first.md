---
title: The queue is read oldest first
status: accepted
date: 2026-11-11
authors: Command Code
deciders: Singularity Developer
tags: [queue, selection, gh]
---

# The queue is read oldest first

## Context

The queue read asked `gh` for the issues labelled `ready-for-agent` that nobody has claimed, and took
them in the order `gh` answered: the newest first.

That order made the runner work the same task over and over. A run that finishes an issue files the
leftovers it noticed — new issues, labelled `ready-for-agent`, so the next run finds them. The next
run read the queue newest-first, so the leftovers it had just filed sat at the front of the queue, and
the backlog behind them waited. Every run made the queue longer and worked the same fresh end of it.

## Idea

Read the queue in the order the backlog was filed: the oldest issue first.

## Decision

**The queue read asks for `sort:created-asc`.** It is part of the search form the runner already
uses, so the order is `gh`'s own and not the runner's: `--search '-label:agent-in-progress
sort:created-asc'`.

The order is the queue read's, and it holds everywhere the queue is worked: the single-issue path
takes the first eligible issue of the queue, and the sweep works the issues of the list in the order
it read them.

**The claimed issues keep their place in front of the queue.** A claimed issue is work that has
already been started — a claim a killed run left behind is in the claimed set, and taking it over is
the only thing that frees it. Finishing started work before starting new work stays the rule; the
claim read is not reordered.

## Rationale

**Why the order is in the query and not in the runner.** The runner would need the creation time of
every issue to sort them itself — a new field in the issue's shape, a new field in every read, and
a sort over what `gh` already sorted. The query says what it wants, and the queue is read in one
call either way.

**Why the claim read is left alone.** The claim is a lock: the read that finds it is the read that
takes a stale claim over, and it must see the claim as it is. Ordering it changes nothing about the
complaint — a leftover is filed without the claim label, so it is a queue issue, and the queue is
what is sorted.

**Why the oldest, and not the newest.** The complaint is that the runner keeps working what it filed
last. The oldest first is the order in which a backlog drains: every issue that waits is worked
before the issue that arrived after it.

## Consequences

- A run that files leftovers does not find them at the front of the next queue: the backlog behind
  them is worked first.
- The queue read asks `gh` for one more thing — the order — and the read stays one call.
- The contract does not change: it names the label and the brief's marker, and it says nothing about
  the order the queue is worked in.

## Links

- `src/gh.ts` — `queueArgs`, the search form and the order.
- `src/runner.ts` — `chooseIssue`, which takes the first eligible issue of the queue.
- `src/cli.ts` — `sweep`, which works the issues of the list in the order it read them.
- `test/runner.test.ts` — `test_selection_uses_the_minus_search_form`, `reads the queue oldest first`.
