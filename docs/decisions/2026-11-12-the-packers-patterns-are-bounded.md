---
title: The packer's patterns are bounded
status: accepted
date: 2026-11-12
authors: MiniMax Code
deciders: Singularity Developer
tags: [tools, repomix, dependencies, pack, security]
---

# The packer's patterns are bounded

## Context

The runner packs the repository with [repomix](https://github.com/yamadashy/repomix),
and repomix matches the files with [minimatch](https://github.com/isaacs/minimatch).
Repomix 1.18.1 asks for `minimatch@^10.2.6`, and minimatch 10.2.6 is covered by
[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249): a denial of
service through glob-parts amplification. The matcher's second phase compares every
part of a pattern with every other part of it, so a pattern with many parts makes the
matcher work — and the work is done once per pattern, against every file in the
repository. The fix is in minimatch 11.0.1, which caps the parts it compares.

`npm audit fix` cannot reach it: repomix asks for `^10`, so the fixed version is
outside the range npm may install.

The patterns are not a hypothetical input either. The `include` and the `ignore` of
the pack are the agent's own strings, and they are what the matcher parses. A pattern
chosen to make the matcher run away runs on the runner's host, in the run, with the
run's privileges.

## Idea

- **Pin the fixed matcher.** An npm override puts minimatch 11.0.1 under repomix, and
  the runner's own tree carries no advisory.
- **Bound the patterns.** The runner refuses a pattern that is too long, that names too
  many path segments, or whose braces hold too many alternatives — before the matcher
  sees it.
- **Say what the runner does about it.** The dependency is pinned, and the bound is
  written down where the patterns are read.

## Decision

**The runner pins the fixed matcher.** `package.json` overrides `minimatch` to `11.0.1`
for the whole tree. Repomix imports the matcher as `minimatch` — the same named export
the fixed version has — so the override changes the version and not the interface.
The lock is regenerated with it.

**The patterns are bounded in the runner.** `src/packing.ts` holds the bound: a pattern
may be at most 512 characters long, may name at most 64 path segments, and its braces
may hold at most six alternatives, summed over its groups; a list may hold at most 32
patterns and may expand into at most 256 of them. The tool refuses a pattern that is
out of the bound and says why, and the packer refuses it too — it is the one that
hands the patterns to the matcher, and the tool's own list of the files the policy
refuses is added to the agent's.

**The decision is recorded here**, because the choice was between two reasonable
outcomes — pin the dependency and trust the matcher, or bound the input as well — and
because an override outside the range a dependency declares is a workaround a reader
would otherwise have to reverse-engineer.

## Rationale

**Why the matcher is pinned.** The advisory is in the runner's own dependencies, and it
is in the tree the runner chose: the packer is the runner's dependency, and the
patterns are the runner's input. `npm audit fix` cannot reach the fixed version, so
the override is the way to reach it.

**Why the patterns are bounded too.** The pin is the fix; the bound is the runner's own
answer to what it hands to a matcher. The agent names the patterns, and the runner
does not read them before the matcher does. A bound that is checked where the patterns
are read is a bound that holds whatever the matcher does with them.

**Why the bound refuses rather than truncates.** A truncated pattern is a pattern the
agent did not ask for: it packs files the agent did not name, or misses files it did.
A refusal says what happened and lets the agent ask again with a narrower pattern.

**Why the bound is generous.** The bound is not there to make ordinary patterns
awkward: 512 characters, 64 path segments and 32 patterns are far above what an agent
writes, and far below the regime where the matcher's work runs away. The parts of a
pattern are what multiply — the braces and the path segments — and those are the axes
the bound holds.

## Consequences

- **Files:** `package.json` overrides the matcher and `package-lock.json` carries it;
  `src/packing.ts` holds the bound and refuses what is out of it; `test/packing.test.ts`
  holds the bound to what it takes.
- **The runner's tree carries no advisory from the packer.** `npm audit --omit=dev`
  reports the `undici` advisories and nothing else — those are a separate matter.
- **Repomix still packs.** The packer is the same library at the same version; only
  the matcher underneath it is the fixed one.
- **A pattern out of the bound is refused.** The agent is told that the pattern is more
  than the matcher takes, and it may ask again with fewer or shorter patterns.
- **The override is outside the range repomix declares.** A future repomix that asks
  for minimatch 12 will need the override moved, and the record says why it is there.

## Links

- `package.json` — the override.
- `src/packing.ts` — the bound, and the refusal.
- `test/packing.test.ts` — the bound, held to what it takes.
- [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) — the advisory.
- `docs/decisions/2026-11-09-the-pack-drops-the-grammars-it-cannot-use.md` — the other
  half of the packer's dependencies, and what the install does with them.
