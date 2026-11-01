# Implement it

The plan is settled. Now do the work.

**The tree may carry the unfinished work of an earlier run.** A run that did
not finish leaves its work on the branch, and this run continues it: read the
tree and `git log` before you write, and finish what is there rather than
starting again. An earlier run's commits are the ones the system prompt names, and
a commit that says `wip:` or `the agent's work` is one of them.

1. **Make the change.** Small, in the shape the repository already uses. Match
   the surrounding code: its names, its structure, its level of abstraction.
   Do not add a layer because a layer is possible — add one because something
   needs it, and say what. The change stays in the tree while you make it
   (step 3): the tree is where the work is.

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

   **The work is the tree's, and it stays there while this turn runs.** The
   run keeps what is in the tree — it commits it on the branch, and the next
   run continues that branch — so the change you are making belongs in the
   tree. A stash is not part of what the next run continues: it lives in the
   repository's own stash, where nothing says which entry is whose, and the
   runner does not read it. Stash the change to get a clean tree for a gate
   and the run commits an empty tree, while the change sits in a stash
   nothing will pick up. A stash of your own, for your own reasons, is yours
   to keep — the work is not in it.

4. **Report** what you did, what the gates said, and what you left out and
   why.
