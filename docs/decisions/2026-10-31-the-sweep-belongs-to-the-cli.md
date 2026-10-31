---
title: The queue is drained by the CLI's --all, not by a shell loop
status: accepted
date: 2026-10-31
authors: Command Code
deciders: Singularity Developer
tags: [cli, systemd, queue, lock, exit-code]
---

# The queue is drained by the CLI's `--all`, not by a shell loop

## Context

The CLI worked one issue per invocation, and the sweep that drains the queue was a `while true`
loop in the justfile's `comb` recipe. The loop did not work:

- the recipe ran under `set -euo pipefail`, so a non-zero exit from `node` ended the script before
  its own `rc=$?` branches could run — the lock-held and lock-unusable branches were dead code;
- the loop ran the CLI without `--issue`, so every tick took the **first** eligible issue. A failed
  run releases its claim, the issue goes back to the front of a stable queue, and the next tick
  takes the same issue again: the loop would spin on one failing issue for ever.

The systemd unit inherited the one-issue shape: an hourly timer, one issue a tick, and a
`TimeoutStartSec=3h` that a sweep of several one-hour runs can outlast.

## Idea

Teach the CLI to drain the queue itself, and let both schedulers — `just comb` and the unit — call
it.

## Decision

**`--all` reads the eligible issues once and works them one by one, by number.** The list is read
before the first issue is worked, so a failed issue cannot re-enter in front of the others, and no
issue is worked twice. The claimed issues are read as well as the queue: a claim a killed sweep
left behind is excluded from `readQueue` by construction, and taking it over is the only thing that
will ever free it.

The lock is taken once, for the whole sweep, and given back at the end. A failure does not stop the
sweep; the exit code is the **first** failure's code — the step's code when a step failed, `1` when
an issue could not be worked — so a scheduler still reads where the sweep stopped. An issue that
cannot be worked — a fresh claim that belongs to a run elsewhere — is reported and **counts as a
failure**, so a sweep never says "drained" while an issue was left.
`--all` and `--issue` together are a usage error. Without `--all` the CLI behaves exactly as it did
— one invocation, one issue — because the contract is one run per issue and the live door works one
issue per `/afk-runner-run`.

The unit passes `--all`, its `Description` says so, and `TimeoutStartSec` is `infinity`: a sweep has
no fixed length, so any finite value is a kill in the middle of one. The runner's own one-hour
deadline still bounds each issue's turn. The unit also sets `--stale-after-ms 7200000` instead of
the week a hand-run uses: a run is capped at one hour and the host lock excludes a second local
runner, so a claim older than two hours is dead, and a claim a killed sweep left is taken over a
tick or two later.

## Rationale

**Why not fix the shell loop.** The loop's two defects are the same defect: the CLI, not the shell,
knows which issues are eligible and which were just worked. A loop that has to re-read the queue
each tick and recognise the issue it already failed is a second implementation of the selection
rule — and it is the one that spun.

**Why by number.** Working the queue's first issue after each failure re-reads the same queue in the
same order. Naming the number makes the sweep a list traversal, which terminates whatever the
outcome of any one issue.

**Why the claimed issues are in the list.** A sweep killed mid-issue leaves the claim behind, and a
claim is exactly what keeps an issue out of `readQueue`. Without the claimed read, `--all` would be
less able to recover a dead run than the single-issue CLI it replaces.

**Why the first failure's code, not a generic one.** The code is how a scheduler learns the step the
sweep reached; collapsing it to `1` would throw away the one thing the exit code is for. A skipped
issue is counted with the failures for the same reason: `0` is the code that means the list was
worked, and it must not also mean "the list was partly left for later".

**Why no systemd timeout.** A sweep's length is the queue's length, and the queue has no ceiling the
unit knows. Any finite timeout is therefore a kill mid-sweep at some queue size, and the issue asked
for none. The per-issue deadline is the bound that remains.

**Why two hours for the claim.** The claim's staleness is measured from the issue's last update, and
a run is capped at one hour. Two hours is therefore longer than any live run on this host, while
short enough that a killed sweep's issue is not lost for the week a hand-run allows.

## Consequences

- A tick drains the queue instead of taking one issue out of it, and the queue length no longer sets
  how many hours it takes.
- A sweep that is killed leaves its claim; the next sweep reads the claimed issue, finds the claim
  stale after about two hours, and takes it over.
- `TimeoutStartSec=infinity` means a genuinely hung `gh` or `git` call is not stopped by systemd.
  The timer will not start a second instance while the unit runs, so the hang holds the queue.
- The claimed read costs one `gh issue list` per sweep, on top of the queue read.

## Links

- `src/cli.ts` — `parseArgs`, `main`, `sweep`, `work`, `USAGE`.
- `src/extension.ts` — `--all` is refused by the live door, which works one issue.
- `justfile` — the `comb` recipe calls `--all`.
- `systemd/pi-afk-runner.service` and `systemd/README.md` — the unit and what its status means.
- `test/runner.test.ts` — `test_all_works_every_issue_once_and_gives_the_lock_back`,
  `test_a_failing_issue_does_not_stop_the_sweep`, `test_all_cannot_be_combined_with_issue`.
