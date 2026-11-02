/**
 * The run's journal, on Mastra.
 *
 * Mastra answers with the whole turn at once, so the lines are written when
 * the answer comes: the tool calls it made, and what it said.
 */

import type { Agent } from "@mastra/core/agent";
import chalk from "chalk";

import { assistantTextLines, describeToolCall } from "../journal.js";

/** What one turn's answer carries. */
export type TurnAnswer = Awaited<ReturnType<Agent["generate"]>>;

/**
 * The lines one turn contributes to the run stream.
 *
 * The tool calls come first — they are what the turn *did* — and then what it
 * said. A turn that said nothing writes nothing.
 */
export function logTurn(answer: TurnAnswer, onEvent?: (line: string) => void): void {
  if (onEvent === undefined) {
    return;
  }
  for (const call of answer.toolCalls ?? []) {
    const payload = call.payload;
    if (payload === undefined) {
      continue;
    }
    onEvent(
      chalk.dim(
        `  → ${describeToolCall({ toolName: payload.toolName, input: payload.args })}`,
      ),
    );
  }
  for (const line of assistantTextLines(answer.text ?? "")) {
    onEvent(line);
  }
}
