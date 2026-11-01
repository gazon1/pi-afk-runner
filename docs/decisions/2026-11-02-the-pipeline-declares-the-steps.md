---
title: The pipeline declares the steps, and the kinds of step are the runner's
status: accepted
date: 2026-11-02
authors: MiniMax Code
deciders: Singularity Developer
tags: [runner, pipeline, steps, yaml, configuration]
---

# The pipeline declares the steps, and the kinds of step are the runner's

## Context

The runner's steps were a fixed list inside `runPlan`: claim, worktree, session, push, pull
request, review, re-count. The list was in code because the list *was* the runner's — the
prompts were files the runner read, and the gates were the agent's own business, so there was
nothing for a repository to say.

The prompts moved into the repository's hands first (`.afk-runner/pipeline.yml`, the issue
before this one), and with them the question the list answered on its own: a repository that
wants a different step, or a different order, has no way to say so. It would have to change
the runner and wait for a release — and the runner is a separate repository on purpose, so
that wait is long.

## Idea

Let the repository's file name the steps, in order, from a fixed set of built-in kinds.

## Decision

**The pipeline file names the steps the run takes, in order, and the set of kinds is closed.**
The kinds are `claim`, `worktree`, `session`, `gates`, `push`, `pull-request`, `review` and
`re-count`; the file chooses from them and cannot add to them.

**The runner's state machine is unchanged.** What each step *does* — the claim, the worktree,
the session, the push, the pull request, the review, the re-count — is the code it has always
been. The file says which of them happen and in what order; it does not say what they do. A
step the run's state does not need is not part of the run: the run of a pull request that is
already open has no claim to take and no session to run.

**An unknown kind is refused when the file is read.** The pipeline is read before the run takes
anything, so a repository whose file names a step the runner has not got fails before it claims
an issue — not half-way through a run, with the claim taken and the worktree made.

**The claim step is not optional.** The claim is what stops two runners working the same issue,
and the runner does not trust the queue's query to keep that promise — nor a file. A pipeline
that drops the claim step is refused. Every other step is the repository's to choose: a step
that does not apply to the run's state is simply not part of the run.

**A repository with no file runs the steps it ran before.** The default list is the runner's
own list, unchanged, and the default run is the run it has always been.

## Rationale

The kinds are closed because a step is not a thing a repository can invent: the runner's
contract — the claim, the label, the review marker, the record — is bound to what those steps
do. A repository that could add a step could add a step that pushes without a claim, and the
guarantees the runner makes would stop being guarantees.

The state machine staying in the code is what makes the file safe. The file is configuration;
configuration that can change what a step *means* is a second implementation of the runner, and
two implementations drift. The file is an ordering, and the runner is the machinery.

Reading the file before the run takes anything is the difference between a mistake that costs
nothing and a mistake that costs a claim and a worktree. The runner has a rule about that
already — a claim nobody is working is an issue nobody can take — and a pipeline the runner
cannot read is exactly such a case.

The default being the runner's own list is what keeps every repository that declares nothing
working. The runner's own repository is one of them.

## Consequences

- The runner reads `.afk-runner/pipeline.yml` from the checkout it works in, and the file's
  keys it does not read are left alone — the file is the repository's, and it may say things
  about prompts and skills that this runner does not read yet.
- The `gates` step runs the gate commands the file declares, in the worktree, in order, and a
  gate that fails stops the run: the claim is released and nothing is pushed.
- A step that needs a step the pipeline did not put before it says so and stops the run
  (`the worktree step needs the claim step before it`). The runner does not guess an order the
  file did not declare.
- A pipeline that declares no claim step is refused, for the reason above.
- The runner depends on `yaml` to read the file.

## Links

- `src/pipeline.ts` — the kinds, the default, and the file's reader.
- `src/runner.ts` — `runPlan`, which composes the steps the pipeline declares.
- `README.md` — the file, and what it says.
