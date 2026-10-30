# The contract

This runner is written against contracts that **another repository owns** — the repository it
operates on. Those contracts change when that repository changes, and the runner breaks when they
do.

This directory is a **copy** of that contract, so that:

- the runner's own tests can use the gate's **real** reader rather than a transcription of it
  (two implementations of a rule drift apart, and nobody notices until a verdict stops matching);
- a reader of this repository has the whole binding without cloning the other one.

## The files, and where they come from

| Here | From `gazon1/sing` | What it is |
|---|---|---|
| `afk-runner.md` | `docs/architecture/afk-runner.md` | the binding, written for the author of the extension: the queue selector, the brief's marker, the review's marker and verdict, the re-count label, the registry entries, the worktree recipe |
| `AGENT-BRIEF.md` | `.agents/skills/triage/AGENT-BRIEF.md` | the brief's format — the comment the runner reads as the contract for the work |
| `scripts/setup-worktree.sh` | `scripts/setup-worktree.sh` | what the runner runs inside the worktree: the `core.bare` repair, the per-worktree `core.hooksPath`, the `.env` copy, the private Gradle home |
| `scripts/check-review-verdicts.py` | `scripts/check-review-verdicts.py` | the digest of a change's contract documents, which the verdict file carries |
| `scripts/openspec-import-all.py` | `scripts/openspec-import-all.py` | the importer that creates a change's registry entry |
| `scripts/ci-verdict.py` | `scripts/ci-verdict.py` | the tool that reads a commit's CI verdict — **its exit code is the verdict** |
| `scripts/ci/check-agent-review.py` | `scripts/ci/check-agent-review.py` | the gate that reads the review comment, and the oracle the runner's tests assert against |

## The rule

**The runner runs the target repository's copies, not these.** These are here for the tests and
for the reader. A run works in a worktree of the target repository, and the scripts it invokes
must be that repository's — a digest computed against a stale copy is a digest of nothing.

So these files are **verbatim copies**, and a change to one of them here is a change to a copy,
never to the original. When the target's contract changes, copy it again — that is the whole
maintenance rule, and it is a manual step on purpose: a copy that updates itself is a second
implementation of the thing it copies.

The one place where the drift would bite hardest is
`scripts/ci/check-agent-review.py`: the runner's comment format is asserted against its reader,
so a copy that has fallen behind turns a passing test into a lie.
