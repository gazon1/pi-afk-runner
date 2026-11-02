---
title: The model pool is a file the host owns, and the runner moves between the models in it
status: accepted
date: 2026-11-02
authors: MiniMax Code
deciders: Singularity Developer
tags: [models, pool, configuration, session]
---

# The model pool is a file the host owns, and the runner moves between the models in it

## Context

The runner used one model for everything: the one `--model` named, or the first model the
first provider offered. That is fine until the host has more than one model and the models are
not equally good at every hour.

Three things make one model the wrong answer. A provider charges a **peak tariff** for some
hours of the day — DeepSeek charges its double tariff for the first sixteen hours of UTC — and
the model that is the best model at noon is a bad bargain at midnight. A model's **limit runs
out**: the provider answers `429`, or says the quota is spent, and the run dies on a model that
could have been swapped five minutes earlier. And a provider's models come and go: a model that
is free this minute is paid the next one, and a runner that has already picked its model is
stuck on the lowest-priority one it could reach.

All three are the **host's** knowledge, not the repository's: which models the host has
credentials for, what the host pays for them, and when. The repository cannot know any of it,
and a host's answer changes every week.

The runner had no place to put that knowledge and no way to act on it. `--model` was one model
and nothing else, and the SDK's session took the model it was given for the whole run.

## Idea

Put the models and their conditions in **one file the host owns**, and let the runner move
between the models in it: away from a model at its peak tariff, away from a model whose limit
is gone, and towards a model that has become available.

## Decision

**The pool is one YAML file, and the host owns it.** It lives in the agent's directory —
`<agent-dir>/models.yaml` — beside Pi's settings and credentials, and `--pool <path>` names
another one. The agent's directory is already the host's own place, and it is known to both
doors: the CLI and the live chat. The file says which models the runner may use, each one's
`priority` (the bigger number wins, the order of the file settles a tie), its `peak` hours
(`HH:MM-HH:MM`, with a `timezone` that says where they are counted), and the `proxy` its requests
go through. `checkEveryMs` says how often the pool is looked at again; five minutes by default.

**Every model may have a proxy of its own.** `proxy: true` is the **host's** own proxy — the one
the environment names — and a model that needs it cannot be used without one. A URL is a proxy of
**that model's own**: the runner routes that model's requests through it, and the rest of the run
goes direct. Only `http://` and `https://` are spoken, and a `socks://` URL is refused when the
file is read: undici's proxy agent tunnels over CONNECT, and a SOCKS proxy would fail at the first
request with nothing in the log to say why.

The proxy is installed **globally**, per model: the SDK's provider calls go through
`globalThis.fetch`, and the SDK does not pass a `fetch` of its own to the provider, so a proxy
that is not the global dispatcher is not a proxy at all. The runner therefore installs undici's
dispatcher — the model's own proxy when the file names one, the host's own from the environment
otherwise — and replaces the global fetch with undici's, which reads that dispatcher. The proxy
is the model's, and it is given back when the session ends: the host's own chat in the same
process must not go through the model's proxy.

**The file is strict.** A key the runner does not know is an error, not something it ignores.
A mistyped `priorety` that is skipped is a model used at the wrong priority, and nothing would
say so. The same goes for a model that does not name itself as `provider/id`, a peak window
that cannot be read, and a `checkEveryMs` that is not a positive number. A file that is there
but cannot be read stops the run before the lock is taken: it is a mistake in the command, and
a mistake that holds the lock keeps the next runner out while it is found.

**A named model wins over the pool.** `--model <provider/id>` is a decision, and the pool does
not overrule a decision: the named model is used, and it is not pooled. The pool applies where
no model is named — the CLI's own run, and the live chat, where the host's session model
becomes the fallback used only when there is no pool.

**A peak hour is a filter, not a demotion.** A model inside its peak window is not used at
all; the pool moves to the next one. There is no "use the expensive model anyway if nothing
else is left": when every model is inside its peak hours, there is no model, and the run ends.

**A model that cannot answer is out for the rest of the run.** The SDK resolves a turn whose
model call failed, so the failure arrives as the assistant message's error, and the error text
is where the provider names the limit: `429`, `rate limit`, `too many requests`, `quota`,
`insufficient credit`, `limit reached`, `credit balance is too low`. A provider whose
credential is gone says so by throwing instead of answering, and that says the same thing. A
turn that failed that way is **taken again on the next model**, and on the one after that, until
the pool is empty — so a limit that runs out halfway through a session costs the session a turn
and not the run.

**A model whose limit is gone stays gone for the whole run.** The exhaustion is remembered by the
run, not by the session: a sweep that works one issue after another must not try the dead model
again on the next issue, and a session that ends does not bring it back. The next run starts with
a clean pool and finds out about the limit again.

