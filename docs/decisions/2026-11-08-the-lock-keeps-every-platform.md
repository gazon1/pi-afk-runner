---
title: The lock keeps every platform's optional packages
status: accepted
date: 2026-11-08
authors: MiniMax Code
deciders: Singularity Developer
tags: [dependencies, lock, ci, npm]
---

# The lock keeps every platform's optional packages

## Context

Two gates install this repository the way it was reviewed: CI runs `npm ci`, and the
worktree setup of a checkout of this repository runs it too. `npm ci` installs exactly
what the lock holds, and it refuses when the lock and the manifest disagree.

The disagreement is easy to make and hard to see. A package with optional dependencies
for several platforms — `lightningcss`, `@oxlint/binding-*`, `@rolldown/binding-*`,
`fsevents` — names every platform in its manifest, and the lock is expected to carry an
entry for each of them, including the ones that will never be installed on the machine
that wrote the lock.

A lock resolved from nothing on one machine keeps only the entries that machine can
use. The lock then looks complete — every package the manifest names is in it — and
`npm ci` refuses with `Missing: lightningcss-android-arm64@1.33.0 from lock file` and
thirty-nine more names. A run that hits it fails in the worktree step, before the agent
sees the issue.

## Idea

Keep the lock as the record of every platform, and regenerate it on top of the lock
that is already there rather than from nothing.

## Decision

**The lock carries an entry for every optional package every platform names.** The
entries for the platforms that are not this machine's are in the lock, marked optional
and carrying their own `os` and `cpu`.

**The lock is regenerated on top of the existing one.** `npm install --package-lock-only`
over the committed lock keeps the platform entries it already has. A lock resolved from
nothing does not have them, and npm does not add them back: the resolver builds the tree
for the platform it runs on, and the other platforms' entries are not part of that tree.

**`npm ci` in a clean directory is the check.** A lock that installs here and nowhere
else is not a lock this repository can be built on.

## Rationale

**Why the other platforms are in the lock.** The optional dependency is named by the
manifest, and `npm ci` compares the manifest with the lock. A lock that holds only this
platform's entry says "the manifest names lightningcss for android" and "the lock has no
lightningcss for android" — and the gate that installs the repository reads exactly
that.

**Why the lock is regenerated on top of the old one.** npm's resolver builds the tree
for the platform it runs on. The entries for the other platforms are kept because they
are in the lock already, not because the resolver decided to add them.

**Why `npm ci` is the check.** `npm install` succeeds on the machine that wrote the lock
even when the lock is missing the other platforms: it installs what this platform needs
and adds nothing. `npm ci` is the gate that refuses, and it is the gate CI runs.

## Consequences

- **Files:** `package-lock.json` carries the platform entries again.
- **A dependency is added by regenerating the lock over the committed one**, not by
  deleting it. A lock resolved from nothing is a lock for this machine only.
- **The gate is `npm ci` in a clean directory** — the command CI runs, and the command a
  worktree of this repository runs.
- **The lock is the record of what every platform installs**, not of what this machine
  installs.

## Links

- `package-lock.json` — the lock.
- `.github/workflows/ci.yml` — the gate that runs `npm ci`.
- `scripts/setup-worktree.sh` — the worktree's own install.
