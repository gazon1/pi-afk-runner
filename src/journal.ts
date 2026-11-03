/**
 * The run's journal: the file a run writes while it works, and the spelling
 * of the lines it holds.
 *
 * The session writes the lines: the adapter reads them off the engine's answer
 * and hands them here, so a line is spelled the same way whoever reads it.
 *
 * The file's shape is written here too — its directory, its name, its header
 * line and the factory that appends to it — because several pipelines write a
 * journal and a rule written twice is a rule whose two copies drift. A
 * pipeline that writes a journal names what the run was about; this module
 * says what the file looks like.
 *
 * The lines a reader sees are the run's log, and the adapter's log module
 * prints them (`src/mastra/log.ts`).
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";

import type { SessionFactory } from "./session.js";

/**
 * The words that name what a run was about.
 *
 * They are written here, once. The subject's kind is one of them, and the
 * constructors below are the only way a caller names a kind — so a pipeline
 * that writes a record cannot spell the subject a third way.
 */
const SUBJECT_WORDS = {
  issue: "issue",
  pullRequest: "pull request",
} as const;

/**
 * What a run was about: the issue's number, or the pull request's.
 *
 * It is the only thing a pipeline names. The journal's own shape — where it
 * lives, what it is called and how it starts — is decided here, so a third
 * pipeline writes the same shape without spelling it again.
 *
 * Its kinds are the words above, so the wording of the subject is written
 * once — and the record and the journal both read it from here.
 */
export type JournalSubject =
  | { readonly kind: typeof SUBJECT_WORDS.issue; readonly number: number }
  | { readonly kind: typeof SUBJECT_WORDS.pullRequest; readonly number: number };

/**
 * The subject of a run about an issue.
 *
 * The number is the issue's. The kind is the word the record and the journal
 * both read, and it is spelled in one place.
 */
export function issueSubject(number: number): JournalSubject {
  return { kind: SUBJECT_WORDS.issue, number };
}

/**
 * The subject of a run about a pull request.
 *
 * The number is the pull request's. The kind is the word the record and the
 * journal both read, and it is spelled in one place.
 */
export function pullRequestSubject(number: number): JournalSubject {
  return { kind: SUBJECT_WORDS.pullRequest, number };
}

/**
 * The directory the merge pipeline's own files live in.
 *
 * The per-pull-request directories are in it, and the sweep's journal is the
 * file beside them.
 */
function mergeDirectory(root: string): string {
  return join(root, "build", "diagnostics", "merge");
}

/**
 * Where the journal of a run lives.
 *
 * `build/diagnostics/issue-<N>/` for a run about an issue, and
 * `build/diagnostics/merge/pr-<N>/` for a run about a pull request. The
 * journal sits beside the run's record, in the same directory.
 */
export function journalDirectory(root: string, subject: JournalSubject): string {
  return subject.kind === SUBJECT_WORDS.issue
    ? join(root, "build", "diagnostics", `issue-${subject.number}`)
    : join(mergeDirectory(root), `pr-${subject.number}`);
}

/**
 * Where the sweep's journal lives.
 *
 * The sweep is not a subject: a subject names a run by its number, and the
 * sweep has none — it is the run that works on the pull requests. Its journal
 * is the file beside the directories their own journals are in.
 */
export function sweepJournalDirectory(root: string): string {
  return mergeDirectory(root);
}

/**
 * The line the sweep's journal starts with.
 *
 * It names the run and what the run was about, the same way the other
 * journals' first line does.
 */
export function sweepJournalHeader(runId: string): string {
  return `# run ${runId}, the merge sweep`;
}

/**
 * The line a journal file starts with.
 *
 * It names the run and what the run was about, so a reader who opens the file
 * knows which run it belongs to before reading a line of it.
 */
export function journalHeader(runId: string, subject: JournalSubject): string {
  return `# run ${runId}, ${subject.kind} ${subject.number}`;
}

/**
 * The journal's file name: the run's own id and the `.log` extension.
 *
 * One place says it. The run writes the file under this name and the record
 * names the file the run wrote, so the name in the record cannot drift from
 * the name on the disk.
 */
export function journalFileName(runId: string): string {
  return `${runId}.log`;
}

/**
 * The journal's path: the run's own directory, the run's id, the `.log`.
 *
 * The journal sits beside the record — the same directory — so a reader who
 * opens the record finds the journal in the same place.
 */
export function journalPath(directory: string, runId: string): string {
  return join(directory, journalFileName(runId));
}

/**
 * The journal's writer: a line at a time, appended as the line comes.
 *
 * A line that cannot be written is dropped: a journal that cannot be written
 * is not a reason to stop the run.
 */
export function journalWriter(path: string): (line: string) => void {
  return (line: string): void => {
    try {
      appendFileSync(path, `${line}\n`, "utf8");
    } catch {
      // The journal is a witness, not a gate: the run goes on without it.
    }
  };
}

/**
 * The journal file of a run: the session's lines, written while the run works.
 *
 * The factory is wrapped, so every session the run opens — the work session,
 * the review, the fixes — writes to the same file. The lines are appended as
 * they come, and a line that cannot be written is dropped: a journal that
 * cannot be written is not a reason to stop the run.
 *
 * A journal that is already wrapped keeps its own listener: the lines go to
 * both files, so the merge sweep's journal and the pull request's own journal
 * each hold the lines of the session they share.
 */
export function journalFactory(factory: SessionFactory, path: string): SessionFactory {
  const write = journalWriter(path);
  return async (sessionOptions) => {
    return factory({
      ...sessionOptions,
      onEvent: (line: string) => {
        write(line);
        sessionOptions.onEvent?.(line);
      },
    });
  };
}

/**
 * One line about a tool call: the tool, and the command when there is one.
 *
 * It is a line of the run's log, and a log reads one fact per line: the tool's
 * name, and the command when the call carried one. A long command is cut —
 * the whole of it is in the engine's own record.
 */
export function describeToolCall(event: { toolName: string; input?: unknown }): string {
  const input = event.input;
  const command =
    typeof input === "object" &&
    input !== null &&
    "command" in input &&
    typeof (input as { command: unknown }).command === "string"
      ? (input as { command: string }).command
      : undefined;
  if (command === undefined) {
    return event.toolName;
  }
  const first = command.split("\n")[0] ?? "";
  return `${event.toolName}: ${first.length > 120 ? `${first.slice(0, 120)}…` : first}`;
}

/**
 * The lines an assistant text block contributes to the run's log.
 *
 * A text block can hold several lines — the final summary usually does — and
 * every one of them is tagged, so no line of the log reads as the runner's
 * own output. A blank line carries nothing and is dropped.
 */
export function assistantTextLines(text: string): string[] {
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() !== "") {
      lines.push(`· ${line}`);
    }
  }
  return lines;
}
