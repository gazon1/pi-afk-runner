# Coding standards

The rules a **reviewing** agent applies when it reads a diff. They are the rules
that no gate checks, because a gate can only check what has a shape.

Everything here has a machine-checked counterpart somewhere, and the counterpart
is named. A rule whose check does not exist yet is a rule the review must carry
alone — those are the ones worth reading twice.

Read `AGENTS.md` first: it is the operating manual, and this file does not
repeat it.

---

## The review reads the change, not the diff

A diff shows what changed. A review has to answer what the change *does* — and
those are different questions. The three cases that cost a reviewer the most:

1. **A change that adds a surface and wires nothing to it.** The code compiles,
   the tests pass, and nobody can reach it. The repository has a gate for this
   (`scripts/find-unwired-surfaces.py`), but the gate only knows about the
   surfaces it knows about.
2. **A change that removes a caller and leaves the callee.** The dead code is
   still exercised by its own test, so the suite stays green and the behaviour
   nobody uses stays alive.
3. **A change that makes a message say less.** The feature works; the sentence
   that tells the user what happened got shorter, and now it says nothing that
   can be acted on.

Ask, for every added public entry point: **who calls it?** If the answer is
"nobody yet", that is either a follow-up the diff names or a surface that ships
dead.

---

## Write tools propose; they do not write

A tool the assistant can call writes to a user's data. The write path in this
repository is a **proposal**: the change is held, the user reads it, the user
decides. That is the whole point of the proposal model, and it is checked by
`shared/src/jvmTest/.../feature/ai/tools/WriteToolsOnlyProposeTest.kt` — a
test, not a registry of exceptions: a file listing the exceptions is a second
thing to keep in step with the code, and the code can change without it.

A reviewing agent holds this line even where the test cannot:

- **A tool that writes directly needs a written reason.** There is no registry
  any more, so the reason is written in the change that introduces the writer:
  what it writes, and why it cannot propose yet. A new direct writer without
  that reason is a finding, and the fix is either to convert the tool or to
  write the reason down.
- **The set of direct writers must shrink.** A tool that was converted has its
  test moved to the proposing side. A set that only grows is a work queue
  nobody is working through.
- **The assistant's words must match what happened.** A tool that proposed a
  change says the change was *proposed*. It does not say the task was changed,
  and it does not say it was saved. The user has not agreed to anything yet.

---

## A gate that cannot fail is a gate that reports success forever

Every gate in this repository has a **positive control**: a mutation that makes
it fail, checked by `scripts/check-gate-wiring.py`. A gate nobody has tried to
break is a gate nobody knows can fail.

A reviewing agent applies the same standard to the diff it is reading:

- **A new gate needs a control.** A gate whose input is a committed file gets a
  sabotage of that file; a gate whose input is synthesised gets a fixture. If
  the diff adds a gate and no control, the gate is a green light wired to
  nothing.
- **A gate must be able to say no.** A gate that reports success on an empty
  input, or that swallows its own findings, is worse than no gate: it converts
  "not checked" into "checked and green".
- **A registry is checked, not written.** When a diff adds a list — a table, a
  catalogue, a set of names — ask what checks it against the code. A list that
  nothing checks is a sentence that reads like a fact.
- **A gate that derives a set from the tree proves the set is complete.** A gate
  that reads the classes, the suites or the modules out of the source and then
  checks the ones it found has proved nothing about the ones it did not find:
  the naming convention it reads, the sub-tag it ignores, the module it has no
  mapping for. The gate's set is compared with an *independent* enumeration —
  a second way of listing the same thing — and the comparison is part of the
  gate, not a note in the pull request. The slow-class rule is the shape of
  this: `unmapped_slow_classes` walks the test roots itself and names the
  slow classes that live in a root it does not map, instead of trusting a
  test to notice.

---

## A number that the tree can change is generated, not written

