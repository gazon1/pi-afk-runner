# Find the related issues, and decide whether to work them together

You are at the very start of a run. Before triage, look at the issue you are
working and the related issues the runner fetched for you — they are above this
instruction, as data. Decide whether several of them are one piece of work
wearing several titles, and whether working them together in this run is worth
doing.

1. **Read the current issue** and its brief. The fetched list is the whole
   pool: every open `ready-for-agent` issue nobody has claimed, except this
   one, each with the title that says what it is about. Read the brief of a
   candidate only when its title leaves you in doubt —
   `gh issue view <n> --json body,comments`.

2. **Decide, and end the turn with the `agent_related_decision` tool.**
   - `batch: [#A, #B, ...]` — when the issues are one change and working them
     together is smaller than working them apart. Then carry on to the triage
     turn. The runner reads the batched issues' briefs and hands them to the
     scope turn, the plan, the review and the fix, so the change meets their
     acceptance criteria too.
   - `batch: []` — when the issue stands alone, or the related ones are not
     ready, or batching would only make the diff harder to review. Then carry
     on to the triage turn for this issue alone.

   The numbers are the fetched ones: a number that is not in the list above is
   refused, because nobody fetched it.

3. **Do not file, close or label anything here.** This turn only decides. The
   runner keeps the choice in the record, and links the batched issues to the
   run that worked them.

A batch is not a licence to widen the change: every issue in it still has to
meet its own acceptance criteria, and the review still reads the whole diff.
