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

2. **Do not build, do not compile, do not run the checks.** This run does
   not gate the tree and does not compile it: the tree is pushed as you leave
   it, and the repository's own CI judges it. A build here costs the run
   minutes in a Gradle daemon and tells you nothing the code does not.

   So judge the change by reading it. Re-read the code you touched, the
   interfaces it uses and the tests around it, and let the reasoning — not a
   green build — be what you trust.

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

4. **Report** what you did, what you left out and why.