A count is a claim about the tree, and the tree moves. A number written by hand
in a living document is a claim that starts true and quietly stops being true:
`docs/engineering/script-tooling-audit.md` says the corpus is 1676 Kotlin
files, and the tree is now 1915 (`git ls-files '*.kt' | wc -l`). Nothing
failed — the number was true when it was written, and nobody reading it could
tell it apart from a number that was still true.

- **A count that the tree can change comes from a generator.** The repository
  already does this for the tag catalogue (`Maestro/TAGS.md` is generated and
  checked against `TestTags.kt`) and for the gate catalogue
  (`docs/tools/catalog.md`). A new count follows the same road: a generator, a
  golden file, and a gate that says when the file is stale.
- **A decision record is history; a living document is the present.** An ADR
  states what was decided at a moment, and its numbers are the numbers of that
  moment — they are not a defect when the tree moves on. A document that
  describes the tree *now* — `AGENTS.md`, `docs/architecture/`, a catalogue —
  states what is true now, and a number in it is a claim that has to be checked.
  A reviewer reads a changed number in an ADR as a record and in a living
  document as a claim.
- **The reviewer compares the numbers in the diff with the tree.** When a diff
  touches a document that states a count, the count is the first thing to
  check: a number that does not match the tree is a defect even when nothing
  else in the diff is wrong.

---

## A claim about CI names the workflow, the run and its conclusion

"I checked CI and it is green" is not evidence while the repository runs
several workflows: the one that answered "success" may have been the cache
cleanup. A session that read the first successful line of a run list reported
a green CI for a red branch, and the correction cost the reader a second pass
over the logs.

- **The claim is a whole line.** The workflow that decides, the run, and what
  it concluded. `python3 scripts/ci-verdict.py <ref>` prints exactly that line
  and exits with the conclusion — 0 for `success`, 1 for anything else, 2 when
  there is no run at all, 3 when the run list could not be read. A missing run
  is not a pass, and a list that could not be read is not a run.
- **A run id on its own is not a claim.** "Run 39888582872" says nothing about
  which workflow it was. The reviewer asks for the line the tool prints.
- **The reviewer checks the claim against the branch.** A diff that says the
  change is green names the run it means, and the run is of the branch the diff
  is on.

---

## The message says what happened

The repository's naming convention (`2026-10-21-green-means-one-thing.md`) is
one sentence: **green means one thing**. In practice:

- A message that names the cause beats a message that names the category.
  "There is no task with id `t-42`" beats "Task not found".
- A refusal says which part of the request was wrong and what the valid
  alternatives are. "That operation is not one of these: `set_due_date`,
  `set_priority`" is actionable; "invalid operation" is not.
- A failure is reported where it happened, not flattened into a generic error
  at the edge.

A reviewer checks the messages of the diff, not only the code paths — the
message is the part a user reads.

---

## A change the user cannot see is a change nobody decided about

Three rules about the same mistake: the change is lost, and the loss is silent.
A reviewer applies them to any change that writes, decides, or reads something
the user is looking at.

- **A change that cannot be applied keeps its reason next to it, on every surface
  that shows the change.** A screen that reports a failure into a channel nobody
  reads is a silent failure, and the surfaces of one feature are not one screen:
  when a change gains a way to fail, every surface that shows the change has to
  show the failure too. (The note editor emitted its errors and nobody read them:
  the change failed on one surface and succeeded on another, and the user could
  not tell which had happened.)
- **A change that writes several rows writes all of them or none of them, and the
  compensation covers the cancellation.** A cancelled coroutine is not a failed
  one: the rows written before the cancellation stay written, and if the change
  goes back to waiting, the next attempt writes them again. The compensation
  belongs where it runs on both paths — a `finally` under `NonCancellable` — and
  not only in the branch that handles a failure.
- **A value that cannot be read does not make the change disappear.** When a
  typed value is read back from storage and it no longer reads — an enum lost a
  variant, the spelling changed — the change is shown with the reason it cannot
  be read. Dropping the item is the one outcome the user cannot act on: they
  cannot turn down a change they cannot see.

