/**
 * The run's log, on Mastra.
 *
 * The log is the lines a reader sees while the agent works; the file they are
 * written to is the run's journal (`src/journal.ts`).
 *
 * Mastra answers with the whole turn at once, so the lines are written when
 * the answer comes: the tool calls it made, and what it said.
 *
 * A turn that is still working says nothing, though — and a tool call that
 * runs for minutes looks like a run that stopped. The calls are therefore
 * written **as they happen**: the engine hands each call over when the model
 * makes it, and the turn that ends writes the calls it made that the engine
 * did not hand over.
 */

import type { Agent } from "@mastra/core/agent";
import chalk from "chalk";

import { assistantTextLines, describeToolCall } from "../journal.js";

/** What one turn's answer carries. */
export type TurnAnswer = Awaited<ReturnType<Agent["generate"]>>;

/**
 * The line one tool call contributes to the run's log.
 *
 * The line is spelled once, so the call that is written while it runs and the
 * call that is written when the turn ends read the same.
 */
export function toolCallLine(call: { readonly toolName: string; readonly args?: unknown }): string {
  return chalk.dim(`  → ${describeToolCall({ toolName: call.toolName, input: call.args })}`);
}

/**
 * The line a refused tool call contributes.
 *
 * A refusal is not a result the model invented: the guard said no. The line
 * says so — a reader has to see that the call was refused and not that it is
 * still running.
 */
export function refusalLine(result: unknown): string | undefined {
  if (typeof result !== "string" || !result.startsWith("Refused:")) {
    return undefined;
  }
  return `  ↳ ${result}`;
}

/**
 * The lines one turn contributes to the run's log.
 *
 * The tool calls come first — they are what the turn *did* — and then what it
 * said. A turn that said nothing writes nothing.
 *
 * The calls the engine already handed over are not written twice: `streamed`
 * carries the calls that were written while they ran.
 */
export function logTurn(
  answer: TurnAnswer,
  onEvent?: (line: string) => void,
  streamed?: ReadonlySet<string>,
): void {
  if (onEvent === undefined) {
    return;
  }
  for (const call of answer.toolCalls ?? []) {
    const payload = call.payload;
    if (payload === undefined) {
      continue;
    }
    if (streamed?.has(payload.toolCallId) === true) {
      continue;
    }
    onEvent(toolCallLine({ toolName: payload.toolName, args: payload.args }));
  }
  for (const line of assistantTextLines(answer.text ?? "")) {
    onEvent(line);
  }
}
