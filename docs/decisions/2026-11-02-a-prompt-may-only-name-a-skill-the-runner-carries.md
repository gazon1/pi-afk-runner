---
title: A prompt may only name a skill the runner carries
status: accepted
date: 2026-11-02
authors: MiniMax Code
deciders: Singularity Developer
tags: [runner, prompt, skill, session, portability]
---

# A prompt may only name a skill the runner carries

## Context

Two of the four prompts named a skill the work session does not have. The
first turn asked for the `ponytail` skill and the third for the
`ponytail-review` skill, and neither is in the target repository: the
repository the runner operates on keeps its skills in `.agents/skills`, and
there is no `ponytail` among the hundred and twenty-odd there.

The ponytail family exists in exactly one place on the machine this was
written on: the **host user's** `~/.agents/skills`. That directory is not the
runner's — it is the user's, on the user's machine — and a work session finds
it only because the SDK looks there. So the instruction worked on one host and
was a no-op on every other one, and the runner guaranteed nothing about it.

The turn that was supposed to check the agent's own diff ran without a
checklist, and nothing said so: the prompt said to activate a skill, the
skill was not there, and the turn carried on with whatever the model felt like
checking.

The target repository does have a review skill of its own —
`code-review-pr-workflow`, whose description covers "self-reviewing a local
diff before pushing" — and this runner already carries a copy of it.

## Idea

A prompt names a skill only where the agent runs: the target repository's
`.agents/skills`, or a skill this package ships. And a skill the runner
depends on is a skill the runner carries.

## Decision

**A prompt may name the target repository's skills, and the runner's own.**

The runner's own skills live in `skills/` — the copies of the target's skills
that the runner already keeps. The package **ships** that directory, and the
session's skill paths carry it (`additionalSkillPaths` on the resource
loader), so a skill a prompt names is in the session on every host. Where the
target repository has a skill of the same name, the target's copy is the one
that is used: the target owns it, and the runner's copy is the fallback for a
target that has none.

**The third turn asks for the target's own review skill.** It says
`$code-review-pr-workflow` — the skill that covers self-reviewing a local
diff — and not a skill of the host's.

**The rule the `ponytail` skill carried is said in the prompt.** "How small
the change should be" was the only thing that skill was there for, and a rule
that fits in a sentence does not need a skill to be installed.

**A prompt names a skill as `$<name>`, and the suite checks it.** Every
`$name` in a prompt is a skill the runner carries, and a session on a host
with no skills of its own has it anyway.

## Rationale

Relying on the target repository alone would have been the smaller change: it
has the review skill, the work session runs in its worktree, and the
project's `.agents/skills` are discovered from there. But the guarantee would
then be a fact about the target rather than a fact about the runner, and the
target's skills are the target's to change. A prompt that names a skill the
runner does not carry is a prompt that breaks the day the target renames
something, and the failure is silent: the turn runs, and the checklist does
not.

Shipping the skills is what turns the rule into a property. The runner
depends on `code-review-pr-workflow`; the runner therefore carries it, and the
session has it whether the host has it, whether the target has it, and whether
the project is trusted. The copy in `skills/` was already here — it was only
ever documentation, and now it is also the fallback.

The alternative — inlining every checklist into the prompts — was rejected for
the review: the checklist is a procedure, and a procedure that changes is a
skill that changes. Inlining it would make every change to the review's
method an edit to a prompt, and the target's copy would drift from the
runner's. The one exception is the size rule, which is a sentence, not a
procedure.

The `$name` convention is what makes the rule checkable. A prompt that named
a skill in prose would leave the suite guessing what a skill name looks
like; a name in backticks with a dollar in front is one shape, and the suite
can read it.

## Consequences

- The package ships `skills/`. It is the same directory the repository keeps
  its copies in, so there is one copy and not two.
- The work session's skill list has the runner's copies in it. Where the
  target has the same skill, the target's copy is used and the runner's is a
  fallback, so nothing changes for a target that has them all.
- A prompt that names a skill has to name one of `skills/`. The suite says so,
  and says that the session has it on a host with no skills of its own.
- The target's own review skill tells a reviewer to load the
  `ponytail-review` skill, which lives on the host and not in the target. That
  is the target's file, and the runner does not change copies; the runner's
  own review prompt states its checklist in the prompt, so the review does not
  depend on which host ran it.

## Links

- `src/prompts/01-brief.md` — the size rule, said in the prompt.
- `src/prompts/03-verify.md` — the self-review turn, and the skill it names.
- `src/session.ts` — `skillsDirectory()`, the runner's own skills.
- `src/cli.ts` — `createResourceLoader()` and the session's skill paths.
- `test/skills.test.ts` — the guard: a prompt names only what the runner
  carries, a session on a bare host has it, and the target's own copy of a
  skill is the one the session uses.
- `AGENTS.md` — the rule the prompts follow.
