---
title: The sweep ends with the smallest failing issue's code
status: accepted
date: 2026-11-12
authors: Command Code
deciders: Singularity Developer
tags: [runner, sweep, cli, exit-codes]
---

# The sweep ends with the smallest failing issue's code

## Context

A sweep worked one issue at a time, and the code it ended with was the code of the first issue that
failed — the first in wall-clock time. The sweep works the issues in the order it read them, which
for the queue is the order of their numbers; so that code was also the code of the smallest failing
issue, and the two readings were the same answer.

The sweep now works several issues at once, and there is no first failure any more: the failures
happen in whatever order the workers happen to finish in. The same sweep of the same issues ended
with `75` on one run and with `10` on the next, and a scheduler that reads the exit code could not
tell what had happened.

## Idea

The code of a sweep is decided by the issues it worked, not by the order their failures happened
in.

## Decision

**The failure of the issue with the smallest number decides the sweep's code.** Among the issues
that failed, the one with the smallest number has its code.

**The codes themselves do not change.** A sweep still ends with the code of the step that failed —
what is new is the choice between several failures.

**A sweep in which nothing failed ends with the zero**, as before.

## Rationale

**Why the number and not the order.** The number belongs to the issue; the order belongs to the
run. Two runs of the same sweep have the same issues and the same numbers, so they have the same
code, and a number that says what happened is a number a scheduler can act on.

**Why the smallest number.** It is the issue the sweep would have stopped at had it worked the
issues one after another: the same answer the one-issue-at-a-time sweep gave, and the answer the
code meant before the workers came.

**Why not the first failure.** With one worker there is only one order. With several there are as
many orders as there are workers, and none of them is the sweep's order.

## Consequences

- A sweep's code no longer depends on how fast the issues failed.
- The code a sweep that works one issue at a time ends with does not change: the issues are worked
  in the order of their numbers, so the smallest failing issue is the first one that failed.
- The unit's status is the same number it was, in the ordinary case where the queue is worked in the
  order of its numbers.

## Links

- `src/cli.ts` — `sweepExitCode`, the rule, and the sweep that collects the outcomes it reads.
- `test/cli.test.ts` — the codes a sweep ends with.
- `2026-11-05-the-sweep-works-several-issues-at-once.md` — the decision whose exit-code clause this
  one replaces.
- `systemd/README.md` — the unit's status.