Underneath all three: **the user must be able to decide about every change that
is proposed to them.** A change that vanishes, a change that fails without
saying so, and a change that is written twice are one defect wearing three
shapes.

---

## Text a person may want to copy is selectable

The convention table in
`.agents/skills/singularity-todo-selectable-text/SKILL.md` says, per file,
whether its text is `selectable`, `excluded`, or `prose`, and it is checked by
`scripts/check-selectable-text-coverage.py`.

For a diff that adds a screen or a card:

- **Text that states a fact, a title, or a message is `selectable`.** A person
  reading "Nothing to review" may want to paste it into a bug report.
- **A control's label is `excluded`** — a button's text is a gesture, not a
  message.
- **A shared component that renders selectable text makes its callers
  selectable too.** A screen that renders the shared empty state is
  `excluded` *for that text*, and the screen's own text decides the rest.

When a file changes its text, its row in that table changes with it. The table
is a claim about the code, and the gate compares the two.

---

## One implementation per question

Two answers to the same question drift. The repository has a decision for most
of them: one card for a proposal, one search implementation, one event bus
consumer, one registry per subject.

A reviewing agent watches for the version that is not a gate:

- A second card that renders a proposal, when one already renders it — the
  second copy will not get the fix.
- A second place that decides the same thing, where the two can disagree.
- A private copy of a shared component, because the shared one does not quite
  fit yet. The fit is a change to the shared one; the copy is a change to the
  truth.

---

## A path that applies a document writes all of it — and only what it carries

A document is more than the row it arrives in. A task is the row, the tag
cross-refs, the blocking edges, and the links its description implies; a note
is the row, its folder, its attachments, its outgoing links.

A path that applies a document writes every part of it. A path that applies
*part* of a document says which part, and leaves the rest alone.

And a part the document does not carry is not written at all. The wire carries
the fields the sending device knew about, so the absence of a part is the
absence of a claim — not a claim that the part is empty. A device that sends
no `tags` key says nothing about the tags, and a writer that reads the empty
list the decode produces takes the tags off the task. The difference is
carried in the type: a part of a document is nullable, and `null` means the
document says nothing about it.

A reviewing agent watches for the path that writes the row and stops:

- A write that upserts a row but not the cross-refs the row implies. The
  `@Upsert` replaces the whole row, so the parts that were not written are not
  left alone — they are reset.
- A write that takes a field it was given and writes it, when the field was
  empty because the reader does not load it. An empty tag list on a task read
  through `get()` is the absence of a claim, not a claim that there are no
  tags.
- A writer that drops a column of the row, because the domain model has no
  field for it. The column is still reset on every write.
- A repair that copies the fields of a row onto the rows around it, when the
  writer had no claim about one of them. The arrival of a row that is new on
  this device holds no tags, and a repair that copies them takes the tags off
  every other member of the series.
- A double that stores the whole task, and therefore turns an absent claim
  into a deletion. A fake that lies about the contract makes every test
  written against it a test of the fake.

---

## An invalid payload leaves the previous data untouched

An untrusted payload (a backup archive, a sync delta, an imported document) is
verified in full — decoded, migrated, schema-checked — before any row is
written. If any part of that fails, the whole import fails and the previous data
stays intact: no partial apply, no crash.

- Validation happens outside the write transaction. A decode or migration
  failure throws before the transaction opens.
- The transaction is all-or-nothing: a failure inside it rolls back every write
  made by that import.
- A payload that does not verify is ignored, never half-applied.

A reviewing agent watches for:

- A write that starts before the payload is fully validated.
- A partial apply that catches an exception mid-loop and continues.
- A fallback that silently substitutes empty data for a missing or invalid part.

---

## A push carries what the database holds

A device that sends a part says what the part is. On the wire an empty tag
list is a claim — "the work has no tags" — and the server applies it, and
every other device loses the tags on the next pull. The wire has no state for
"I did not look": only for "here is the value" and "here is the emptiness".

