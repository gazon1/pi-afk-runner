---
title: The file names the effort each model thinks at
status: accepted
date: 2026-11-02
authors: MiniMax Code
deciders: Singularity Developer
tags: [models, pool, configuration, session]
---

# The file names the effort each model thinks at

## Context

The pool file says which model the runner uses and when it may use it. It said nothing about
**how hard** that model thinks: the session ran at whatever level the SDK's own settings gave it,
and the host's pool — the file the host owns and edits — could not say "this model answers at the
effort I pay for".

The SDK has the levels (`off` to `max`) and clamps them to what a model can do. What it has is
no place where the host's _policy_ about a model lives: the SDK's own per-model overrides are the
host's Pi settings, and the pool is the runner's file.

## Idea

Let the pool file name the effort of each model, the way it already names the priority, the peak
hours and the proxy.

## Decision

**`effort` is a key of the model, and it is the level the model thinks at.** The levels are the
SDK's own — `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` — and the runner takes the
list from the SDK's type instead of writing a list of its own that can drift.

**A level the file names is set after the model is set.** The SDK gives a new model its own level
when the model changes, so the file's level is applied last: the file is the host's last word
about the model the session runs on.

**The effort belongs to the model, not to the run.** The pool moves between models, and each model
runs at its own level: the level follows the model, and the next model's level is set when the
runner moves to it.

**A model the file says nothing about keeps the level the SDK gave it.** A key that is absent is
not a request for another level, and the SDK knows what its own models can do.

**A level the SDK does not know is refused when the file is read**, like every other key: a
mistyped `effort: hign` that is ignored is a model that thinks at the wrong level, and nothing
would say so.

## Rationale

The pool is the one place the host's policy about a model lives, and the effort is policy about a
model: the same model is worth a bigger effort at one hour than at another, and the host is the
one who knows. A flag would put it in the command line, where it is one more thing to repeat on
every run and nowhere to be read with the model it belongs to.

The level is the model's, not the run's, because the pool moves. A run that keeps one level for
the whole sweep would answer a cheap model at the effort of an expensive one, and the host's file
would look like it were respected when it was not.

Not naming a level is not naming a level. The SDK knows what its models can do and gives each of
them a level of its own; the file only says when it wants another one.

## Consequences

- `--show-pool` says the level of every model the file names one for: the host sees the level it
  asked for next to the model it belongs to.
- The level is clamped by the SDK: a model that cannot think at the level the file names answers
  at the nearest level it has, and the SDK's own transcript says which level it settled on.
- Adding a condition to a model is a key in the file and a rule in `src/pool.ts` — the pool is the
  only place a model's conditions live.

## Links

- `src/pool.ts` — the file's format, the levels, and the rules that read them.
- `src/pool-session.ts` — the session the pool drives, and the level it runs each model at.
- `models.example.yaml` — the pool file as an example.
- `README.md` — the pool, as the user reads it.
- `docs/decisions/2026-11-02-the-model-pool-is-a-file-the-host-owns.md` — the pool itself.