**The pool is looked at again while the session runs, and it moves upwards only.** Every
`checkEveryMs` the runner asks the SDK what the providers offer **now** — a provider whose
credential has run out has no models to offer, and a model that has become free of its limit is
one the runner may move to. The runner moves to a better model when one appears, and away from
the model it is on when that model's limit is gone. It does not leave a working model for a
worse one on a whim — but a model the provider no longer offers is not a working model, and the
runner does leave it. The check runs inside the session, on a timer that does not keep the
process alive: the runner's own deadline is what ends a run. A look that fails is the pool's
problem and not the run's: the run says so and goes on — a refusal left unhandled in the timer
would take the whole process down in the middle of the sweep.

**The file is read again when the host has changed it.** The file is the host's policy, and the
host may change it while the runner works. The runner reads it again when its timestamp has
moved, and the new pool takes effect from then on. A file that cannot be read at that moment is
not a reason to stop the run: the pool the run started with is still the host's last word on the
matter, and the run says that the new file is wrong.

**No model is a reason to stop, not a failure to spread.** When no model in the pool can be
used, the run stops with the code `3` and says why. The work stays in the queue for the next
run, and `--all` **stops the sweep there** rather than failing every issue in it: the next
issue would fail the same way, and a sweep that fails every issue in the queue is not a sweep.

**The host can ask what its own file means.** `--show-pool` prints every model, why it would be
used and why it would not. It is a question, not a run: nothing is worked and no lock is taken —
a lock nobody gives back keeps the next runner out. A host that cannot see what its file says
cannot change it.

**The record says what the pool did.** The run's record carries the pool's own lines — the model
the session is on, and the model it moved to and why — so a person can tell from the record which
model answered and where the pool moved.

**The pool file is the only place this policy lives.** Not a flag per condition, not an
environment variable per provider, and not a rule spread over the runner's code: one file a
person can read and change.

## Rationale

The runner's job is to work the queue, and a model that cannot answer is not a reason to stop
the queue — it is a reason to use another model. Everything in the pool is that: the same
answer to the same problem, written down once.

The file is the host's because the host is the only one who knows the tariff and the
credentials. A repository that hard-coded DeepSeek's peak hours would be wrong on the day the
provider changes them, and wrong in a way nobody would notice.

Strictness is the price of a file the runner reads on its own. A key it ignores is a policy
that is not applied, and a policy that is not applied is worse than no policy: the host
believes the pool says something it does not.

Peak as a filter keeps the promise simple: the pool uses models that are cheap right now, or
does not run. A demotion — "use the expensive one if nothing else is left" — would make every
peak window a reason to pay.

The periodic check answers the question the host actually has: *is something better available
now?* Moving upwards only keeps it safe — a model that has become available is taken, and a
model that is working is not abandoned. A model the provider no longer offers is not working,
and leaving it is what the check is for.

Reading the file again when it has changed is what makes the file the host's own while the
runner works: a host that raises a price, or adds a model, sees it without waiting for the next
run — and the file stays the single place the policy lives.

Stopping the sweep is the difference between a queue that is waiting and a queue that is
broken. Failing every issue in it would push a claim on every one of them and fill the
runner's diagnostics with the same failure.

A proxy per model keeps one file as the place for the host's network, the same way the file is
the place for the host's tariff: which model goes through which proxy is the host's knowledge,
and it changes per model. Installing it globally is what makes it work at all — a dispatcher
the SDK does not use is not a proxy.

`--show-pool` and the record's pool section are the same promise from two sides: what the file
means now, and what the pool did while the run worked.

## Consequences

- The runner has one more file to read at start-up and one more way to fail: a pool file that
  is broken stops the run before the lock is taken.
- The model a run uses is decided by a file a person can read, and the run says which model it
  is on and when it moves.
- The exit code `3` is new: it means "no model was available", and it is not a failure of the
  work.
- The pool is the only place a model's conditions live. Adding a condition means a key in the
  file and a rule in `src/pool.ts`.
- The exhaustion of a model is remembered for the run, not for the host: the next run starts
  with a clean pool and finds out about the limit again.
- The file is read again while the run works, and a broken file at that moment leaves the run
  on the pool it started with.
- The file needs `yaml`, which the repository now depends on.
- The runner installs undici's dispatcher for as long as the session that uses it runs, and
  undici's `fetch` as the global one. A host that needs another dispatcher of its own has to
  set it after the runner starts.
- `--show-pool` reads the catalogue and the credentials of the host's agent directory, so it
  says which models can be reached — and it needs the same directory the run would use.

## Links

- `src/pool.ts` — the file's format and the rules that read it.
- `src/pool-session.ts` — the session the pool drives, and the models it moves between.
- `src/proxy.ts` — the dispatcher the requests of a model go through.
- `src/cli.ts` — `--pool`, `--show-pool`, the model that is chosen, and the exit code `3`.
- `src/extension.ts` — the live door: the host's own model is the fallback, the pool is the pool.
- `models.example.yaml` — the pool file as an example.
- `README.md` — the pool, as the user reads it.
- `docs/practices/CODING_STANDARDS.md` — the conventions this change follows.
