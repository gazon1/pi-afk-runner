---
title: The pack drops the grammars it cannot use
status: accepted
date: 2026-11-09
authors: MiniMax Code
deciders: Singularity Developer
tags: [tools, repomix, dependencies, pack]
---

# The pack drops the grammars it cannot use

## Context

The runner packs the repository with [repomix](https://github.com/yamadashy/repomix),
and repomix depends on `@repomix/tree-sitter-wasms`: seventeen WebAssembly grammars,
about twenty-four megabytes, and with them a tree of about a hundred megabytes that
every host installs.

The grammars are the compression. Repomix can rewrite a file into a compact form — it
strips the comments, and it can reduce a file to its structure with a tree-sitter pass
over the language's grammar. The runner does not offer that pass: the target repository
is written in Kotlin, and repomix has no grammar for Kotlin among the seventeen it
ships, so the pass would do nothing to the files the target is made of.

So the runner installs twenty-four megabytes of grammars it never reads, for a language
it does not work on. Repomix reads a grammar only when the compression is asked for, so
nothing in the runner's path ever loads a `.wasm`: the weight is what the install
downloads and what the host stores, and never what the runner runs.

## Idea

Take the grammars out of the installed tree.

- **Drop them at install.** An install step removes them after npm has put them there.
- **Fetch them when they are needed.** Repomix reads a grammar from disk when the
  compression is asked for; there is nothing to fetch — the package is either there or
  it is not, and npm has no way to leave out a dependency that is not optional.
- **Keep them and say so.** The weight stays, and the operator is told what it is and
  why.

## Decision

**The install drops the grammars.** `scripts/prune-grammars.mjs` runs after the install
and removes the grammars from the installed tree. It never fails the install: a host
that keeps the grammars has the runner it had before, and a host that loses them has a
runner that never asks for one. The tarball is still fetched — npm installs a regular
dependency — and what the host keeps afterwards is the tree without the grammars.

**The pack asks for neither the compression nor the comment removal.** The packer is
given `compress: false` and `removeComments: false` explicitly, so the pack holds the
files as they are rather than by repomix's default. The reason is written down where
the option is dropped, in `src/packing.ts`: the compression covers the languages
repomix has a grammar for, and Kotlin is not one of them.

**The decision is recorded here**, because the choice was between two reasonable
outcomes — take the weight off the host, or state it — and because the install step is a
workaround a reader would otherwise have to reverse-engineer.

## Rationale

**Why the grammars go.** The runner's own cost is what an operator pays on every host.
A packer that cannot compress the target's language brings a weight the runner cannot
use, and the runner is the only one who can drop it: repomix cannot, and the target
repository is not the runner's to change.

**Why the install step and not the dependency.** Repomix names the grammars as a
regular dependency, and npm installs a regular dependency. There is no manifest that
leaves it out, and repomix at 1.18.1 is the newest release there is. The grammars are
read only when the compression is asked for, so removing them from the installed tree
changes nothing the runner does.

**Why the compression stays off rather than becoming an option.** A compression that
does nothing for Kotlin would hand the agent a file that is not the file, for no gain.
The runner's pack is a read: the files go into the context as they are.

## Consequences

- **Files:** `scripts/prune-grammars.mjs` is added and runs from the manifest's
  `postinstall`; `package.json` ships it; `src/packing.ts` states the compression
  decision where the option is dropped; `test/packing.test.ts` packs a Kotlin file and
  holds it as it is.
- **The grammars are not installed.** A host that installs with `--ignore-scripts` keeps
  them; the runner works either way.
- **The compression is off, and stays off.** A future change that wants it needs a
  grammar for Kotlin, and repomix does not have one.
- **The pack holds the files as they are** — no comment stripped, no file reduced to
  its structure.
- **The lock is unchanged.** No dependency was added, removed or replaced, so `npm ci`
  installs what it installed before.
- **The consequence of 2026-11-07 that said the grammars come with the dependency is
  replaced by this record.** The rest of that record — the pack as a tool, the
  repository's config skipped, the policy applied to the pack, the bounded pack —
  stands.

## Links

- `scripts/prune-grammars.mjs` — the step that drops the grammars.
- `src/packing.ts` — the packer, and the decision written where the option is dropped.
- `test/packing.test.ts` — the Kotlin file the pack holds as it is.
- `docs/decisions/2026-11-07-the-repository-is-packed-for-the-agent.md` — the pack
  itself; the clause that said the grammars come with the dependency is superseded
  here.
