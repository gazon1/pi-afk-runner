---
title: Docs Lifecycle
date: 2026-09-26
status: accepted
---

# Docs Lifecycle

## Context

The project produces three kinds of documentation:
- **ADR** (`docs/decisions/YYYY-MM-DD-slug.md`) — decisions about architecture, process, and trade-offs
- **Skill** (`.agents/skills/<name>/SKILL.md`) — executable knowledge: templates, checklists, decision trees
- **Prose docs** (`docs/*.md`, `ARCHITECTURE.md`, `AGENTS.md`) — human-readable guides

No policy governed when to create, update, or retire each kind. This led to orphaned skills, stale ADRs, and overlapping content.

## Decision

### ADR lifecycle

| Stage | When | Action |
|---|---|---|
| **proposed** | Author creates draft, opens PR | File name `YYYY-MM-DD-slug.md`, frontmatter `status: proposed` |
| **accepted** | PR merged to `main` | Author updates frontmatter to `status: accepted`, adds `date` |
| **deprecated** | Decision is outdated but referenced in code | Add `status: deprecated` + `Rationale` explaining why |
| **superseded** | A newer ADR replaces it | Add `superseded-by: YYYY-MM-DD-new-slug` + keep content; new ADR adds `supersedes: YYYY-MM-DD-old-slug` |
| **deferred** | Decision is intentionally postponed | `status: deferred`; no `date`; add `Context` section explaining what would unblock it |

An ADR is **never deleted** after it is accepted — it forms part of the permanent decision log.

### Skill lifecycle

| Stage | When | Action |
|---|---|---|
| **draft** | Author creates `.agents/skills/<name>/SKILL.md` with `status: draft` | Not listed in agent available-skills |
| **published** | Author removes `status: draft`, adds `name` + `description` frontmatter | Triggers `check-skill-frontmatter.sh` validation |
| **updated** | Author revises published skill | Increment version or add changelog; keep frontmatter `name` |
| **deprecated** | Skill is obsolete | Add `status: deprecated` + `Alternative:` pointing to replacement |
| **archived** | Skill has no consumers and no replacement | Remove from `.agents/skills/`, add stub in `docs/decisions/` |

### Prose docs maintenance

| File | Owner | Review trigger |
|---|---|---|
| `ARCHITECTURE.md` | All authors | Any feature scaffold or architecture change |
| `AGENTS.md` | All authors | Any new tool, skill, or run-loop change |
| `docs/CONTEXT.md` | All authors | Any new domain term or alias introduced |
| `docs/PROGRESS.md` | Epic owners | After each PR in an epic |

All prose docs are **append-only for retro entries**, **edit-only for style/typos**.

## Consequences

- ADRs with `status: proposed` must not be cited in `DIGEST.md` critical/warnings sections
- `status: deferred` ADRs are not required to have a `date` field
- Skills without `name` + `description` frontmatter fail the `check-skill-frontmatter.sh` CI check
- Deprecated skills are still loaded by the agent but emit a warning
