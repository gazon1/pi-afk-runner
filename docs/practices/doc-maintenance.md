# Documentation Maintenance Policy

This file defines when and how to write and update documentation for the Singularity Todo project.

---

## ADR Policy

### When to write an ADR

Write an ADR when:
- A new architectural decision is made (new port, new pattern, new platform)
- An existing pattern is changed or deprecated
- A technical approach was tried and rejected (record the rejection reason)
- A cross-cutting concern is introduced (DI, serialization, sync, etc.)

### When NOT to write an ADR

- Routine refactoring that doesn't change APIs or contracts
- Bug fixes with no architectural implication
- Pure code formatting or style changes
- Adding new features that follow existing patterns

### ADR template

```yaml
---
title: "<short descriptive title>"
date: 2026-MM-DD
status: accepted  # or: deferred | superseded | open
tags: [tag1, tag2]
supersedes: YYYY-MM-DD-slug  # optional
superseded-by: YYYY-MM-DD-slug  # optional
---
## Context

## Idea

## Decision

## Rationale

## Consequences

## Links
```

### Status values

Exactly these four. No ad-hoc values.

| Status | Meaning |
|---|---|
| `accepted` | Decision is implemented and current |
| `deferred` | Decision is postponed; revisit by date or trigger in Consequences |
| `superseded` | Replaced by another ADR; must have `superseded-by` |
| `open` | Under active discussion or implementation — avoid new `open` ADRs |

`archived` is a fifth value, used only for files under `docs/decisions/archive/`. It marks
a document that was never an architectural decision (a retro, audit, findings list or
triage list) and therefore has no status to resolve.

`status-was:` records the value an ADR carried before normalization, so a nuance like
"won't do" or "draft" is not lost when the value is mapped onto the vocabulary. On
2026-10-05, 13 ADRs using ad-hoc statuses (`noted`, `resolved`, `closed`,
`closed-wontdo`, `proposed`, `pending`, `draft`) were normalized this way.

### Rules

