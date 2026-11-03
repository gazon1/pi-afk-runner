/**
 * The lines the runner prints while the agent works, and the file they are
 * written to.
 *
 * Under systemd the journal is not a TTY, so chalk emits no colour and every
 * line is the same shape on the page. The marker is then the only thing that
 * says whether a line came from the agent or from the runner, and the tool
 * calls have to carry one too.
 *
 * The file the lines go to has a shape too — where it lives, what it is called
 * and how it starts — and one place says it, so a reader who learns it from
 * one pipeline's file knows it from the other's.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

import chalk from "chalk";
import { describe, expect, it } from "vitest";

import {
  gatesLogFileName,
  journalDirectory,
  journalFactory,
  journalFileName,
  journalHeader,
  journalPath,
  recordFileName,
} from "../src/journal.js";
import { logTurn, refusalLine, type TurnAnswer } from "../src/mastra/log.js";
import type { AgentSession } from "../src/session.js";

/** A turn the agent answered with: one tool call and one spoken line. */
function answerWith(call: unknown, text: string): TurnAnswer {
  return {
    toolCalls: call === undefined ? [] : [{ payload: { toolName: "agent_test", args: call } }],
    text,
  } as unknown as TurnAnswer;
}

describe("the lines the runner prints", () => {
  it("marks the agent's speech, and drops the blank lines", () => {
    const lines: string[] = [];
    logTurn(
      answerWith(undefined, "Running the gates.\n\nThe gates are green."),
      (line) => lines.push(line),
    );
    expect(lines).toEqual(["· Running the gates.", "· The gates are green."]);
  });

  it("marks the tool calls, and says which command they ran", () => {
    const lines: string[] = [];
    const level = chalk.level;
    try {
      chalk.level = 0;
      logTurn(
        answerWith({ command: "npm run check" }, "done"),
        (line) => lines.push(line),
      );
      expect(lines[0]).toBe("  → agent_test: npm run check");
    } finally {
      chalk.level = level;
    }
  });

  it("says that a call was refused, and only that", () => {
    // A refusal is over; a reader has to see that it is over.
    expect(refusalLine("Refused: pytest -q. Do not run the checks.")).toBe(
      "  ↳ Refused: pytest -q. Do not run the checks.",
    );
    expect(refusalLine("the leftover is filed")).toBeUndefined();
    expect(refusalLine(undefined)).toBeUndefined();
  });

  it("says nothing when there is nothing to say", () => {
    const lines: string[] = [];
    logTurn({ toolCalls: [], text: "" } as unknown as TurnAnswer, (line) =>
      lines.push(line),
    );
    expect(lines).toEqual([]);
  });

  it("writes nothing when no one is listening", () => {
    // A turn with no journal writes nothing at all — the run may not want a
    // journal, and asking for one must not break the turn.
    expect(() => logTurn(answerWith(undefined, "done"))).not.toThrow();
  });
});

describe("the journal file", () => {
  it("names the run and what the run was about", () => {
    // The first line says whose file this is, before a reader reads any of it.
    expect(journalHeader("run-1", { kind: "issue", number: 42 })).toBe(
      "# run run-1, issue 42",
    );
    expect(journalHeader("run-2", { kind: "pull request", number: 7 })).toBe(
      "# run run-2, pull request 7",
    );
  });

  it("lives beside the run's record", () => {
    // The work run's diagnostics and the merge run's are different places,
    // and each is spelled the same way whoever asks for it.
    expect(journalDirectory("/repo", { kind: "issue", number: 42 })).toBe(
      join("/repo", "build", "diagnostics", "issue-42"),
    );
    expect(journalDirectory("/repo", { kind: "pull request", number: 7 })).toBe(
      join("/repo", "build", "diagnostics", "merge", "pr-7"),
    );
  });

  it("is the run's own file", () => {
    // The name in the record is the name on the disk, so one place says it.
    expect(journalFileName("run-1")).toBe("run-1.log");
    expect(journalPath("/dir", "run-1")).toBe(join("/dir", "run-1.log"));
  });

  it("names the run's other files too", () => {
    // The record and the gates' log sit beside the journal, and their names
    // are asked for the same way — the work run and the merge run both write
    // a gates' log, and two spellings of one name drift.
    expect(recordFileName("run-1")).toBe("run-1.md");
    expect(gatesLogFileName("run-1")).toBe("run-1-gates.log");
  });

  it("drops a line it cannot write, and keeps the run going", async () => {
    // A journal that cannot be written is not a reason to stop the run: the
    // line is dropped and the session carries on.
    const session: AgentSession = {
      prompt: async () => {},
      abort: async () => {},
      dispose: () => {},
    };
    const factory = journalFactory(
      async (sessionOptions) => {
        // The line the journal cannot take: its directory is not there.
        sessionOptions.onEvent?.("a line the journal cannot hold");
        return session;
      },
      join(tmpdir(), "afk-journal-without-a-directory", "run.log"),
    );

    const opened = await factory({ cwd: tmpdir(), systemPromptSections: {} });
    expect(opened).toBe(session);
  });
});
