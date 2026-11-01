---
title: The record quotes the tail of a gate's output and names the file that holds it
status: accepted
date: 2026-11-04
authors: MiniMax Code
deciders: Singularity Developer
tags: [gates, record, diagnostics]
---

# The record quotes the tail of a gate's output and names the file that holds it

## Context

The runner runs the repository's own gates before it pushes, and a gate that does not pass ends
the run there. The record of the run says which gate failed and carries what it printed — the
decision of
[2026-11-02-the-runner-runs-the-repositorys-gates](2026-11-02-the-runner-runs-the-repositorys-gates.md)
settled that the tail of the gate's output is the evidence behind the failure.

The tail was the whole of it. A failing `./check.sh` prints megabytes — a compiler's every
finding, a test run's every failure — and the runner kept the last 64 KiB of it in memory and
quoted that in the record. The rest was gone: not kept in memory, not written anywhere. The
record was a markdown file a person was meant to open, and the person had to scroll past a
thousand lines of a build log to find the line that says which step failed.

Two things were wrong with it. The record was not a document — it was a build log with a
heading. And the whole output was lost: a reader who wanted to know what the build said before
the end had nothing to read.

## Idea

Keep the record a document: the step's detail names the gate and the exit code, the record
quotes the **end** of what the gate printed, and the **whole** of it goes to a file beside the
record, which the record names.

## Decision

**The command runner writes the whole output to a file when it is asked to.** A `CommandSpec`
that names an `outputFile` gets the command's standard output and its standard error written
there, whole, as they come. The runner's own memory still holds only the tail: a build's output
is evidence, not a thing to be kept whole. The rule is in the command runner's own contract, so
every caller of it — the gates, and anything that runs a command the same way — can have the
whole of what a command said without holding it.

**The gates' whole output goes to a file beside the record.** The file is
`<the record's directory>/<the run's id>-gates.log`: the record and the log of the run that
wrote it are in the same place, and the name says which run it is. A gate that **passes** leaves
no log behind — the log of a green build is evidence of nothing, and a diagnostics directory
full of them is a directory nobody reads.

**The record quotes the tail, and says where the rest is.** The record carries at most the last
16 KiB of what the gate printed, and a line under the step names the file the whole of it is in.
The line says when the quote is a tail: a reader who sees the last lines of a log and wants the
rest knows there is a rest.

**The log is the gate's own output, and the record is the redacted document.** The record quotes
a redacted excerpt, because the record is read by a person and is not a secret store. The file
holds the build's own output, whole and unredacted, because it is the machine's copy — the same
output the repository's own CI would keep — and it stays on the machine, under the record. A
log that was redacted would not be the whole log.

**A gate that never ran has no log, and the record names no file.** A gate whose program is not
on the host printed nothing, and a record that points at a file that is not there sends the
reader looking for nothing. The gate that failed is named either way.

**The merge door is not in this.** The merge pipeline has its own contract and its own record,
and its gate writes no output to its record at all. That is a separate change.

## Rationale

A record has one job: let a person reconstruct what happened without the runner's process. A
record that carries a whole build log is not read, and a record that is not read is a record
that is not there.

The end of a build log is where the failure is. A compiler's first finding is the interesting
one for the person who wrote the code; the last lines are the interesting ones for the person
reading the record, because that is where the failure was reported.

The whole output is not lost, because losing it is worse than carrying it. The file costs
nothing to read until somebody wants it, and a gate's output is the evidence a CI run would
have shown: the log the file holds is the log the repository's own CI would have kept.

## Consequences

- The record of a failed gate is bounded: sixteen kilobytes of quoted output, whatever the
  build printed.
- A diagnostics directory holds one log per run whose gates failed, and nothing for the runs
  whose gates passed.
- The command runner's contract grows one field. A runner that is given an `outputFile` and does
  not write it is a runner that does not keep its word; the gates check that the file is there
  before the record names it.
- A log that cannot be written is not a gate's verdict: a directory that cannot be created, or a
  file that cannot be opened, costs the record its pointer and nothing else. The gates still run.
- The merge door's record still says nothing about what its gate printed. That is the next
  change, not this one.

## Links

- `src/git.ts` — the command runner, the `outputFile` it honours, and the tail it keeps.
- `src/gates.ts` — the file the gates' whole output goes to, and the failure that names it.
- `src/runner.ts` — the record, what it quotes, and the line that names the log.
- `docs/decisions/2026-11-02-the-runner-runs-the-repositorys-gates.md` — the decision that put
  the gates in the run, and the tail in the record.
