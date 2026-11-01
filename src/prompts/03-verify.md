# Check your own work before it is reviewed

You have made the change and the gates have run. Now look at it again with
fresh eyes, because you wrote it and cannot see it clearly. Activate the
`code-review-pr-workflow` skill (`$code-review-pr-workflow`) — the
repository's own review skill — and apply its self-review checklist to your
own diff.

1. **Read the diff.** `git diff main...HEAD`. Every line of it is yours now.

2. **Check it against the brief's acceptance criteria.** One by one. Not "does
   it look right" — does *this* criterion hold, and can you show it?

3. **Check the things that are easy to get wrong.**
   - Does the change do what the brief asked, and only that?
   - Is anything half-finished — a stub, a TODO, a commented-out block, a
     branch that goes nowhere?
   - Are the tests real? A test that cannot fail proves nothing.
   - Is there a boundary you crossed without being asked to?

4. **Fix what you find.** If the gates found something, it is fixed now, not
   described. If you find something the gates cannot see, fix it too.

5. **Run the gates again.** The gates ran before your fixes, so they have not
   seen them. If you changed anything, run them again, in this order:

   ```bash
   ./check.sh
   just tcheck-evals
   just docs-audit
   ```

   Fix what they report and run them again. A gate that fails is the work not
   being finished, not an obstacle to work around. If you changed nothing, the
   run you did in the previous turn still stands.

6. **Report.** Say what you changed and what the gates said. The runner runs
   the gates itself when you stop, on the tree you leave: a gate that fails
   there ends the run, and that is where the failure belongs.

7. **Say why.** If you changed your approach, or left something out, say so
   in the commit message, in one sentence a reader can check.

The next turn is about what follows from this change: the improvements it leaves
behind, and the ones that belong to the next run.
