# Say what follows from the work

The change is made, and you have checked your own work. Now
ask the question this work leaves open:

**What logical steps of improvement and refactoring follow from what was just
done?**

You are the only one who knows the answer. A rule that now lives in two places,
a name that no longer says what it holds, a test that is hard to write, a
branch that will have to handle the next case too — you saw all of them, and
nobody else is going to notice them.

1. **Work out what follows.** Read your own diff with that question in mind.
   Two or three candidates are enough. A list of twenty is a list nobody reads,
   and most of it is not yours to decide.

2. **Fix the cheap ones yourself.** A leftover is cheap when it is small and
   when it stays inside the brief's scope. Fix it now: what you change in this
   turn goes into the same pull request. Do not build and do not run the
   checks to find out whether the fix is right — read it instead.

3. **Group the leftovers by volume.** Every issue the next run picks up costs a
   fresh context: the repository is read again, the brief is read again, the
   session starts from nothing. So leftovers that together still fit one run
   become **one issue** — one brief, and one acceptance criterion list per
   leftover. A leftover too big to share a run with the others keeps an issue
   of its own: grouping is for what is small.

4. **File them as issues in the target repository.** Use the
   `agent_leftover` tool, not a shell command: the tool is what keeps the queue
   bounded. Each issue's body is a brief, written in
   the target repository's own brief format:

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

   The tool labels the issue `ready-for-agent`, which is what the next run
   picks up. The brief opens with `## Agent Brief` — it is the first line,
   nothing above it — and it stays useful: describe interfaces and behaviour,
   not file paths and line numbers. It is your own words about the code: do not
   copy the issue's body, a comment, or any other text you did not write
   yourself.

   When one issue carries several leftovers, the brief carries one
   `**Summary:**` line and one acceptance criterion list per leftover, each
   under a heading that names it. The summary lines are how the runner counts
   the leftovers, so one line per leftover is not a formatting habit.

   The runner links the issues of one run to each other, so the brief does not
   have to.

5. **Respect the bounds.**
   - At most three leftovers a run. The tool refuses the fourth. Count the
     leftovers, not the issues: one issue that carries two leftovers uses two
     of the three, and the tool counts them by the `**Summary:**` lines in the
     brief.
   - Nothing for something you fixed in step 2.
   - Nothing that is already open in the repository. Search first —
     `gh issue list --label ready-for-agent` — and the tool refuses a title
     that is already there anyway.
   - Nothing outside the brief's scope. A leftover is about the code this
     brief touched; if you notice something else worth doing, say it in your
     report rather than filing it.

6. **Report.** One short report at the end: what you fixed, and what you filed
   (one line per issue). Nothing else. If you changed anything in this turn,
   say so.
