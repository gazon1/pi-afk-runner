/**
 * The run's journal: the lines a reader sees while the agent works, and the
 * file they are written to.
 *
 * The session writes the lines: the adapter reads them off the engine's answer
 * and hands them here, so a line is spelled the same way whoever reads it.
 *
 * The file's shape is written here too — its directory, its name, its header
 * line and the factory that appends to it — because two pipelines write a
 * journal and a rule written twice is a rule whose two copies drift. A
 * pipeline that writes a journal names what the run was about; this module
 * says what the file looks like.
 *
 * The run's other files are named here too: the record and the gates' log sit
 * beside the journal, in the directory this module chose, and their names are
 * asked for the way the journal's name is.
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";

import type { SessionFactory } from "./session.js";

/**
 * What a run was about: the issue's number, or the pull request's.
 *
 * It is the only thing a pipeline names. The journal's own shape — where it
 * lives, what it is called and how it starts — is decided here, so a third
 * pipeline writes the same shape without spelling it again.
 */
export type JournalSubject =
  | { readonly kind: "issue"; readonly number: number }
  | { readonly kind: "pull request"; readonly number: number };

/**
 * Where the journal of a run lives.
 *
 * `build/diagnostics/issue-<N>/` for a run about an issue, and
 * `build/diagnostics/merge/pr-<N>/` for a run about a pull request. The
 * journal sits beside the run's record, in the same directory.
 */
export function journalDirectory(root: string, subject: JournalSubject): string {
  return subject.kind === "issue"
    ? join(root, "build", "diagnostics", `issue-${subject.number}`)
    : join(root, "build", "diagnostics", "merge", `pr-${subject.number}`);
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
 * The record's file name: the run's own id and the `.md` extension.
 *
 * The record is the document a person reads, and it sits beside the journal.
 * One place says its name, so the writer of the record and the reader of it
 * are talking about the same file.
 */
export function recordFileName(runId: string): string {
  return `${runId}.md`;
}

/**
 * The gates' log file name: the run's own id and the `-gates.log` extension.
 *
 * The whole of what the gates printed goes there, beside the record. The work
 * run and the merge run both open one, and they ask for the name here — two
 * pipelines spelling the same name are two names that can drift.
 */
export function gatesLogFileName(runId: string): string {
  return `${runId}-gates.log`;
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
 * The journal of a run: the session's lines, written while the run works.
 *
 * The factory is wrapped, so every session the run opens — the work session,
 * the review, the fixes — writes to the same file. The lines are appended as
 * they come, and a line that cannot be written is dropped: a journal that
 * cannot be written is not a reason to stop the run.
 */
export function journalFactory(factory: SessionFactory, path: string): SessionFactory {
  return async (sessionOptions) => {
    const write = (line: string): void => {
      try {
        appendFileSync(path, `${line}\n`, "utf8");
      } catch {
        // The journal is a witness, not a gate: the run goes on without it.
      }
    };
    return factory({ ...sessionOptions, onEvent: write });
  };
}

/**
 * One line about a tool call: the tool, and the command when there is one.
 *
 * It is the run's journal, and a journal reads one fact per line: the tool's
 * name, and the command when the call carried one. A long command is cut —
 * the whole of it is in the engine's own log.
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
 * The lines an assistant text block contributes to the run stream.
 *
 * A text block can hold several lines — the final summary usually does — and
 * every one of them is tagged, so no line of the stream reads as runner
 * output. A blank line carries nothing and is dropped.
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