So a device that did not look must not send the emptiness. A task read
through `get()` carries no tags and no blocking edges — they live in
cross-ref tables — and a write path that pushes the caller's task sends the
emptiness of the read as a claim about the work. The write path has to push
the task as the database holds it: the row, the tags and the edges, read back
after the write.

A reviewing agent watches for the path that enqueues and stops:

- An enqueue of the caller's task rather than of the task the database holds.
  The two differ exactly where a part lives outside the row.
- An enqueue of a row that was read without its cross-refs — a bulk archive
  that pushes `row.toTask()` sends "the work has no tags" for every task it
  archives.
- A second copy of "what a task is for the wire". One assembly
  (`TaskDao.freshTask`) answers the question for every caller; a copy drifts,
  and the drift is silent.
- A device that means "this work has no tags" — that is a claim, and it is
  allowed. The defect is the claim the device did not mean.

The mechanical part is a gate: `TaskRowWriterTest` checks that every column of
the task row has a writer in the mapper the repository uses, and that a column
without one is declared out loud; the behaviour is `TaskDocumentWriteTest`,
and the wire level is `TaskDocumentPartsTest`.
The judgement the gate cannot make — is this path applying a document or a
part of one — is what the reviewer reads for.

---

## The wire's field list is the model's own list

The names a document may carry are the model's own names. A list of them
written out beside the model is a copy, and a copy is kept in step by somebody's
memory: a field added to a model is forgotten in the list, and the field is
sent and dropped by the server, and nobody says so.

So the list is derived — from the model's serial descriptor, which is what the
encoder writes from — and what is written by hand is the *exception*: the four
fields the server owns.

A reviewing agent watches for:

- A hand-written list of field names next to a model. The names are the model's
  own, and the only place a name belongs is the subtraction.
- A subtraction of a name the model does not have. That is a typo, and it does not
  subtract anything: the field stays in the list, the server is told it may write
  it, and the model's own bookkeeping becomes writable by the server.
- A list that is compared with the model by parsing the model's source. A parser
  that misreads a model reads less, and the check passes on a tree it did not
  really read — that is how three field names went missing from the server's
  seed while the gate that checked it stayed green.
- A server's field table that names a field outside the derived server list.
  That name is a field the server may write and nothing ever writes, and it
  reads like a rule.
- A check that reads only the first statement of a migration, or only one
  migration. The table is everything every migration holds for it, and a check
  that reads less of the tree than it says passes on a tree it did not really
  read — the same defect, one layer down.
- A reader that drops a row it cannot read. Every spelling SQL allows is a
  spelling the reader has to know, and a spelling it does not know is a row it
  must NOT lose: a dropped row is a field nobody sends, which is the direction
  that matters. Read the row the way the statement writes it — map the values
  onto the columns the statement names — and REPORT what you cannot read.
- A reader that ignores a statement it does not model — an update, a delete, a
  truncate, a merge, an upsert that renames a row, a copy into the table, a
  drop of the table or of its schema, a table made out of a query, an ALTER
  of the column's default. Those change what the server may write, and a gate
  that passes over them says nothing about the table it did not read. The
  list is not a guess: PostgreSQL writes rows into an existing table in six
  ways, and the reader reads the inserts and reports the other five.
- A reader that looks only at the statement and not at what it carries. An
  insert written as text inside a string — dynamic SQL, run by the migration
  when it applies — is a row the file holds, and the reader reads the string
  to find it. And the converse: a string in a value position is a value, and
  a reader that reads it as code reports a row the database never holds.
- A reader that reads a block of text as a value because of how the literal is
  spelled, or because of what stands between the keyword and the code.
  `execute E'…'`, `do E'…'` and `prepare x as E'…'` are statements the migration
  runs, exactly as their plain-quoted twins are: the `E` belongs to the
  literal, not to the text around it — and the escapes it holds are decoded, so
  a row written by an E-string is a row the reader reads.
  `do [language plpgsql] $$ … $$` is a body, too: the language clause stands
  between the keyword and the code, and the code runs.
