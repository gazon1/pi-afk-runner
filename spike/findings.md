# Spike findings

Pi 1.4.0 (`@earendil-works/pi-coding-agent`), Linux, 2026-10-30. Every command below was run on
this host; the raw outputs are in the transcript of the session that produced this file.

## 1. The components compose. All of them.

Nine packages, installed project-locally and pinned, loaded in one session:

```
93 commands registered, 0 extension load errors
```

| Component | Commands it contributes |
|---|---|
| `pi-subagents` | `subagents`, `subagents-fleet`, `subagents-steer`, `subagents-watchdog`, `subagents-doctor`, `subagents-profiles`, `skill:pi-subagents` |
| `pi-advisor-flow` | `advisor`, `advisor-manual`, `advisor-models`, `advisor-off`, `advisor-settings`, `advisor-stats` |
| `@quintinshaw/pi-dynamic-workflows` | `workflows`, `workflows-models`, `workflows-progress`, `workflows-trigger`, `skill:workflow-patterns`, `skill:workflow-authoring` |
| `pi-lens` | `lens-health`, `lens-map`, `lens-perf`, `lens-tools`, `lens-toggle`, `lens-allow-edit`, `skill:pi-lens-*` |
| `@gotgenes/pi-permission-system` | `permission-system` |
| `agents-cron` | `schedule`, `remind`, `skill:scheduler` |
| `@signalridge/pi-worktree` | `worktree` |
| `@narumitw/pi-github-pr` | `code-review`, `review-loop`, `codebase-audit` |
| `@drix10/agent-flow` | `skill:agent-flow-bootstrap`, `skill:agent-flow-implementer`, `skill:agent-flow-reviewer`, `skill:agent-flow-qa`, `skill:agent-flow-gardener` |

**No two components fight over an event.** Nine packages, each with its own idea of what a turn
is and who owns the session, and none of them needed to be disabled.

That was the open risk, and it did not materialise.

## 2. `--approve` is not optional, and it is per run

This is the finding most likely to be missed, because nothing complains:

```
$ printf '{"type":"get_commands"}\n' | pi --mode rpc            # no --approve
13 commands registered          ← the global packages only
$ printf '{"type":"get_commands"}\n' | pi --mode rpc --approve
93 commands registered          ← ours too
```

Project-local packages load **only when the project is trusted**, and the trust is granted per
run (`pi --help`: "Trust project-local files for this run"). There is no persistent trusted-project
list. A runner started without the flag would load nothing of its own and **look healthy**.

`pi install -l` fails for the same reason — "Project is not trusted" — and needs `--approve` to
write `.pi/settings.json` at all.

## 3. `pi list` does not show project-local packages

It lists the user's packages:

```
User packages:
  npm:pi-commandcode-provider
```

The project's own dependencies are in `.pi/settings.json` and installed into `.pi/npm/`. To know
what a checkout actually runs, read that file.

## 4. Installing the components touched nothing but the project

- The repository's `.git/hooks` are untouched: no non-sample hooks, `git status` shows only
  `.pi/`.
- No install script ran from a registry tarball. `pi-advisor-flow` declares `preinstall` (a bun
  version check) and `prepare` (`husky`); neither left an artifact, because npm does not run
  `prepare` for a registry install.
- The only `curl … | sh` in the tree is in
  `@gotgenes/pi-permission-system/docs/configuration.md` — the guard's own documentation of what
  it blocks, not code.

## 5. A model turn completes with everything active

```
prompt      → started
turn_end    → assistant: "READY"   (anthropic-messages / commandcode / claude-sonnet-5-5)
agent_settled → aborted: false
```

No extension error, no hook failure, no timeout. The provider resolves through the user's own
`pi-commandcode-provider`, with the proxy variables the provider needs.

## 6. `@drix10/agent-flow`: viable, and it brings the roles as skills

Installing it as the ninth package took the command count from 78 to 93 with no errors. What it
adds is **skills, not commands**: `skill:agent-flow-implementer`, `skill:agent-flow-reviewer`,
`skill:agent-flow-qa`, `skill:agent-flow-bootstrap`, `skill:agent-flow-gardener` — the
implementer / reviewer / QA roles the plan wanted, in the form its README describes.

So it does not collide with `pi-subagents` or `pi-advisor-flow`: it composes. Whether it should
be the **engine** is still open, and the spike does not settle it:

- **For:** its README describes this plan's shape almost exactly — builder, reviewer, checker,
  guard, its own worktree, a draft pull request — with Pi among its harnesses, and the guard
  blocking tool calls directly on Pi.
- **Against:** it is used 176 times a week against `pi-subagents`' 329 003; it is a flow that owns
  the session, which is the one thing this runner must own itself (the session's `cwd` is the
  worktree, and the runner drives the prompt array); and it takes a task id on the command line,
  so the queue — the part that is specific to this repository — is ours either way.

**Recommendation:** adopt it as a *reference design* and let the runner own the session. Take its
roles as skills where they help; do not hand it the session.

## 7. What this spike could not answer

**One issue was not worked end to end.** That needs a runner — the worktree, the claim, the pull
request, the review — and the runner is what the rest of the plan builds. The task as written is
partly circular: the spike asks for an end-to-end run of the thing whose shape it is deciding.

What the spike *could* answer, it answered: the components compose, they load, they survive a
model turn, and the one operational trap (`--approve`) is now known. The end-to-end run is the
first real run of the runner itself.
