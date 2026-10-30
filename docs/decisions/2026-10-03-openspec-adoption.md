---
title: "OpenSpec adoption — capability specs as the behavior source of truth"
date: 2026-03
status: accepted
tags: [process, docs, tooling]
---

## Context

The project has a mature documentation infrastructure: 414 ADRs, auto-generated `DIGEST.md`,
`PROGRESS.md` (420 lines, 3 epics), 97 skills, 4 CI workflows, 18 maintenance scripts.
No OpenSpec tooling exists in the repository.

ADRs answer **"why did we choose this architecture?"**
PROGRESS answers **"where are we in this epic?"**
Skills answer **"how do I do this type of work?"**

No artifact answers: **"what observable behavior does the system do today, and how do we
prove that a change implements what it promises?"**

## Decision

Adopt OpenSpec as the canonical source of truth for observable system behavior.

### What OpenSpec answers

> **What behavior is changing, and how do we prove it is implemented?**

Not: why the architecture is this way (ADR), where in the epic we are (PROGRESS),
how to perform an operation (skill).

### Ownership matrix

| Question | Source of truth |
|---|---|
| What should the system **do**? | `openspec/specs/` |
| What are we **changing now**? | `openspec/changes/` |
| Why is the architecture this way? | `docs/decisions/*.md` |
| How do I perform this task? | `.agents/skills/` |
| Where are we in this epic? | `PROGRESS.md` |
| What did we learn after work? | ADR Consequences → `DIGEST.md` |
| What terms do we use? | `docs/CONTEXT.md` |

### When to write an OpenSpec change

```
Does the change affect observable user/system behavior?
├── No → ordinary PR (or skip_specs: true for tooling/refactor/docs)
└── Yes → OpenSpec change
         └── Does it change architecture?
              ├── No → spec only
              └── Yes → spec + ADR (ADR answers "why", spec answers "what")
```

**Exceptions (no spec needed):**
pure refactor, package move, rename, dead code removal, formatting,
CI tooling changes.

### skip_specs reference table

| Change type | OpenSpec spec needed |
|---|---|
| New or changed user-visible behavior | ✅ |
| Changed API contract | ✅ |
| Changed sync semantics | ✅ |
| Changed database migration behavior | ✅ |
| Changed UI behavior | ✅ |
| Bugfix that changes observed behavior | ✅ |
| Pure refactor | ❌ `skip_specs: true` |
| Package move / rename | ❌ `skip_specs: true` |
| Dead code removal | ❌ `skip_specs: true` |
| Formatting / CI tooling | ❌ `skip_specs: true` |
| Trivial bugfix, no behavior change | ordinary PR, no change needed |

### What goes in a spec

- Observable behavior only. No Kotlin/Koin/Compose/ViewModel/DAO names.
- SHALL/MUST for normative requirements.
- Every requirement has ≥1 testable scenario (WHEN/GIVEN … THEN …).
- For a **baseline spec**: describe what the code does TODAY, not what it should do.
  The point is to document reality, not to spec the ideal.

### What goes in a design

Required only for: cross-cutting concerns, new architecture, data-model changes,
security decisions, migration risk.

Design **references** existing ADRs by path. It does **not** restate them.
Architecture rationale stays in ADR; design applies it to this specific change.

### What goes in tasks

- Every behavior change has a corresponding test task.
- Each task names the feature/module it touches.
- No speculative refactoring tasks.

### Before creating a change: the mandatory read order

1. Read the **real source code** — not grep, not roadmap, not a skill.
2. Run `openspec list --specs` and inspect existing capabilities.
3. Read `docs/CONTEXT.md` for canonical vocabulary.
4. Read `docs/decisions/DIGEST.md` for active constraints.
5. Inspect relevant ADRs and skills.
6. **Only then** create the change.

This order is not ceremonial. Plans built from grep and old roadmaps have been
wrong — the `card-level-ai-actions` ADR documents this failure mode explicitly.
OpenSpec does not fix wrong plans; it makes them cheaper to verify.

### Design is optional; never skip it when genuinely needed

Do not create a `design.md` for every change. It is required only for
cross-cutting/new-architecture/data-model/security changes.

For a small bugfix: `proposal + spec + tasks`.
For a large feature: `proposal + spec + design + tasks`.
For an architectural change: `proposal + spec + design + tasks + ADR`.

### Verify before declaring done

The `verify` step is not optional. It confirms that implementation artifacts match
the change spec. Without it, a change is only half-done.

## Rationale

The gap between "planned change" and "verified implementation" is where features land
that compile, have tests, and do not do what was promised. The write-pipeline work
(Phase 0, MR 0.1–0.7) demonstrated that having a machine-checkable behavioral spec
(Combined with Konsist arch tests, `EntityMapperCompletenessTest`, and
`FakeRepositoryFidelityTest`) catches drift that code review and unit tests miss.

OpenSpec formalizes this pattern at the process level: proposal → spec →
design → tasks → apply → verify → archive.

The ownership matrix above is deliberate. OpenSpec does **not** replace ADRs,
skills, PROGRESS, or the DIGEST. Each answers a distinct question.

## Consequences

- **Always** create an OpenSpec change before modifying observable behavior.
- **Always** run `openspec list --specs` before creating a proposal; do not
  create near-duplicate capabilities.
- **Never** duplicate ADR architectural rationale in a spec — `design.md` references
  the ADR, the spec describes behavior.
- **Never** describe implementation classes (Kotlin, Koin, Compose, ViewModel,
  DAO) in a spec — only observable behavior and scenarios.
- **Always** write a baseline spec from actual code behavior, not from the
  intended design.
- **Always** verify implementation against the final spec before marking tasks
  complete.
- **Never** skip `verify` even when the change feels obvious.
- **Always** use `skip_specs: true` for mechanical/tooling changes that do not
  alter system behavior.
- **Always** update `PROGRESS.md` after archiving a change (progress-journal skill).
- OpenSpec changes are reviewed **before** code, not after.
- The writer/reviewer pattern (ADR process) extends to OpenSpec: the reviewer
  challenges assumptions, edge cases, scope, and architecture before a line of
  code is written.

## Links

- OpenSpec documentation: https://openspec.dev/
- Skill: `singularity-todo-openspec-workflow`
- Skill: `singularity-todo-decisions-workflow`
- Related: `2026-09-27-write-layer-soundness` (write-pipeline behavioral contracts)
- Related: `2026-10-03-post-merge-debt` (the gap this fills)
