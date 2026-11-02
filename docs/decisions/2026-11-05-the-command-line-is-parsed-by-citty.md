---
title: The command line is parsed by citty
status: accepted
date: 2026-11-05
authors: MiniMax Code
deciders: Singularity Developer
tags: [cli, dependencies, citty]
---

# The command line is parsed by citty

## Context

`src/cli.ts` parsed its own arguments: a `Map` of flags, a hand-written loop over `argv`, a
hand-written usage text, and a hand-written check for the flags the command did not have. The
parsing was not the interesting part of the file, and it was the part most likely to be wrong:
a flag named twice, a value that looked like a number and was not, an unknown flag that was
silently kept — citty's own problem, but the hand-written version had the same one and no
library to fall back on.

The runner's command line is read in two ways: by a person at three in the morning, and by a
systemd unit. Both want long names, one value each, and an error when something is wrong.

## Idea

Let a library parse the arguments. `citty` is the one the ecosystem uses for this: it takes
one list of argument definitions and gives back the parsing, the usage and the error messages
from that one list.

## Decision

**`citty` parses the command line.** `src/cli.ts` holds one `ARGS` — the list of the flags,
their types and their descriptions — and `defineCommand` turns it into the command. The
hand-written parser, the hand-written usage text and the hand-written flag table are gone.

**The usage is rendered from that one list.** `renderUsage(command)` prints it, so a flag
that exists is a flag the usage shows, and a flag the usage shows is a flag the command has.

**The exit code belongs to `main`.** The command has no `run`: citty would own the exit code,
and the exit code is the runner's contract with its scheduler (`0`, `10`..`80`, `75`, `76`).

**Validation stays in the runner.** citty checks the types and the enums; it does not know
that a repository is named `owner/name`, that an issue is a positive number, that `--all` and
`--issue` cannot be combined, or that a flag the command does not have is a mistake. Those
checks stay, in the runner, where the rules are.

**One `--gate`, separated by commas.** citty keeps the **last** of a repeated flag, so a
second `--gate` would quietly drop the first one and the run would judge the tree by half the
list the operator asked for. The list is one flag instead: `--gate "./check.sh --fast,just
docs-audit"`. Naming it twice is an error rather than a silent drop.

## Rationale

**Why a library and not a hand-written parser.** The parser was not the runner's work. Every
line of it was a chance to be wrong about a case nobody had tried yet, and the cases that
matter are the ones a person hits at three in the morning: a misspelled flag, a value with a
comma in it, a flag given twice. citty has already met those.

**Why the command has no `run`.** `runMain` would print the usage and exit with citty's own
code. The runner's exit code says which step the run reached, and a scheduler reads that
number — a number a library invented is a number nobody agreed on.

**Why the validation does not move into the argument definitions.** citty's `enum` type would
carry the repository's names, but the names are not known at build time — the repository is
whatever `--repo` says. The issue's number and the conflicting flags are the runner's rules,
and they stay beside the runner's other rules.

**Why one `--gate` and not a repeatable one.** A repeatable flag is the nicer shape, and
citty does not have it: its parsing keeps the last value of a repeated flag. Rather than
write the repetition by hand — the very thing this record removes — the list is one value.

## Consequences

- `citty` is a dependency of the command.
- `--gate` names several gates with commas; naming it twice is an error.
- The usage is citty's rendering, so it reads citty's way — the flags, their types and their
  descriptions, in one table.
- The runner still owns its exit codes, and a test holds them.

## Links

- `src/cli.ts` — the argument list, the command, the parsing and the validation.
- `test/cli.test.ts` — the flags, the usage, and the three layers the gates are decided in.
- `docs/decisions/2026-11-05-the-workflow-runs-the-gates.md` — the gates the command names.
