---
title: Git Hooks — Worktree Isolation + Shared Hooks Path
status: accepted
date: 2026-09-25
authors: ZCode Agent
deciders: Singularity Developer
tags: [git, hooks, worktree, devx, epic2]
epic: refactor/test-suite-acceleration
---

# Git Hooks — Worktree Isolation + Shared Hooks Path

## Context

The project uses git worktrees for feature branches (isolated from main checkout). Hooks must work correctly whether triggered from main checkout or any worktree, without duplicating hook scripts.

## Decision
### D1: Hooks live in `.githooks/` (versioned)

Hooks are stored in `.githooks/` (version-controlled) and linked via `git config core.hooksPath`.

```
.git/hooks/          ← NOT versioned; contains only a pre-commit symlink/short script
.githooks/           ← versioned; contains all actual hook scripts
  pre-commit
  pre-push
  post-checkout
```

**Why not `.git/hooks/`?** Hooks in `.git/hooks/` are git-internal and not tracked by git. The standard approach is `.githooks/` + `core.hooksPath`.

### D2: `core.hooksPath` set for main checkout and all worktrees

```bash
# In main checkout and every worktree:
git config core.hooksPath "/path/to/main-checkout/.githooks"
```

The `just setup-hooks` recipe handles this for both main checkout and all worktrees simultaneously:

```bash
just setup-hooks
```

### D3: Hooks use `git rev-parse --show-toplevel`

Each hook script uses `REPO_ROOT="$(git rev-parse --show-toplevel)"` to find the correct repo root, regardless of whether it runs from main checkout or a worktree.

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"
```

### D4: Hook behavior by context

| Hook | What it does |
|---|---|
| `pre-commit` | Compile main + test sources (~22s) — fail-fast on compilation errors |
| `pre-push` | Full fast test suite + detekt — last gate before push |
| `post-checkout` | Clean stale `build/classes` dirs after branch switch |

### D5: Worktree detection

```bash
GITDIR="$(git rev-parse --git-dir)"
if [[ "$GITDIR" == */worktrees/* ]]; then
    IS_WORKTREE="yes"
fi
```

Used by hooks to adjust behavior (e.g., `pre-push` runs in all contexts; `pre-commit` compile-only in worktrees since full test runs belong in CI).

Since 2026-10-23 the `pre-commit` hook does not use this detection at all: it compiles in
every context, and the detection it used was the thing that switched the check off in
the mode most commits are made in. ADR
`2026-10-23-the-commit-hook-compiles-in-a-worktree` records the change and its price.

The `pre-commit` row of D4 is what the hook does since 2026-10-23. It did not before: a linked worktree exited 0 without compiling, so the
"compile-only" this table promises was never reached in the mode most commits are made in. ADR
`2026-10-23-the-commit-hook-compiles-in-a-worktree` records the change and its price.

## Consequences

- Hooks work identically in main checkout and worktrees
- No duplicate hook scripts — one canonical copy in `.githooks/`
- Developers in worktrees get fast pre-commit feedback (compile only); full test suite runs in CI or via `just tcheck`
  — the compile half of this became true on 2026-10-23; before it, a worktree commit was not compiled at all
- `just setup-hooks` configures all worktrees in one command

## Links

- Skill: `singularity-todo-worktree-isolation`
