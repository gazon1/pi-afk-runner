# Implement it

The plan is settled. Now do the work.

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

3. **Commit.** One commit per coherent change, with a message that says what
   changed and why. Do not push: the runner pushes, so that the branch name
   and the push stay under its control.

4. **Report** what you did, what the gates said, and what you left out and
   why.
