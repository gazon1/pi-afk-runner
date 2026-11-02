---
title: The git runs through simple-git
status: accepted
date: 2026-11-05
authors: MiniMax Code
deciders: Singularity Developer
tags: [dependencies, git, simple-git]
---

# The git runs through simple-git

## Context

`src/git.ts` ran the real `git` by hand: `spawn`, the environment copied over, the payload
written to the standard input, the exit code read, the output collected, a deadline that
kills the process. The wrapper was the runner's own, and it worked — but it was the runner's
own answer to a question a library has already answered, and the answer had to be right about
stdin, about timeouts and about what a failing git looks like from the outside.

The runner's git is not the only git. `src/cli.ts`, `src/runner.ts`, `src/merge.ts` and
`src/claim.ts` all speak to it through one seam: `GitRunner = (args, {cwd, input?}) =>
Promise<string>`. The seam is what the tests fake, and the seam is what stays.

## Idea

Let a library run the binary. `simple-git` is the one the ecosystem uses: it spawns the git,
feeds it, reads it, times it out, and reports what it answered.

## Decision

**`simple-git` runs the git.** `runGit` is a `simpleGit` instance configured once per call:
the working directory is the checkout, the deadline is the runner's, and the payload is the
one the command reads.

**The seam does not move.** `GitRunner` is the same function type, with the same arguments
and the same promise of a string. `simple-git`'s own object — `SimpleGit`, with its typed
`worktree()`, `revparse()`, `lsRemote()` — is not the seam. Its API does not cover the
commands the runner runs (`mktag`, `update-ref --stdin`, `for-each-ref --no-merged`,
`ls-remote --tags`), and a seam that changed shape would take the fakes in the tests with
it. The runner speaks to the git it needs, and simple-git is how that git is spoken to.

**The runner's errors are the runner's errors.** `CommandFailed` — with the exit code, the
standard output and the standard error — and `CommandTimedOut` stay in this repository,
because the code above this one is written against them: a refused claim is a
`CommandFailed`, a merge that conflicted is a `CommandFailed` with the exit code `1`, and a
gate that timed out is a `CommandTimedOut`. simple-git's own `GitError` says the same thing
in its own words, and nobody up there reads it.

**The failure is thrown as it is.** simple-git wraps whatever error it is given into a
`GitError` of its own, and a wrapped error is not a `CommandFailed`: `instanceof` fails, and a
merge that conflicted would be read as a merge that did not. The failure is therefore kept in
a closure beside the call and thrown from there, so what the caller catches is the error this
file wrote.

**The environment is the whole environment.** simple-git keeps the `GIT_*` keys out of the child
process unless they are named. `GIT_CONFIG_COUNT` carries a credential in CI, and a git that cannot
see it cannot authenticate — so the child git is given every key the runner has, and the list is
made when the command runs, not when the module is loaded. A key that appears between the two is a
key the git still sees.

**The bound is ours as well as the child's.** simple-git asks the child to stop at the bound and
then waits for it to stop. A child that ignores the request would keep the call — and the run
waiting on it — open for as long as it likes. The run stops waiting whether the child does or not:
the call is raced against a hard stop, the way `runGhWithTimeout` races the same way for the same
reason. The rule and the grace are in one place — `src/bound.ts` — and both calls go through it.

**The gates keep their own spawn.** `runCommand` does not run git — it runs the repository's
gates, with their own timeout, their own tail of the output and their own killing of the
process group. That is a different problem, and simple-git does not have it.

## Rationale

**Why v4 and not v3.** `git mktag` reads its payload from the standard input, and
`git update-ref --stdin` reads a list of refs from it. Writing to a child's standard input
is what the v3 line cannot do; the `input` plugin that does it arrived in v4. The claim is a
tag object and the private refs are removed with `--stdin`, so the runner cannot do without
it.

**Why the seam stayed a function.** The seam is the runner's own: the graph, the claim, the
merge and the gates do not know that git is a library or a binary. Everything above the seam
is written against `(args, {cwd, input})`, and everything above it — the tests included —
keeps working unchanged. A seam that moved to `SimpleGit` would put the library in every
fake, and the fakes are where the runner's behaviour is actually pinned down.

**Why the errors stay.** The exit code is not a detail of the failure: it is how the runner
tells a conflict from a refusal, and a refusal from a timeout. A library's error type carries
its own fields, and the code above would have to learn them — the runner's rules would then
be written in the library's vocabulary.

**Why the wrapping is undone rather than accepted.** `instanceof` is the test the code above
uses, and it is the right test: a `CommandFailed` is a git that answered and said no, and
that is a different thing from a `GitError`, which is whatever simple-git decided to make
of it. Rewriting the wrapper keeps the difference visible instead of hiding it behind a
message.

**Why the environment is the whole environment.** The runner's git is the user's git, with the
user's credentials, in the user's CI. A library that tidies the environment is right to do so, and
a runner that needs the credentials has to say which keys it means — saying all of them is the
shortest way to say that, and it is what the runner said before the library came.

**Why the bound is raced rather than waited for.** A child that ignores the request to stop is a
child that holds the run, the host's lock and the schedule hostage. The runner has one rule about
this — a command that hangs must not hold a run for ever — and `runGhWithTimeout` already keeps
it. The git path keeps it the same way.

## Consequences

- `simple-git` is a dependency of the command, at `4.0.2`.
- `runGit` no longer spawns git itself; `runCommand` still spawns the gates.
- The `GitRunner` seam, the error classes and every caller of them are unchanged.
- The commands the runner runs are the commands it needs — simple-git's typed API is not
  used, and `raw` is the only way into it.
- A git that hangs is aborted by the runner's own deadline, and the run stops waiting for it
  whether the git stops or not. The failure is a `CommandTimedOut`.
- The hard stop carries no output: a git that printed something and then ignored the signal is a
  git whose output the runner does not have. The failure says so.
- The child git runs with `GIT_TEST_DISALLOW_ABBREVIATED_OPTIONS`, so every option the runner
  passes is spelled out in full.

## Links

- `src/git.ts` — the git through simple-git, the errors it throws, and the gates that keep
  their own spawn.
- `src/claim.ts` — the refused claim that is a `CommandFailed`.
- `src/merge.ts` — the conflicted merge, read through the exit code.
- `test/git.test.ts` — the exit code of a git that refused, the bound of a git that hangs, the
  payload a git that reads it gets, and the environment the child git sees.
- `docs/decisions/2026-11-05-the-bound-is-one-rule.md` — the bound, as one rule for every child.
- `docs/decisions/2026-11-05-the-command-line-is-parsed-by-citty.md` — the other dependency
  that took over a part of the runner's own code.
