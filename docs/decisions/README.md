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
| `2026-10-30-the-host-lock-is-a-real-flock.md` | the host lock, and why the runner is a Linux tool |
| `2026-10-30-the-brief-is-the-body-when-no-comment-carries-the-marker.md` | where the brief is, and what happens when there is none |
| `2026-10-30-the-afk-runner-is-a-pi-extension.md` | why the runner is a separate repository, and the three layers of exclusion |
| `2026-09-25-git-hooks-worktree-isolation.md` | the worktree and the hooks that go with it |
| `2026-09-26-writer-reviewer-pattern.md` | the two agents, and the one that writes and the one that reads |
| `2026-09-26-code-review-process.md` | what a review is, and what the gate counts |
| `2026-09-26-adr-supersede-process.md` | how a decision is recorded and replaced |
| `2026-09-26-docs-lifecycle.md` | when a document is written, changed or deleted |
| `2026-10-03-openspec-adoption.md` | the change workflow the runner writes into |
