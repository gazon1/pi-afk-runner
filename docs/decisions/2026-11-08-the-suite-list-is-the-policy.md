---
title: The suite list is the policy's
status: accepted
date: 2026-11-08
authors: MiniMax Code
deciders: Singularity Developer
tags: [guard, policy, gates]
---

# The suite list is the policy's

## Context

The guard refused a test suite by the **program** a command starts, and the policy named two of
them: `pytest` and `python -m unittest`. Every other runner was free to run — `npm test`,
`vitest`, `jest`, `gradle test`, `mvn test`, `go test`, `cargo test`, `rspec`.

The target repository's own suite was a Python one, and that was luck rather than a rule. A
target whose suite is a Gradle task under a bare `gradle` gets a run that spends its minutes in a
build nobody asked for — the thing
[the decision on gates](2026-11-05-a-run-gates-nothing-and-builds-nothing.md) forbids.

The policy also carried two lists — the runners and the modules — and a `python` regex beside
them. A runner that is a suite only when it carries an argument (`npm test`) fitted neither.

## Idea

- Keep the two lists and add a third for the programs that need an argument.
- One list of entries, where an entry says what it matches: a program, a program with the
  argument that makes it a suite, or a module a Python runner runs.
- Match the words of the command against the runner's name.

## Decision

**The policy carries one list of the ways a command runs a suite**, and the rule that reads it
names no runner of its own. An entry is a program (`pytest`), a program with the argument that
makes it a suite (`npm test`), or a module a Python runner runs (`python -m unittest`).

**A runner is one more entry, and the rule does not change.** `runsATestSuite` reads the list;
the list grows.

**The refusal is still by the program and not by the word.** A search for a runner's name reads
the tree and goes through.

**`npx` is a wrapper**, like `env` and `exec`: `npx vitest run` runs vitest, and what is read
is the program behind the wrapper.

## Rationale

**Why one list.** The list is what a reader looks at to know what a run refuses; three lists say
three times where the answer is. One list of entries also holds what the old two could not — a
program that is a suite only when it carries an argument.

**Why the argument is matched among the words.** `npm test` and `npm run test` are both the
suite, and `npm run build` is not. Matching the word exactly keeps `npm run latest` — which
carries the letters of `test` — out of the refusal.

**Why `npx` is a wrapper.** The standard spelling of a JavaScript runner is `npx vitest run`, and
the guard already skips the wrappers it knows; a runner behind a wrapper the guard does not know
is a runner that runs.

## Consequences

- `GUARD_POLICY.program.suites` is the only place the runners are written, and `runsATestSuite`
  names none of them.
- A new runner is one entry in that list, and the test that goes with it.
- A program with an argument is refused when the argument is among its words: `npm test`,
  `npm run test`, `gradle test`, `mvn test`, `go test` and `cargo test` are refused, and
  `npm run build` is not.
- A search for a runner's name is still allowed — the refusal is by the program, not by the word.
- The decision on gates stands; this extends the list of the suites it names.

## Links

- `src/guard.ts` — the policy's list, and the rule that reads it.
- `test/mastra.test.ts` — one refused form and one allowed form per runner.
- `2026-11-05-a-run-gates-nothing-and-builds-nothing.md` — the run that gates nothing, and the
  guard that refuses a suite.
