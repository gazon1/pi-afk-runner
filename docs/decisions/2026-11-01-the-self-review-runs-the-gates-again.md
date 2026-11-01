---
title: The self-review runs the gates again, and the agent's work is pushed only when they are green
status: accepted
date: 2026-11-01
authors: Command Code
deciders: Singularity Developer
tags: [gates, prompts, session, pull-request, agent]
---

# The self-review runs the gates again, and the agent's work is pushed only when they are green

## Context

The gates ran in the **second** turn. The **third** turn — the self-review — then changed the code
after them, and the runner committed the worktree as it was (`git add -A`, `src/runner.ts`) and
pushed it.

The only thing between that fix and the remote was the target repository's pre-push hook, and the
hook is explicitly not the whole suite: it runs the fast gates and the detekt verdict, while the
JVM tests, the Android assemble and the rest are CI's (`config/hooks/pre-push.json` in the target
repository; `scripts/check-hook-gates.py` keeps that record and the hook in step).

So a fix the self-review made could break `./check.sh`, and the run pushed it anyway. The pull
request carried a change the repository's own gate would have refused, and the failure showed up in
CI — where the run is not, and where nobody is watching.

## Idea

Ask the agent that changed the code to run the gate again, and make the runner refuse to push a
tree that no gate run has seen.

## Decision

**Two halves, and both of them are needed.**

**The prompt side.** `src/prompts/03-verify.md` re-runs the three gates after the self-review's
fixes and ends the turn with the `agent_gates` tool — one entry per gate, with what it said.
`src/prompts/02-implement.md` says that the run there is a checkpoint, and that the tree it leaves
is the tree the next turn pushes.

The turn that follows the self-review — the one that says what the change leaves behind, and that
may fix the cheap ones — can change the tree as well, so `src/prompts/04-next.md` ends with the
same report. The last report is the one the runner reads, and the tree it names is the tree the
run ends on.

**The runner side.** The work session is given the `agent_gates` tool (`src/gates.ts`). The tool
records what each gate said **and the tree the report was made against**, and its result ends the
turn: the report is the last action, and a tool result that says so is what makes it true. After
the session, and before the push, the runner reads the report (`assertGatesGreen`), and the run
stops at the session step when:

- the agent reported no gates at all;
- a gate failed — the report says so, and the run stops on it;
- a gate the target repository runs was not reported;
- the tree changed after the report, so the gates saw a different tree from the one that would be
  pushed.

Only the three gates decide. An entry for a gate the workflow does not run — `just gate`, which
needs a device — is the agent's noise, not a finding.

## Rationale

**Why a tool and not a sentence.** The review's verdict is a tool for the same reason: a value the
runner reads, not prose it has to parse out of a message. A report the runner cannot read is a
report it cannot hold the agent to.

**Why the tree travels with the report.** A gate run on an earlier tree is not a gate run on this
one. Without the tree, "the gates passed" says nothing about *which* tree passed, and the fix the
self-review made after the gates ran is exactly the case the report would wave through.

**Why the runner refuses rather than warns.** Green means one thing. A push that carries a change
the repository's own gate would refuse is a red pull request and a red CI run, and the failure
appears where nobody is watching.

**Why the check runs after the commit and before the push.** The work stays on the branch, so the
next attempt continues it; and nothing ungated reaches the remote, because the push step never
runs.

**Why the runner does not run the gates itself.** That is issue #28, and it is the stronger place
for the gate: the runner would be holding the agent to gates it ran itself, rather than to a
report. This record is the prompt-side half, and the two do not contradict each other — #28 makes
the report unnecessary, and until then the report is what stands between the fix and the remote.

## Consequences

- The work session has to end its last turn with the tool. An agent that does not is a failed run,
  loudly, at the session step — not a pull request that nobody gated.
- The report is the agent's word. The runner cannot tell that the gates really ran; it can tell
  that the tree it pushes is the tree the report was made against. #28 is what closes the rest.
- The gates run twice per issue when the self-review changed something: once in the implement turn,
  as a checkpoint, and once after the fixes — and once more when the turn that follows changed
  something.
- The runner's own writes — the registry entry and the verdict file — are committed after the gates
  have run, because the verdict file cannot exist before the review. They are generated files the
  target repository's own gates check.

## Links

- `src/gates.ts` — the tool, the report, and the check.
- `src/prompts/02-implement.md`, `src/prompts/03-verify.md`, `src/prompts/04-next.md` — the prompt
  side.
- `src/runner.ts` — the session step, which reads the report before the push.
- `test/gates.test.ts`, `test/runner.test.ts` — the gates that can say no.
- Issue #28 — the runner running the target's gates itself.
