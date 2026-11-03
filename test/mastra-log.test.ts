/**
 * The run's log on Mastra — the lines a reader sees while the agent works.
 *
 * Under systemd the output is not a TTY, so chalk emits no colour and every
 * line is the same shape on the page. The marker is then the only thing that
 * says whether a line came from the agent or from the runner, and the tool
 * calls have to carry one too.
 *
 * The engine answers with the whole turn at once, so the lines are written
 * when the answer comes: the tool calls it made, and what it said. A turn
 * that is still working says nothing, though, and a call the guard refused
 * says so: a reader has to see that the call is over.
 */

import { describe, expect, it } from "vitest";

import chalk from "chalk";

import { logTurn, refusalLine, type TurnAnswer } from "../src/mastra/log.js";

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
    // A turn with no listener writes nothing at all — the run may not want
    // the lines at all, and asking for them must not break the turn.
    expect(() => logTurn(answerWith(undefined, "done"))).not.toThrow();
  });
});
