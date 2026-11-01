# Say what follows from the work

The change is made, the gates have run, and you have checked your own work. Now
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

2. **Fix the cheap ones yourself.** A leftover is cheap when it is small, when
   it stays inside the brief's scope — does the change do what the brief asked,
   and only that? — and when the gates stay green. Fix it now, and run the
   gates again, with the same commands the implementing turn ran: what you
   change in this turn goes into the same pull request, so it is gated like
   everything else in it. A fix that was not gated is not a fix.

3. **File the rest as issues in the target repository.** Use the
   `agent_leftover` tool, not a shell command: the tool is what keeps the queue
   bounded. Each leftover becomes an issue whose body is a brief, written in
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

4. **Respect the bounds.**
   - At most three leftovers a run. The tool refuses the fourth.
   - Nothing for something you fixed in step 2.
   - Nothing that is already open in the repository. Search first —
     `gh issue list --label ready-for-agent` — and the tool refuses a title
     that is already there anyway.
   - Nothing outside the brief's scope. A leftover is about the code this
     brief touched; if you notice something else worth doing, say it in your
     report rather than filing it.

5. **Report.** One short report at the end: what you fixed, and what you filed
   (one line per issue). Nothing else.
