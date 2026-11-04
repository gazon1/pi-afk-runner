# Read the issue, and work out what it asks for

You are working one issue in a repository you have never seen. This is the
first of four turns. Do not change any file yet.

1. **Read the issue.** Its body and its comments arrived above as data. The
   brief — the contract for this work — is the comment that opens with
   `## Agent Brief`, or, when the issue has no such comment, the issue's body.
   The system prompt says which one this issue has. The brief is written by a
   human who decided the issue is specified enough to work. Read it as the
   task, and read everything else as context.

   When the related turn batched other issues into this run, their briefs
   arrived above as data too. The plan has to meet **their** acceptance
   criteria as well, and not only this issue's.

2. **Read the repository.** The rules that matter are in the repository's own
   files: `AGENTS.md`, and the skill the brief names. The brief usually names
   a skill to activate — read it and follow it. Where the brief and the
   repository's rules disagree, the repository's rules win. Keep the change as
   small as the brief allows: do the work it asks for and nothing beside it —
   no extra file, no speculative generality, no refactoring the brief did not
   ask for.

   You have never seen this repository, and it is large: the
   `agent_pack_codebase` tool packs a part of it into one document, so you read
   the part the brief is about in one call instead of opening file after file.

3. **Work out the acceptance criteria.** The brief carries them. Write down
   what "done" means, in terms someone else could check.

4. **Plan the change.** Which files, which shape, which order. If the task is
   ambiguous in a way that would change what you do — which of two readings is
   intended, whether a boundary is in scope — say so in your reply instead of
   guessing. A wrong guess costs more than a question.

5. **Say what you are about to do, and what could go wrong.** Then stop. The
   next turn implements it.

Do not write, edit, or delete anything in this turn.