- A reader that cannot place a write and passes over it. A write whose target
  the reader cannot tell — a placeholder, an expression, a name spelled
  through a call — is a write the gate cannot rule out, and it is reported
  whenever the table's name is in play: in the scope the write is in, or held
  in the file as a literal the file hands around. A write whose target IS a
  name is a write into the table that name stands for, and the reader tells
  the names apart by the name alone: it cannot tell a variable from a table,
  so `insert into v_table` is a write into a table named `v_table` — and what
  a variable holds is data the reader cannot follow. A migration that writes
  the field table through a variable is refused in review, not by this gate.
  A scope that SPELLS a write
  into the table is a scope where the name is in play — the text of that write
  may be carried into a variable and run later — and a scope that only READS
  the table spells no write and stays quiet. The same holds at the level of the
  file: a file that holds the TEXT of a write into the table is a file where
  the table's name is in play. A call may run what it is handed, so a call
  handed a name — a variable the reader cannot follow — in a scope that holds
  such a text is reported too. A body is a scope of its own AND
  a scope inside another: a nested body sees the scope it is nested in, so a
  write text the enclosing body holds is a write text the nested body may run.
  What the reader takes for a
  read is a read OUT of the table, because a read of the table cannot spell
  its own name. The one case the reader does not see is a name the write
  takes from the DATABASE at run time — out of a row, a setting, a function's
  return — the limit of static reading itself, since a reader that reads SQL
  cannot see a name that is not in it, and the name the write uses is data,
  not text.
- A reader that knows only one spelling of "a name assembled from pieces". A
  name spelled out of pieces is the name it spells, in every spelling of a
  literal — `'…'`, `E'…'`, `U&'…'`, `B'…'` and `$$…$$`, with a cast between two
  pieces or without one — and a name spelled out of a piece the reader cannot
  fold is a write into a PIECE of the name. That write is reported wherever
  the scope holds what the piece may be completed with, because the text the
  migration runs is assembled at run time. A piece on its own is not the name:
  `'field'` is a word, and a file may hold it without meaning the table.
  The name a piece spells is the SPELLING of the piece: a bit string and a
  hex string spell bytes, so `'sync_field_' || B'0110…'` spells the table's
  name and the write the file spells is the write the reader sees.
- A reader that reports one spelling of "a target the database refuses" and
  not another. The database does not accept a string where a table's name
  stands, so a target that holds one cannot run — whatever the string may be
  completed with — and the reader reports it whenever the string spells the
  table's name or a piece of it, in any position of the target. A target
  written as a NAME is another thing: the database may have a table by that
  name, and a name the reader cannot read is not reported.
- A reader that reads a NAME, a VALUE and a STATEMENT the same way. They are
  not the same: a bit string and a hex string hold BITS — the text a text
  column stores — and they spell bytes as well. A name assembled out of pieces
  is folded into the name the pieces SPELL, the value of a row is read as the
  value the pieces HOLD — the bits — and the text a statement the migration
  RUNS is the text the server runs: the bits, so a statement written as a bit
  string is reported as a migration that does not apply. A reader that read
  the bytes of a row or of a statement would read a text the server never
  holds, and a reader that read the bits of a name would miss a name the file
  spells.
- A reader that follows the table only by its own name, and misses the doors.
  A VIEW over the table is a second door into it — PostgreSQL writes through
  an automatically updatable view — a CHILD of the table is a third — PostgreSQL
  returns the rows of a child when the parent is queried, so a row written
  into the child is a row the server's own lookup finds — and a string that
  spells a write into the table and is handed to a CALL may be run by that
  call. All three are reported.
  What is NOT reported is a string that is stored: a column holds words, and
  `values ('insert into …')` puts a word in a column. Nor is a view
  PostgreSQL does not update — over an aggregate, or over a join: it is no
  door, and it is another table's business. Nor is a table shaped like the
  field table — `create table … (like sync_field_allowlist)`: it copies the
  shape of a table and not its rows.
