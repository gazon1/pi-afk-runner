# The decisions

Two kinds of record live here, and they are not the same thing:

- **the runner's own decisions** — files this repository wrote, dated from the day they were made.
  They are the ones that bind *this* code.
- **copies** of the target repository's decisions — the ones whose practices the runner inherits:
  the worktree isolation, the writer/reviewer pattern, the review process, the ADR process, the
  docs lifecycle, the OpenSpec adoption, and the runner's own decision in that repository.

The copies are copies: a change to one of them here is a change to a copy, never to the original.
They are here so that a reader of this repository has the reasoning behind the practices it
follows, without cloning the other one. See [../../contract/README.md](../../contract/README.md)
for the rule that the copies follow.

| Decision | What it settles |
|---|---|
| `2026-11-06-the-graph-runs-on-the-mastra-workflow-engine.md` | the graph runs on Mastra's workflow engine and is a set of components: the states, the tokens, the errors, the step, the straight line, the work session, the review loop — **the graph clause replaced** in `2026-11-05-pi-is-gone.md`: the graph is the engine's, and the runner's rules stay the runner's |
| `2026-11-05-the-pool-asks-the-engine-what-it-carries.md` | the pool on the Mastra engine: the catalogue it asks, the session that can be moved, and the level the file names — **supersedes** `2026-11-02-the-model-pool-is-a-file-the-host-owns.md` and `2026-11-02-the-file-names-the-effort-of-each-model.md`: the pool asks the engine what it carries, and the level is reported rather than applied |
| `2026-11-05-the-engine-tells-the-model-when-a-turn-ends-on-a-tool.md` | the engine tells the model, between its steps, that the turn ends on a tool: the review's verdict is reached instead of being cut off by the step limit |
| `2026-11-05-a-run-gates-nothing-and-builds-nothing.md` | a run gates nothing and builds nothing: the gates are off by default and the agent may not compile — **supersedes** `2026-11-05-the-workflow-runs-the-gates.md` |
| `2026-11-05-a-review-that-stated-no-verdict-gets-a-second-turn.md` | a review that stated no verdict gets a second turn in the same session, the first verdict stands, and the second turn is skipped when the verdict is there |
| `2026-11-05-the-workflow-runs-the-gates.md` | the workflow runs the gates and the agent does not: a refusal comes back to the agent as a turn, which gates run is the repository's own business, and the gates run with the repository's own PATH — **superseded** by `2026-11-05-a-run-gates-nothing-and-builds-nothing.md`: the gates are off by default |
| `2026-11-05-the-command-line-is-parsed-by-citty.md` | the command line is parsed by citty: one list of flags, the usage rendered from it, and the exit code still the runner's |
| `2026-11-05-pi-is-gone.md` | Pi is out: the SDK, the workflow engine and the permission system go, Mastra is the only engine, and the graph is the runner's own TypeScript — **the graph clause replaced** by `2026-11-06-the-graph-runs-on-the-mastra-workflow-engine.md`: the graph is the engine's, and the runner's rules stay the runner's |
| `2026-11-05-the-runner-is-a-command-and-not-a-pi-extension.md` | the door goes: the runner is a command, and what survives of the Pi extension record — **superseded** by `2026-11-05-pi-is-gone.md`: the command stands, the version gate goes with Pi |
| `2026-11-05-the-run-runs-on-mastra.md` | the run runs on Mastra: the agent, the graph and the memory are Mastra's, and the seams and the contract stay — **superseded** by `2026-11-05-pi-is-gone.md`: the seams stand, the graph is the runner's own |
| `2026-11-02-the-reviewers-tree-is-put-back.md` | the review puts the worktree back to the tree it judged, so a leftover never rides along with the fix |
| `2026-11-01-only-a-gone-session-is-swallowed.md` | which failures the front door swallows, and which ones it lets out — **superseded** by `2026-11-05-the-runner-is-a-command-and-not-a-pi-extension.md`: there is no front door to swallow anything |
| `2026-11-04-the-record-quotes-the-tail-and-names-the-log.md` | what the record quotes of a gate's output, and where the whole of it is |
| `2026-11-02-the-model-pool-is-a-file-the-host-owns.md` | the model pool: the file the host owns, the models in it, when the runner moves between them, and each model's own proxy — **superseded** by `2026-11-05-the-pool-asks-the-engine-what-it-carries.md`: the pool asks the engine's catalogue, not a runtime |
| `2026-11-02-the-file-names-the-effort-of-each-model.md` | the level each model in the pool thinks at, and who says it — **superseded** by `2026-11-05-the-pool-asks-the-engine-what-it-carries.md`: the level is read and reported, not applied |
| `2026-11-01-the-self-review-runs-the-gates-again.md` | the self-review runs the gates again, and the agent's work is pushed only when they are green — **superseded** by the runner running the gates itself |
| `2026-10-30-the-host-lock-is-a-real-flock.md` | the host lock, and why the runner is a Linux tool |
| `2026-11-01-the-lock-is-per-issue.md` | the lock's unit: one per issue, one for the sweep, one for merge |
| `2026-10-30-the-work-session-is-the-runners-minus-the-runner.md` | what a work session loads, and where the guard's policy lives — **superseded** by `2026-11-05-pi-is-gone.md`: a run has no Pi session |
| `2026-10-31-the-auto-attached-chat-keeps-its-worktree.md` | why the worktree is put back when the chat was switched into it — **superseded** by `2026-11-05-the-runner-is-a-command-and-not-a-pi-extension.md`: the chat is gone |
| `2026-11-02-a-restored-worktree-is-prepared.md` | why the worktree the door puts back is prepared — **superseded** by `2026-11-05-the-runner-is-a-command-and-not-a-pi-extension.md`: the door is gone; the review path's worktree is still prepared |
| `2026-10-30-a-failed-runs-branch-is-continued.md` | what the next attempt does with the branch a failed run left |
| `2026-10-31-a-branch-with-no-commits-is-not-work.md` | when a branch on the remote counts as work |
| `2026-10-31-the-sweep-belongs-to-the-cli.md` | who drains the queue, and what the unit's timeout is sized for |
| `2026-11-01-the-session-share-is-two-hours.md` | the work session's share of the budget, and the claim's staleness window that outlasts a run |
| `2026-11-02-the-merge-sweep-spends-one-budget.md` | the merge sweep's one wall-clock, the shares each step takes from it, and the pull request it leaves when the clock is gone |
| `2026-11-02-a-run-that-did-not-finish-leaves-its-work.md` | a failed run keeps its unfinished work on the branch, and the next run continues it |
| `2026-11-02-the-record-names-the-build-and-the-progress.md` | what a cut run's record says: which build wrote it, why it was cut, and how far it got |
| `2026-11-02-the-work-is-the-tree-and-not-the-stash.md` | the work is the tree's, and a stash is not work the next run continues |
| `2026-11-02-the-implement-turn-says-where-the-work-has-to-stay.md` | the turn that writes the work says where the work has to stay while it runs |
| `2026-10-31-an-interrupted-run-releases-its-claim.md` | what a killed run does with its claim, and why the signal releases it |
| `2026-10-30-the-brief-is-the-body-when-no-comment-carries-the-marker.md` | where the brief is, and what happens when there is none |
| `2026-11-02-the-fourth-turn-asks-what-follows.md` | the fourth turn, and who files the leftovers |
| `2026-11-02-a-prompt-may-only-name-a-skill-the-runner-carries.md` | the skills a prompt may name, and who carries them — **superseded** by `2026-11-05-pi-is-gone.md`: the rule stands, the carrier is the runner's own |
| `2026-11-02-the-reclaim-deletes-the-branch-the-dead-run-left.md` | what the reclaim does with the branch the dead run left on the remote |
| `2026-11-02-the-merge-pipeline-is-separate.md` | why landing is an opt-in mode, and when a pull request is a candidate |
| `2026-11-02-the-branch-and-its-pattern-live-in-one-place.md` | the work branch's name and the pattern that recognises it, and who asks it |
| `2026-11-02-the-session-is-a-workflow.md` | the session's states, the workflow that runs them, and whose rules they stay — **superseded** by `2026-11-05-pi-is-gone.md`: the shape stands, the graph is the runner's own |
| `2026-11-01-the-queue-is-read-in-one-call.md` | the cost of a run: the queue and the branches are read once, and every `gh` call is bounded |
| `2026-11-01-the-work-is-a-conditional-graph.md` | triage, scope and split as a branch; `gate` for the review loop; dependencies; the small-change skip |
| `2026-11-01-a-fix-that-changes-nothing-stops-the-loop.md` | a fix that leaves the head where it was stops the review loop, and the run says why |
| `2026-11-01-a-review-that-is-cut-off-stops-the-loop.md` | a review that was cut off stops the review loop, and the run says what cut it off |
| `2026-11-01-the-work-is-a-conditional-graph.md` | triage, scope and split as a branch; `gate` for the review loop; dependencies; the small-change skip — **the dependency rule replaced** by `2026-11-03-a-dependency-is-settled-by-a-merge.md` |
| `2026-11-03-a-dependency-is-settled-by-a-merge.md` | what settles a dependency: the parent's pull request is merged, and nothing else |
| `2026-11-01-the-triage-judges-the-base-not-the-branch.md` | what "already done" is asked of, when the worktree is the issue's own branch |
| `2026-11-02-the-runner-runs-the-repositorys-gates.md` | the gates the runner runs itself, before it pushes: the list, the budget, and the agent's report it supersedes |
| `2026-10-30-the-afk-runner-is-a-pi-extension.md` | why the runner is a separate repository, and the three layers of exclusion — **superseded** by `2026-11-05-the-runner-is-a-command-and-not-a-pi-extension.md`: the door is gone; the separate repository, the claim as a ref and the run's content staying on the machine stand |
| `2026-09-25-git-hooks-worktree-isolation.md` | the worktree and the hooks that go with it |
| `2026-09-26-writer-reviewer-pattern.md` | the two agents, and the one that writes and the one that reads |
| `2026-09-26-code-review-process.md` | what a review is, and what the gate counts |
| `2026-09-26-adr-supersede-process.md` | how a decision is recorded and replaced |
| `2026-09-26-docs-lifecycle.md` | when a document is written, changed or deleted |
| `2026-10-03-openspec-adoption.md` | the change workflow the runner writes into |