1. **DIGEST.md is derived, not a record**: it is auto-generated and gitignored, and it is a cache of the dated entries below it — never the source of truth. Never edit it by hand; run `scripts/refresh-decisions-digest.py` (which takes no arguments).
2. **No orphaned `superseded-by`**: If an ADR has `superseded-by`, the target ADR must exist
3. **No `open` ADRs older than 30 days**: If `open`, either resolve it to `accepted` or move it to `deferred` with a revisit trigger. Enforced by the shared gate registry (`scripts/ci/static-gates.sh`).
4. **All ADRs must have `status:`** from the vocabulary above: run `scripts/normalize-adr-frontmatter.sh` (report only) or add `--apply` to write. An unknown flag is a usage error, not a shrug.
5. **A new ADR is born `open`** and stays `open` until someone records a resolution. `open` is the only defensible birth state: a decision nobody has argued about yet has not been made. Set a terminal status at write time only when the evidence already exists. Declared as `frontmatter.newAdrStatus` in `config/docs/adr-corpus.json`; the writer reads it rather than hardcoding it (#518).
6. **The frontmatter contract is declared, not owned by a writer.** Keys, key order and the birth status live in `config/docs/adr-corpus.json`. `AdrStorage.writeAdr` and `updateAdr` refuse a key outside the allowlist rather than writing a file `normalize-adr-frontmatter.py` will later reject as structurally broken. Adding a frontmatter key means editing that one JSON file (#518).
7. **Deleting or moving an ADR requires the reference gate**: run `python3 scripts/check-adr-references.py` first. A dated-ADR slug cited in prose carries no path, so `check-doc-dead-refs.py` cannot see it.

---

## KDoc Policy

### Minimum KDoc requirements by category

| Category | Class-level KDoc | Method-level KDoc |
|---|---|---|
| `expect/actual` declarations | Required | Required |
| Public repository interfaces | Required | Required |
| Public port interfaces | Required | All methods |
| ViewModels | Required | No |
| Use cases with business rules | Required | For public methods |
| Data class / sealed class state | No | No |

### KDoc style

- **"Why, not what"**: describe the purpose and semantics, not the implementation
- **No `@author` / `@version`**: legacy Javadoc baggage
- **Use `@see`** for cross-references to related types
- **Inline code** in backticks: `ClassName.methodName()`
- **No restating the obvious**: `/** Returns the list size. */` is noise

### Good example

```kotlin
/**
 * Port for filesystem operations — platform boundary.
 *
 * JVM: backed by `java.io.File`. Android: backed by `context.filesDir`.
 * All operations are best-effort atomic — see `writeBytes` for crash-safety notes.
 */
interface FileSystem {
    /**
     * Reads entire file into memory. A missing path raises the platform's exception.
     */
    suspend fun readBytes(path: String): ByteArray
}
```

---

## Source tree documentation

`ARCHITECTURE.md` §1 (package maps) must be kept in sync with actual code. Run:

```bash
python3 scripts/print-source-tree.py > /tmp/source-tree.md
# diff /tmp/source-tree.md against ARCHITECTURE.md §1
```

This is automated by `just docs-audit`.

---

## OpenSpec Change Policy

Behavioural changes follow the OpenSpec artifact lifecycle (`proposal → specs → design → tasks →
apply → verify → archive`). The `openspec-workflow` skill (`singularity-todo-openspec-workflow`)
governs the full process. This section resolves conflicts between OpenSpec and other policies.

### Resolution rules

| Conflict | Resolution |
|---|---|
| ADR vs spec | Both are written: ADR for the architectural decision, spec for the behavioural surface. Never duplicate ADR reasoning into a spec. |
| `skip_specs` vs `doc-maintenance.md` | `skip_specs` in `openspec/config.yaml` takes precedence for OpenSpec changes. Bug-fix PRs, dependency bumps, doc-only changes, and use cases that follow an existing pattern are exempt from OpenSpec even if they touch behaviour. |
| OpenSpec `verify` gate vs `just docs-audit` | Both must pass. `openspec validate --all --json --strict` is the verify gate; `just docs-audit` runs the doc hygiene checks. Neither waives the other. |
| Skill reference vs spec | Specs must not describe Kotlin/Koin/Compose/ViewModel/DAO names. Skills may describe them. The `check-doc-dead-refs.py` detector 8 (`skill-dangling-symbol`) guards skills, not specs. |
| `design.md` requirement | Required only for cross-cutting changes, new architecture, new data models, or security-sensitive surfaces. Not required for straightforward feature specs. |

### When a spec is required vs a skip

Use the `skip_specs` table in `openspec/config.yaml`. A change that modifies observable behaviour
requires a spec; a change that doesn't (bug fix, test-only, rename, dependency update, doc-only)
does not. Architecture changes always require both an ADR and a spec.

### Spec naming

- `proposal.md` — one coherent change, no duplication of existing ADR content
- `spec.md` — observable behaviour only; SHALL/MUST requirements; every requirement has ≥1 scenario
- `design.md` — architecture and risk only; references ADR by slug, never copies it
- `tasks.md` — one task per module; every behavioural change has a test; no speculative refactoring

```bash
# Full audit (dry-run)
just docs-audit

# Normalize frontmatter (apply changes)
./scripts/normalize-adr-frontmatter.sh --apply

# Refresh DIGEST
./scripts/refresh-decisions-digest.sh

# Check for stale open/deferred ADRs
grep -r "status: open\|status: deferred" docs/decisions/
```

---

## How to write documentation

Added 2026-10-15. These are the rules for *writing*; the sections above decide *whether*
to write an ADR and how big a file may get.

**Document only what would surprise an experienced engineer.** If a reader who knows
Kotlin, Gradle and this codebase already knows it, it does not belong in a document.
The corpus that earns its place is the stuff that is true here and nowhere else — which
port was deleted and why, which budget is deliberately tight, which invariant a test
enforces that the types do not.

**Prefer descriptive filenames.** Filenames are the index. `docs/architecture/sync.md`
is found by looking at the tree; a skill called `singularity-todo-sync` had to be
discovered through a description that could be truncated out of context. If you cannot
name a file after what a reader would search for, the file is probably two files.

**Assume the reader can `grep` and follow links.** Do not restate what another document
already says — name it and move on. Duplicated prose is a second copy to keep in step,
and it drifts silently, which is worse than being absent.

**Refer to documents by filename in backticks**, e.g. `sync.md`, and by a repo-relative
path when the name is ambiguous, e.g. `docs/architecture/sync.md`. This is not style:
`scripts/check-doc-dead-refs.py` resolves backticked paths, so writing them is what lets
a renamed file be caught. Markdown links and `../` paths are not resolved by that gate,
which is why they are not used here.

**A skill is a procedure; a document is a state.** A skill answers "what do I do" and
should survive refactors. A document answers "how does this work now" and is expected to
be updated in the same commit as the code it describes. Moving a document into a skill
because it grew a procedure section is the signal it was a document.

**No manual line wrapping** is *not* a rule of this repository. `.editorconfig` sets
`max_line_length` for `kt`/`kts` only, and Markdown here is written at a comfortable
reading width.

**Tables are allowed**, and are the right tool for "key → where it lives → what opens
it". `docs/navigation.md`, `docs/PLATFORM-REFERENCE.md` and the generated
`docs/scripts/gate-registry.md` all depend on that shape.

## Retired skills

Removed from `.agents/skills/`. Each has an ADR naming it; do not resurrect one without
reading that ADR first.

| Skill | Why it is gone | ADR |
|---|---|---|
| `koin-suspend-bridge` | Koin 4 has no suspend bridge problem left to solve | `2026-09-05-koin-suspend-bridge` |
| `ai-provider-settings` | provider settings moved into a different module | `2026-09-05-llm-provider-settings` |
| `secret-migration` | secret storage split into two ports | `2026-09-05-secret-storage-split` |
| `koog-test-workarounds` | workarounds replaced by the Koog upgrade | `2026-09-05-koog-test-workarounds` |
| `koog-both-platforms` | superseded by `singularity-todo-kmp-platform-specific` | `2026-09-05-koog-both-platforms` |
| `vm-koin-scoping` | `viewModelOf` + `koinViewModel` made the guidance wrong | `2026-09-27-vm-koin-scoping-retired` |
| `koin-di` | split into `koin-dsl` and `di-graph-testing` | `2026-09-27-di-module-aggregator-narrative` |
| `grill-me` | renamed to `grilling` | `2026-10-01-tech-debt-reconciled` |
| `grill-with-docs` | renamed to `grilling` | `2026-10-01-tech-debt-reconciled` |
| `task-snapshot-testing` | Roborazzi never integrated; notes superseded | `2026-09-30-roborazzi-not-built-superseded` |
| `kiwi-tcm-stand` | infra/kiwi/ was local-only, never committed; skill pointed to non-existent infra | `2026-10-15-kiwi-tcms-stand-retired` |
| `sync`, `notifications`, `mcp-server`, `kmp-platform-specific` | described code state, not a procedure — now documents | `2026-10-15-reference-skills-become-documents` |

---

## Top-level docs

| File | Purpose | Who maintains |
|---|---|---|
| `AGENTS.md` | Agent cheatsheet (auto-loaded) | All contributors |
| `ARCHITECTURE.md` | Full design doc | All contributors |
| `CODING_STANDARDS.md` | Judgement rules a reviewing agent applies (read at review, not at implementation) | All contributors |
| `README.md` | Project intro + quickstart | All contributors |
| `docs/architecture/*.md` | How each subsystem works *now* | Whoever changes it |
| `docs/decisions/DIGEST.md` | Auto-generated orientation layer | `refresh-decisions-digest.sh` |
| `docs/decisions/DIGEST-full.md` | Auto-generated decision index | `refresh-decisions-digest.sh` |

Update these when:
- New feature adds a new package or expect/actual declaration
- DI pattern changes
- Build commands change