- A reader that compares the SPELLING of a string instead of the text it
  holds. A write whose target is written as a string cannot run — the
  database does not accept a string where a table's name stands — so the
  reader reports it in every spelling of a string: `'…'`, `E'…'`, `B'…'`,
  `N'…'`, `X'…'`, `U&'…'`, `$$…$$`, `$tag$…$tag$`. The text inside them is
  the text the database reads: an E-string's escapes are decoded, and
  PostgreSQL drops the backslash of an escape it does not know, so
  `E'sync\_field_allowlist'` holds `sync_field_allowlist`; a `U&` string's
  unicode escapes are decoded too. A string that HOLDS the words of a write
  is not reported — the verb is inside the string there, and a column holds
  words. The text read is the text the DEPLOYED server reads: PostgreSQL 15,
  which is what `supabase/postgres:15.8.1.085` is — so `\v` is not an escape
  there, a constant that CONTINUES across a newline is one constant, its
  parts joined the way the server joins them, and a bit string and a hex
  string hold BITS, which is what a text column stores: `X'41'` is
  `01000001` in the server's table, and not the letter A. A bit string and a
  hex string spell bytes as well, and a file that writes the table's name in
  hex writes those bytes — so the reader reads both. A COMMENT between the
  parts is not whitespace the server drops: a block comment between them is
  a syntax error there, so the reader does not join the parts and reports
  the row it cannot read.
- A migration that writes the server's field table through a computed
  identifier. The field table is a contract, not data: it is written by a
  list of names, and a name the file does not spell is a name no reader of
  that file can report. The gate cannot catch it — the rule is what catches
  it, and the rule is the review.
- A row of a type neither the client nor the server is known to have. The
  server looks a type up by name, so such a row is a row the server never
  reads — and a type one spelling away from the client's is a row that was
  meant for the client and missed.

The mechanical part: `SyncContractIsTheSourceOfTruthTest` says the wire carries
exactly the derived list and that every subtracted name is a name the model has;
`SyncFieldAllowlistExportTest` says the committed export is what the models
declare; the gate `sync allowlist seed matches contract` says the seed is
current and that the server's table names no field outside the derived server
list.

---

## The spec and the code say the same thing

A spec that describes a behaviour the code does not have is worse than no
spec: it is a promise the code breaks on purpose, and the next reader believes
the promise.

A reviewing agent watches for a change that leaves the two apart:

- A scenario whose wording the implementation contradicts. Read the scenario
  against the code, not against the intent.
- A requirement that says "scoped by X" while the code scopes by Y. One of them
  is wrong, and the difference is a behaviour, not a wording.

The fix is in the same commit as the code: the spec is corrected to say what
the code does, or the code is changed to do what the spec says. "Later" is how
the two drift apart in the first place.

---

## A rename reaches every surface that names the old thing

A rename is a change with more than one edit, and the edits that are missing are
the ones nobody notices — because the missing surface is a sentence in a
document, or a label in a registry, or a path in a script that only fires in a
branch of the workflow.

- **Every surface that names the old name changes with it.** A command, a file
  path, a label, a workflow branch condition, a registry entry, a generated
  catalogue — whatever carries the old string.
- **A document that asserts the old behaviour changes in the same commit.** A
  document that says "the floor is 27" after the floor moved to 29 is not stale
  documentation; it is a false claim that a reader will trust, and it outlives
  the code it described. Fixing the sentence is part of the change, not a
  follow-up for someone else to find.
- **The claim has to be checked against the world, not against the diff.** A
  reviewer asks: does this sentence still hold? Not "did this sentence change?"
  A rename that leaves the workflow's branch unreachable is a rename that
  deleted a feature.

The gate cannot see this. It can see that a file was edited; it cannot see that
a sentence elsewhere became false. That is the review's work.

