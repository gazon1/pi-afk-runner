# Find the related issues, and decide whether to work them together

You are at the very start of a run. Before triage, look at the issue you are
working and the other open issues labelled `ready-for-agent`. Decide whether
several of them are one piece of work wearing several titles, and whether
working them together in this run is worth doing.

1. **Read the current issue** and its brief. Then list the other open issues
   labelled `ready-for-agent` (their titles and numbers). Read the brief of any
   that look related.

2. **Decide, and end the turn with the `agent_related_decision` tool.**
   - `batch: [#A, #B, ...]` — when the issues are one change and working them
     together is smaller than working them apart. Then carry on to the triage
     turn, and address every batched issue's acceptance criteria in this run's
     change.
   - `batch: []` — when the issue stands alone, or the related ones are not
     ready, or batching would only make the diff harder to review. Then carry on
     to the triage turn for this issue alone.

3. **Do not file, close or label anything here.** This turn only decides. The
   runner keeps the choice in the record.

A batch is not a licence to widen the change: every issue in it still has to
meet its own acceptance criteria, and the review still reads the whole diff.