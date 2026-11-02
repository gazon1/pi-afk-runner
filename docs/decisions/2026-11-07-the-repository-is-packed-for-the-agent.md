---
title: The repository is packed for the agent, and the pack is the runner's own
status: accepted
date: 2026-11-07
authors: MiniMax Code
deciders: Singularity Developer
tags: [tools, context, guard, repomix, session]
---

# The repository is packed for the agent, and the pack is the runner's own

## Context

The agent reads the repository one file at a time. That is the right shape for
a file it knows it wants, and the wrong shape for a repository it has never
seen: the triage turn has to know whether the behaviour the brief names is
already there, the scope turn has to know how far the acceptance criteria
reach, the brief turn has to read the rules of a repository it knows nothing
about, and the reviewer has to read the code a diff touches. Each of those
turns opens files one by one, pays for every file in the context, and finds
the same part of the tree over and over.

[Repomix](https://github.com/yamadashy/repomix) packs a repository into a
single document — the file tree, the files' contents, and the token count of
both — in one call. It is a Node package with a CLI, a library and an MCP
server.

## Idea

Give the agent a tool that packs the repository it works in, and let the turns
that read the repository use it.

## Decision

**The pack is a runner tool: `agent_pack_codebase`, in `src/packing.ts`.** It
is described like every other tool — the description in the runner's own terms,
the engine's object built over it — and the work session and the review session
carry it. It is a working tool and not a decision, so it does not live in
`src/decisions/`: it does not end a turn, it hands the model a document.

**Repomix is used as a library.** Not as a command: the runner holds the
options, and the command would hold them in a file the worktree has to carry.
Not as an MCP server: a server is a process per session and a second seam
between the runner and the engine, and the only thing it would add is a way to
call the same packing.

**The pack is the runner's, not the repository's.** Repomix loads a
`repomix.config.*` from the directory it packs, and a config is code: a `.ts`
config is executed, and `input.processors` runs commands. The repository being
packed is not the runner's own, so the pack skips the local and the global
config and never runs a processor. What is packed is the runner's own options
over the runner's own rules.

**The pack is of the worktree, and of nothing else.** Repomix reads a
two-segment name as a repository on GitHub and fetches it when no such
directory is here, so the runner hands it a directory that is here: the
worktree's own, by its absolute path. A path that is not in the worktree is
refused before anything is packed, and nothing is fetched from the network.

**The pack is what the guard would allow.** The pack hands files to the model
the way a read does, so the files the policy refuses — the ones nobody hands to
an agent — are not in it. The policy is asked the question the guard asks, in
one place: `src/guard.ts` holds the rules and the decision on them, and the
guard, the runner's commit path and the pack all ask it there. A pack that
holds a refused file is made again without it, and a pack that still holds one
is refused.

**The pack goes to a temporary file, never to the worktree.** The tree the
agent leaves is the tree the runner pushes, and a pack file left in it would
ride along with the change.

**The pack is bounded.** The document goes into the model's context next to the
brief, the diff and the conversation. Above sixty thousand tokens the tool
refuses and says how to pack less: one directory, or the tree alone. The
document is not read into memory when it is over that line: the packer knows
the count before the document is carried, and refuses there.

**The paths in the document are the repository's own.** Repomix writes the
paths relative to the packed directory by default; the pack asks for the paths
relative to the repository's root, so the agent knows where the files are and
the policy can be asked about them.

## Rationale

**Why the library.** The command is a way to hold options in a file, and the
file would land in the tree the runner pushes. The MCP server is a second
process and a second seam for a tool that does one thing.

**Why the repository's config is skipped.** The repository being packed is
somebody else's repository, and a config is code that runs when it is loaded.
The runner does not run a repository's code to read it; it certainly does not
run it in the middle of a run whose every other write is accounted for.

**Why the policy is applied to the pack.** The guard's path rules exist because
the files they cover are nobody's to hand to an agent. A pack that ignored them
would be a way around the guard for every file in the tree at once, and the
agent would not have to ask for it: one call would do it.

**Why the decision moved into `src/guard.ts`.** The rules were already there,
but the decision on them was written twice — once in the engine's adapter and
once in the runner's commit path — and the two copies were not the same: the
commit path read a rule that denies with a reason as a permission. One rule,
one decision, one spelling.

**Why the pack is of the worktree and of nothing else.** Repomix reads a
two-segment name as a repository on GitHub, and it fetches it when no such
directory is here — so a pack of the machine's imagination would have become a
download of somebody else's code, named by the model, into the model's
context. The runner hands repomix a directory that is here, and refuses the
names that are not.

**Why the pack is bounded.** The pack is a document the model has to carry for
the rest of the turn. A pack of a whole repository is often more than the
context holds, and a model that is cut off mid-pack has neither the document
nor the turn.

## Consequences

- **Files:** `src/packing.ts` is added, with `test/packing.test.ts` beside it;
  `src/session.ts` and `src/runner.ts` carry the tool; `src/guard.ts` holds the
  policy's decision, and `src/mastra/guard.ts` and `src/runner.ts` ask it there.
- **The prompts name the tool** where the agent has to read the repository:
  the triage, the scope, the brief, the implement, the verify and the review.
  The pack is a way to read, not a way to skip reading.
- **The runner depends on repomix**, pinned at 1.18.1. It brings the tree-sitter
  grammars with it — about a hundred megabytes of dependencies — and the
  compression it buys covers the languages repomix has a grammar for. Kotlin,
  which the target repository is written in, is not one of them, so the runner
  does not offer the compression: it would do nothing to the files the target
  is made of.
- **The pack is a read the model pays for.** It costs context, and the tool
  refuses the pack that would cost too much of it.
- **The pack is not the agent's only way to read a file.** The workspace's own
  tools still read one file at a time, and the guard still refuses what it
  refuses.
- **The pack never reaches the network.** Repomix can fetch a repository from
  GitHub; the runner's pack cannot.

## Links

- `src/packing.ts` — the tool, and the packer behind it.
- `src/guard.ts` — the policy, and the decision on it.
- `src/prompts/00-triage.md`, `src/prompts/00-scope.md`, `src/prompts/01-brief.md`,
  `src/prompts/02-implement.md`, `src/prompts/03-verify.md` — the turns that read the
  repository.
- `src/runner.ts` — the review prompt, and the review's own tools.
- [repomix](https://github.com/yamadashy/repomix) — the packer.
- `docs/decisions/2026-11-06-the-graph-runs-on-the-mastra-workflow-engine.md` — the
  other half of the agent's context: the states it moves through.
