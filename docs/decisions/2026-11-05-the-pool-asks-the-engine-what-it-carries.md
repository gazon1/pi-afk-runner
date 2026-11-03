---
title: The pool asks the engine what it carries
status: accepted
date: 2026-11-05
authors: MiniMax Code
deciders: Singularity Developer
supersedes: 2026-11-02-the-model-pool-is-a-file-the-host-owns, 2026-11-02-the-file-names-the-effort-of-each-model
tags: [pool, models, engine, session, cli]
---

# The pool asks the engine what it carries

## Context

[2026-11-02-the-model-pool-is-a-file-the-host-owns](2026-11-02-the-model-pool-is-a-file-the-host-owns.md)
brought the model pool: a file the host owns, the models in it, the priorities, the peak
hours, the proxies, and the rules that read it. The file was read through the **Pi SDK**:
the pool asked a `ModelRuntime` which models it carried and whether a provider had a
credential, and the session moved between models with `setThinkingLevel` and the SDK's
own model object.

[2026-11-05-pi-is-gone](2026-11-05-pi-is-gone.md) took the SDK out. The runner runs on
Mastra alone, and the run, the gates, the record and the contract do not know what the
engine is — the seam is the session (`AgentSession`, `SessionFactory` in `src/session.ts`).

So the pool, as it came, had a Pi-shaped hole in it: a `PooledModel`, a `ModelRuntime`,
and a thinking level that only the SDK could set. Three questions had to be answered
again: what the pool asks the engine, how a session moves onto another model, and what
happens to the level the file names.

## Idea

The pool does not know what an engine carries: it asks, and the engine answers with its
own object over the seam. The session grows the one thing a moving session needs — a
way to be moved — and the level the file names stays the host's policy: the runner reads
it, says it, and does not apply what the engine cannot apply.

## Decision

**The pool asks a catalogue.** `src/pool.ts` carries a `ModelCatalogue` — `carries(reference)`
and `hasCredential(reference)` — and no engine of its own. The Mastra answer is
`mastraCatalogue()` in `src/mastra/model.ts`: the models the gateway serves, and the
providers whose key the environment holds. One rule, one place: `knownModel(catalogue, …)`
is used when the pool picks a model and when the runner starts a session, so the two
cannot disagree about what a model is.

**The session can be moved.** `AgentSession` grows `setModel?(reference)` and
`reference?`. The Mastra session (`src/mastra/session.ts`) rebuilds its agent on the new
model and **keeps its memory**: the memory belongs to the session, not to the agent, so a
session that moves onto another model keeps the conversation and the failed turn is the
turn the new model sees. A session that cannot be moved leaves `setModel` out, and the
pool says so rather than pretending.

**The level is reported, not applied.** The file's `effort` is read, validated and
refused when it is not a level — a mistyped `effort: hign` is an error, not something the
runner ignores. The Mastra agent has no thinking level to set, so the runner does not
pretend to set one: `--show-pool` says what the file means, and the level is the host's
policy. This is the one place where the pool's behaviour differs from the SDK's: under
the SDK the runner set the level, and here it cannot.

**The file is read before the lock is taken.** A pool file that is there but cannot be
read is a mistake in the command, and a mistake that holds the lock keeps the next
runner out while it is found. `--pool` names another file; the default is
`<agent-dir>/models.yaml`, and the agent's directory is the host's own.

**`--model` wins over the pool.** A named model is a decision, and the pool does not
overrule a decision. Without a named model the pool's best model is the one the session
starts on, and without a pool file the engine's own default is.

**No model is not a failed step.** When every model of the pool is out of its limit, at
its peak tariff, or cannot be reached, the run stops with the code `3` — there was no
step to run — and a sweep stops there rather than failing every issue in the queue.

## Rationale

**Why a catalogue and not a runtime.** The pool's question is "what models may I use",
and the engine's answer is its own: the models its gateway serves. Handing the pool the
SDK's `ModelRuntime` would have put the engine's shape into the runner's rules, and the
runner would have known what a model is in two ways — the SDK's way and the pool's. The
catalogue is the smallest thing that answers the question, and it is answered by
`src/mastra/model.ts`, which is the engine's file.

**Why the seam grew instead of the pool.** The pool moves a session between models, so
it needs a session that can be moved. Putting that on the seam (`setModel`) keeps the
rule in one place: the engine's session implements it, and the pool calls it. The pool
does not reach into the engine, and the engine does not know what a pool is.

**Why the level is not applied.** A level the engine cannot set is a level the runner
cannot apply. Setting it would mean translating the host's level into the engine's own
vocabulary, and the vocabulary does not exist here: Mastra's agent runs the model it was
given. The level stays in the file, is validated, and is said where the host can see it
(`--show-pool`). A file that names a level and has it silently dropped is worse than a
file that names it and says what it means.

**Why the file is read before the lock.** The lock keeps two runs off one repository. A
pool file that cannot be read is a mistake in the command, and a command that holds the
lock while its mistake is found keeps the next runner out for the whole search.

**Why `--model` wins.** The pool is a policy about which model to use *by default*: it
ranks models by priority, by peak hours and by proxy. A model named on the command line
is a decision about this run, and a policy does not overrule a decision.

## Consequences

- `src/pool.ts` has no engine in it: `ModelCatalogue` replaces the SDK's `PooledModel`,
  and `knownModel(catalogue, reference)` is the one place that says what a model is.
- `src/pool-session.ts` drives a `PoolHost` — a session that can be moved — and does not
  extend `AgentSession`: the pool needs a session that can move, and not every session
  can.
- `src/session.ts` grows `setModel?` and `reference?` on `AgentSession`; the Mastra
  session implements both, and its memory moves with the session.
- The effort ADR's promise — the runner sets the level each model thinks at — does not
  hold on this engine. The level is read and reported. A future engine with a thinking
  level may apply it, and the file's shape will not change then.
- `src/cli.ts` reads the pool before the lock, asks the question `--show-pool` answers
  without taking a lock, and turns "no model" into the code `3`.
- `models.example.yaml` names the models the runner carries, and the tests of the pool
  are the pool's own: a fake catalogue, a fake host, and the rules between them.

## Links

- `src/pool.ts` — the file, the rules, and the catalogue the pool asks.
- `src/pool-session.ts` — the session that moves between the pool's models.
- `src/mastra/model.ts` — the engine's answer: the models it carries and the keys it has.
- `src/mastra/session.ts` — the session that can be moved, and keeps its memory.
- `src/cli.ts` — the pool in the command: `--pool`, `--show-pool`, and the code `3`.
- `docs/decisions/2026-11-05-pi-is-gone.md` — the record that took the SDK out.
- `docs/decisions/2026-11-02-the-model-pool-is-a-file-the-host-owns.md` — the record
  this one supersedes.
- `docs/decisions/2026-11-02-the-file-names-the-effort-of-each-model.md` — the record
  this one supersedes in part.
