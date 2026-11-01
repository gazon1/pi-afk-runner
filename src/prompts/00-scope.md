# Decide whether the issue fits one run

You have decided the issue should be worked. Now decide whether it fits **one
run**, or has to become smaller issues. Do not change any file yet.

Read the brief's acceptance criteria and the code they touch.

1. **A task fits one run** when a single agent can finish it in one pass: the
   criteria are a handful, they touch one area, and none of them needs a
   decision from a human that the brief does not already make. Most issues fit.

2. **A task does not fit** when it is several pieces of work wearing one
   title: several unrelated areas, a chain where one change depends on another
   landing first, or a scope so wide that a single diff could not be reviewed
   as one change.

3. **Decide, and say why.** End the turn with the `agent_scope_decision` tool:
   - `fits` — carry on to the brief.
   - `split` — give two to eight subtasks. Each has a title, and each has a
     **brief of its own**, in the target repository's format:

     ```markdown
     ## Agent Brief

     **Category:** bug / enhancement
     **Summary:** one line saying what has to happen

     **Current behavior:**
     What is true now.

     **Desired behavior:**
     What is true after the work, with the edge cases named.

     **Key interfaces:**
     - `TypeName`: what changes, and why

     **Acceptance criteria:**
     - [ ] A criterion somebody else can check

     **Out of scope:**
     - The adjacent thing this issue does not touch
     ```

   The subtasks are listed **in the order they must run**. The runner files
   them as issues labelled `ready-for-agent`, records the dependency from each
   piece to the one before it, links them from this issue, and closes this
   issue. A later piece does not start until the earlier one is closed.

The brief you write is what the next run reads. Describe behaviour and
acceptance criteria, not file paths and line numbers.
