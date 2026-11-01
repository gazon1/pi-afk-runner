# Implement it

The plan is settled. Now do the work.

**The tree may carry the unfinished work of an earlier run.** A run that did
not finish leaves its work on the branch, and this run continues it: read the
tree and `git log` before you write, and finish what is there rather than
starting again. A commit that says `wip:` is an earlier run's work.

1. **Make the change.** Small, in the shape the repository already uses. Match
   the surrounding code: its names, its structure, its level of abstraction.
   Do not add a layer because a layer is possible — add one because something
   needs it, and say what.

2. **Run the gates.** The repository's own, in this order:

   ```bash
   ./check.sh
   just tcheck-evals
   just docs-audit
   ```

   Not `just gate`: its third step runs the Maestro flows on a device, and
   this machine has no device. Fix what the gates report. A gate that fails
   is the work not being finished, not an obstacle to work around.

   This run is a checkpoint, not the last word. The next turn looks at the
   change again with fresh eyes, fixes what it finds, and runs the gates again
   — so a tree you leave red is a tree the run stops on.

   While you work, a small change — a few lines in one module — needs
   `./check.sh` only: the long evals and the docs audit earn their cost on a
   change that reaches them, and the runner skips the pre-push hook for a
   small change for the same reason.

   **The runner runs the whole list again when you stop**, in the worktree,
   on the tree you leave. That run is the one that counts: a gate that fails
   there ends the run — the claim is released, nothing is pushed, and the
   record says which gate failed. Run the gates yourself so that you can fix
   what they report; a gate you never ran is a gate that ends the run.

3. **Do not commit or push.** The runner commits whatever is left in the
   worktree on your behalf and pushes under its own branch name, so the push
   stays under its control. A commit you make yourself is not lost, but it is
   not needed.

4. **Report** what you did, what the gates said, and what you left out and
   why.
