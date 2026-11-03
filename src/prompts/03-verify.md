# Check your own work before it is reviewed

You have made the change. Now look at it again with fresh eyes, because you
wrote it and cannot see it clearly. Activate the
`code-review-pr-workflow` skill (`$code-review-pr-workflow`) — the
repository's own review skill — and apply its self-review checklist to your
own diff.

**The work is the tree's.** The run keeps what is in the tree — it commits it
on the branch, and the next run continues that branch — so the work you are
making stays in the tree. A stash is not part of what the next run continues:
it lives in the repository's own stash, where nothing says which entry is
whose, and the runner does not read it. A stash of your own, for your own
reasons, is yours to keep; the work is not in it.

1. **Read the diff.** `git diff main...HEAD`. Every line of it is yours now.
   The code around it is in the tree: the `agent_pack_codebase` tool packs the
   part the diff touches into one document.

2. **Check it against the brief's acceptance criteria.** One by one. Not "does
   it look right" — does *this* criterion hold, and can you show it?

3. **Check the things that are easy to get wrong.**
   - Does the change do what the brief asked, and only that?
   - Is anything half-finished — a stub, a TODO, a commented-out block, a
     branch that goes nowhere?
   - Are the tests real? A test that cannot fail proves nothing.
   - Is there a boundary you crossed without being asked to?

4. **Fix what you find.** If you find something, it is fixed now, not
   described. Nothing here is checked by a build, so what you find is what
   you fix.

5. **Do not build, do not compile, do not run the checks.** This run does
   not gate the tree and does not compile it: the tree is pushed as you leave
   it, and the repository's own CI judges it. Review by reading — the diff, the
   code around it, the tests — and not by building.

6. **Report.** Say what you changed, and what you did not check — a change
   that was not compiled is said so, not hidden.

7. **Say why.** If you changed your approach, or left something out, say so
   in the commit message, in one sentence a reader can check.

The next turn is about what follows from this change: the improvements it leaves
behind, and the ones that belong to the next run.