---

## A rule that replaces a rule names what it replaced

The search had a rule: *a record that carries the word in its title is a
better answer than one that carries it in its body.* A branch replaced it with
a predicate — `SearchMode.matches(record, term)`, which asks about the
record's whole surface list. The replacement was correct in itself, and it
took the ranking with it: the ranking asks about *one* surface, and the new
predicate asks about all of them.

Nothing failed. The corpus case for the ranking supplies its own predicate, so
it passes whatever the use case asks, and nothing asserted the order through
the use case. **The review caught it before the merge** (PR #1047, round one):
the ranking asks the rule about the title alone now —
`mode.matches(record.record.title, term)`, inside `titleMatchesFirst`.

The lesson is not about that rule. It is about what a change that replaces a
rule owes its reader:

- **Which behaviour the old rule produced, and what produces it now.** In
  words, not in the shape of the new code: "the title question is now asked of
  the title alone" is a claim a reviewer can check against the tree; "the
  ranking moved into `titleMatchesFirst`" is a description of the diff.
- **The corpus carries a case that fails if the behaviour comes back
  missing.** A replacement whose corpus cannot tell the difference between the
  old behaviour and the new one has not proved that it kept anything — and a
  corpus that brings its own predicate proves nothing about the wiring.

A replacement without both is a deletion that reads as a refactoring.

The two halves are not equally mechanical. The corpus case **is** a gate: it
fails when the behaviour comes back missing. What no gate can make is the
judgement — that the behaviour which went missing was one anybody wanted, and
not one nobody had noticed for a year. That judgement is the review's work.

---

These are checked; a reviewer verifies the check was run rather than
re-deriving them.

| Rule | Checked by |
|---|---|
| Fakes, not mocks; mocks only for outgoing calls | `AGENTS.md`, review |
| A document writes only the parts it carries; a part it does not carry is not written | `TaskDocumentPartsTest`, `TaskDocumentWriteTest`, `ProjectDocumentWriteTest`, review |
| A push carries what the database holds; the emptiness of a read is not a claim | `TaskPushClaimTest`, `TaskDaoArchiveRepositoryImplTest`, review |
| The wire's field list is the model's own list; only the exceptions are written | `SyncContractIsTheSourceOfTruthTest`, `SyncFieldAllowlistExportTest`, `scripts/check-sync-allowlist-regenerated.py` |
| Every test class carries `@Tag` (`fast`, or `slow` when it crosses a process boundary) | `TestTagCoverageTest` |
| No `delay()` in tests — virtual time and `awaitState` | detekt `NoRealDelayInTest` (a delay over 500 ms) + review |
| ViewModels take an injected `AutoCloseableCoroutineScope`; never `viewModelScope` | detekt + review |
| No pass-through use cases | `PassThroughUseCase` detekt rule |
| No `stateIn` in a ViewModel | detekt `NoStateIn` + review |
| No `runBlocking` in production code | detekt + review |
| `catch (CancellationException)` before a general `catch` | detekt |
| A swallowed exception keeps its cause | detekt `SwallowedException` |
| Room schema changes bump `SCHEMA_VERSION` and add a migration | `scripts/check-room-schema-integrity.py` |
| New ports bind in both `PlatformModule.*.kt` | `scripts/check-platform-reference-ports.py` |

---

## What the reviewer reports

A finding is a **defect with a place and a consequence**, not a preference.
Three parts:

1. **Where.** `file:line`, and the symbol.
2. **What is wrong.** The consequence — what a user or a caller gets that
   they should not get.
3. **What would make it right.** The fix, or the question that has to be
   answered first.

A finding that cannot be acted on is not a finding. "Consider extracting this"
is a preference; "this function is called from two places that disagree about
the unit, so the second caller multiplies by 1000" is a finding.

And the reviewer says when the diff is fine. A review that produces findings to
prove it looked is as useless as a gate that never fails.
