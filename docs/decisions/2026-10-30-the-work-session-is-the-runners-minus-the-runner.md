---
title: The work session is the runner's, minus the runner
status: accepted
date: 2026-10-30
authors: Command Code
deciders: Singularity Developer
tags: [extension, session, guard, extensions, recursion]
---

# The work session is the runner's, minus the runner

## Context

`pi-afk-runner` has two front doors — `src/cli.ts` for a timer, `src/extension.ts` for a human
watching — and both create a **work session**: a Pi session whose `cwd` is the worktree, which the
runner drives through the prompt array.

Two things about that session are not obvious, and both were measured on 2026-10-30 against Pi
1.4.0.

**Discovery loads the runner into its own work session.** `pi-afk-runner` is a Pi package. Installed
globally it is discovered from the agent directory; in this repository it is discovered from
`.pi/settings.json`, which names `..`. A session created with `createAgentSession({ cwd,
resourceLoader })` builds an extension runner from whatever the loader discovered, so the extension
that starts runs is loaded into the session it started. Measured: sixteen extensions discovered in
this repository, one of them `./dist/extension.js`.

**A session that discovers nothing has no model.** The natural fix — `noExtensions: true` — was
measured too, and it closes the loop above: discovery finds only the guard. It also removes the
host's model providers, because on this host the provider *is* an extension
(`pi-commandcode-provider`, installed under the agent directory). Measured: `providers: []`, no
model to run on, and `pickModel` throws.

The guard has a third constraint of its own. `@gotgenes/pi-permission-system` reads its policy from
files and from nowhere else, at two scopes: the agent directory — which is the host's, process-wide,
and shared with every session a human has open — and the project, `<cwd>/.pi/…`, which here is the
worktree. A session with no policy at all resolves every unmatched call to *ask*, and an ask in a
session with no dialog is a **deny**, so the work session would do nothing.

And a fourth: **the guard never hears `session_start` in a session the SDK creates.**
`createAgentSession` builds the extension runner and binds the tool-call gate, but `session_start`
is the host's event, emitted by `AgentSession.bindExtensions`, which a host calls and the SDK does
not. Measured: with the guard loaded and no `session_start`, *every* tool call — `read .env`,
`read README.md` — comes back `{"block":true,"reason":"… requires approval, but no interactive UI
is available"}`, because the policy was never loaded and every call is an unmatched ask.

## Idea

Give the work session everything the host gives a session, and take away exactly one extension: the
one that starts runs. Put the guard's policy in the scope that belongs to the run — the worktree —
and keep it out of the commits.

## Decision

**The work session discovers the host's extensions and drops this package's own extension by
path.** `extensionsOverride` filters `dist/extension.js` (and its `src/extension.ts` sibling) out
after loading, before the session's extension runner is built; `noExtensions` is not used.

**The guard's policy is written into the worktree when, and only when, the repository carries
none.** `installGuardPolicy` writes `<cwd>/.pi/extensions/pi-permission-system/config.json` and adds
`/.pi` to the exclude file `git rev-parse --git-path info/exclude` reports — and it writes nothing at
all when that file already exists. The policy is the repository's protected paths and nothing else:
`*.env` and `*.env.*` denied, `*.pem` denied, `*.env.example` allowed again after them, everything
else allowed.

**The session is given its `session_start`.** `piSessionFactory` calls `bindExtensions({})` on the
session it creates, because an SDK session has no host to emit the event that extensions load their
own state on.

## Rationale

**Why not `noExtensions: true`.** It is the cleaner lever, and it is the wrong one: it is
indistinguishable from "this session has no providers" on any host whose provider is an extension.
The requirement is not "discover nothing", it is "the extension that creates sessions must not be
one of them", and `extensionsOverride` is the lever that says exactly that. The cost is that the
other discovered extensions still run in a work session — including the host's, which is what the
host expects of a session it created.

**Why not drop more.** Every other extension a work session loads is one the host chose to install.
Removing them would be the runner deciding which of the host's tools an agent may have, in a
session whose whole purpose is to work in the host's environment.

**Why the worktree and not the agent directory.** The agent scope is process-wide: a policy written
there would govern every session on the machine, and the runner would silently change what a human
can do in their own chat. The worktree is per-run and is thrown away with the run.

**Why an existing policy wins.** A repository that commits a guard policy has said what its policy
is; the project scope is the stronger one, and the runner overwriting it would be worse than
ignoring it. Git's exclude hides only **untracked** files, so an overwrite would be staged by the
runner's own `git add -A` and pushed in the pull request — the target's policy quietly replaced by
one it never chose. Measured before the fix: a fixture tracking
`{"permission":{"*":"deny"}}` came back `M .pi/extensions/pi-permission-system/config.json` and
stayed staged; after it, the file is untouched and `git status` is clean.

**Why the exclude and not `.gitignore`.** The runner commits the worktree with `git add -A`. A file
written into the worktree would land in the pull request — the guard's policy is not the issue's
work. Editing the target's `.gitignore` would be a change to the target; `info/exclude` is local
git metadata that is never committed and never pushed.

**Why a policy file at all.** The guard accepts no other kind. `deny` is also the wrong thing to
invent ourselves: `path` expands into `path_read` + `path_write` with its entries first, and a
`path` deny cannot be overridden by a per-tool allow — properties a hand-written tool-call hook
would have to reproduce.

**Why the patterns look like that.** The guard's wildcards are not path prefixes: `*` compiles to
`.*` and crosses `/`, the match is anchored, and the **last** matching entry wins. `**/.env` would
match an absolute path but not a bare one; `*.env` matches both. `.env.example` is the template the
target repository tracks and the work needs to read it, so it is allowed after the deny it is an
exception to.

Measured after the wiring, through the factory: `read .env` →
`{"block":true,"reason":"… Denied by policy: 'path_read' … (rule '*.env')"}`; `read .env.example`,
`read README.md` and `bash ls` → allowed.

## Consequences

- A work session is a session the host would recognise, minus the front door that started it. An
  extension the host installs loads into it; one that owns `input` could, in principle, interfere
  with the runner's prompts, and that is a host configuration risk rather than a runner one.
- The runner depends on discovery finding a provider. A host with no configured provider fails in
  `pickModel`, as before, with the same message.
- The worktree carries a `.pi/` directory that git does not see, for as long as the run lasts — unless
  the repository already had a policy, in which case that one is used untouched. The worktree itself
  is removed by `releaseRun`.
- The agent directory's shared exclude file gains `/.pi` on the first run in a checkout. It is
  local metadata: no commit, no push.
- The guard is named explicitly (`additionalExtensionPaths`) rather than relied on being discovered,
  so a target repository that does not list it still runs guarded — at the price of loading it twice
  when the host also lists it.
- A session created by the SDK must be given its `session_start`, or every extension that loads state
  there is inert. Any future code path that creates a session without `piSessionFactory` inherits
  that requirement.

## Links

- `src/guard.ts` — the policy, its installation, and the path of the guard's factory.
- `src/cli.ts` — `piSessionFactory`, the one place a work session is created.
- `src/extension.ts` — the live front door, and the status line a session remembers.
- `src/live.ts` — the status entry and the line.
- `docs/decisions/2026-10-30-the-afk-runner-is-a-pi-extension.md` — why the runner is a package Pi
  loads, which is what makes discovery a recursion hazard.
- `openspec/changes/afk-issue-agent-pipeline/tasks.md` (T010, in the target repository) — the task
  this decision serves.
