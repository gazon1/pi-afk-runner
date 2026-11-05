---
title: The gates are a toolchain and one command
status: accepted
date: 2026-11-05
authors: Command Code
deciders: Singularity Developer
tags: [gates, ci, toolchain, formatter, secrets, dependencies]
---

# The gates are a toolchain and one command

## Context

The repository had four checks — typecheck, lint, test, build — and one command that ran
them. That command was the right shape, and CI did not use it: the workflow repeated the
four steps by hand and then checked the built entry points. A fifth step added to one side
and not the other was a difference nobody would see.

Around those four checks the repository had nothing. No formatter, so style was whatever
the last edit left. No dead-code or unused-dependency check, so an export could outlive
its caller for months — Knip found one whole function, `restoreWorktree`, that had been
unused since the Pi extension was removed. No secret or vulnerability scan, in a
repository whose runs carry provider credentials. And the two workflow actions were
pinned by tag, not by commit: a tag can move.

## Idea

One toolchain file, one command, and CI runs that command. Every check the repository
declares fails the build on a violation; the checks that need data from outside the
repository run on a schedule as well as on a pull request.

## Decision

**The toolchain is `mise.toml`.** It pins Node 22 and the binaries npm does not install:
jactionlint 2.4.0, OSV-Scanner 2.7.0 and Betterleaks 1.9.0. CI installs the file and runs
the same versions a developer does; the mise action is pinned by commit and the mise binary
by version, so the installer cannot change under the gate either.

**The aggregate is `./check.sh`.** It runs `npm run check` — typecheck, lint, the format
check, Knip, the tests and the build — and then `jactionlint --strict-exit`. CI calls the
same script. `npm run check` stays as the fast subset for a change that does not touch
`.github/`.

**The code we own is formatted by oxfmt.** The scripts pass the code paths —
`src/**/*.ts`, `test/**/*.ts`, `scripts/**/*.mjs` and the root JSON — so the copies
(`contract/`, `docs/practices/`, `skills/`, `pipelines/`), every Markdown file and every
workflow are out of reach. A copy is fixed upstream and copied again; formatting one here
would make the next copy a conflict. `npm run format` writes, and the gate runs
`oxfmt --check` over the same paths. `package.json` keeps its own key order
(`sortPackageJson: false`): the formatter sorts it otherwise, and a manifest reorder is
noise in every later diff.

**Knip owns dead code.** Its configuration keeps exports used inside their own file and
ignores the `flock` binary, which is a host command and not an npm package. Its first run
removed `restoreWorktree`, `hasMastraKey`, `DECISION_STATES`, `RunnerState`, two sentence
helpers and eleven aliases: code that no caller had named.

**jactionlint owns the workflows and `dependabot.yml`.** It is run with `--strict-exit`,
because a warning that exits 0 is not a gate. Its first run pinned both actions to commit
SHAs and found three things the workflows were missing: a job timeout, a concurrency group
on the label-cleanup workflow, and permissions granted at the workflow level instead of
the job.

**The scans that need the network are their own workflow.** `security.yml` runs
OSV-Scanner over `package-lock.json` and Betterleaks over the git history on every pull
request and weekly. They are not part of `./check.sh`: the merge door runs that script on
a host, and a vulnerability database or a network hiccup must not decide whether a branch
lands. Their data changes without a commit, which is why the schedule exists.

**Dependabot keeps the dependencies current**, with a seven-day cooldown so a compromised
release has less chance of being proposed before it is known. The repository is on GitHub
and has no monorepo, so Renovate's extra configuration buys nothing here.

**A check is never turned into a warning.** Where a tool exits 0 on a finding — jactionlint
warns by default — the gate passes the flag that makes it fail.

## Rationale

The tools are the ones the development quality gates list recommends for this stack. The
list's own rule is to keep what already works: TypeScript with `strict` and `tsc --noEmit`,
and oxlint with `--deny-warnings`, are the recommended entries and were already here.

The formatter is the largest diff, and it is a separate commit for that reason: it changes
no behaviour, and a reviewer should be able to read it as one mechanical change. The dead
code is a separate commit too, so a bisect points at the tool that found it rather than at
the tool that formatted the line.

The split between `./check.sh` and `security.yml` follows what each check depends on. A
check that needs the network is not deterministic, and a deterministic gate is what the
merge door needs. A check whose data changes on a schedule is run on a schedule.

## Consequences

- A change is done when `./check.sh` passes, and CI runs the same script. The two cannot
  drift the way the step-by-step workflow could.
- A developer needs `mise install` before the gate can run; `check.sh` says so and exits
  non-zero rather than skipping jactionlint.
- The copies under `contract/`, `docs/practices/`, `skills/` and `pipelines/` are not
  formatted or linted here. A finding in one is a finding in the target repository.
- Knip fails on a new unused export; a real one is deleted, and a false positive is one
  narrow ignore with a reason.
- A new advisory fails `security.yml` without a commit on our side. That is the point of
  the schedule, and it is not a reason to pin an old lockfile.
- Betterleaks is young (created in 2026) and is pinned to 1.9.0 — the newest 1.x that
  mise's release-age floor will install today; 1.10.0 is inside that window. A move to
  2.x is its own change.
- oxfmt is pre-1.0. A release that changes the layout is a formatting commit, not a
  combined one.

## Links

- `.github/workflows/ci.yml` — the job that installs the toolchain and runs `./check.sh`.
- `.github/workflows/security.yml` — OSV-Scanner and Betterleaks, on pull requests and
  weekly.
- `.github/dependabot.yml` — npm and GitHub Actions, weekly, with a seven-day cooldown.
- `check.sh` — the aggregate gate.
- `mise.toml` — the pinned toolchain.
- `knip.json` — the configuration that keeps Knip to the repository's own code.
- [Dev Quality Gates](https://github.com/mokevnin/dev-quality-gates) — the list, its
  adoption guide and its setup patterns.
