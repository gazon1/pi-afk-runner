/**
 * The run's journal: the lines a reader sees while the agent works.
 *
 * They live here because both engines write them — Pi reads them off the
 * session's events, Mastra off the agent's answer — and a line that is
 * written twice is a line the two engines spell differently.
 */

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
