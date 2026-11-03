/**
 * The log a human watches while the run works.
 *
 * It is a view of the work session — the tools it runs and the lines it says —
 * because a human watching a run cannot otherwise see, from the session they are
 * typing in, what the run is doing. The view is a projection and not a record:
 * it reads the session's own events and turns them into the lines the host
 * shows above the editor.
 */

import { describeToolCall } from "./cli.js";
import type { SessionEvent } from "./session.js";

/** A text block of a message, or not. */
function isTextBlock(block: unknown): block is { readonly text: string } {
  return (
    typeof block === "object" &&
    block !== null &&
    "text" in block &&
    typeof (block as { readonly text: unknown }).text === "string"
  );
}

/**
 * The first line of an assistant message, or null.
 *
 * A watcher wants the line the agent would say out loud, not a dump of its whole
 * message: the tool calls are already the line above.
 */
function assistantLine(message: SessionEvent["message"]): string | null {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) {
    return null;
  }
  const text = message.content
    .flatMap((block) => (isTextBlock(block) ? [block.text] : []))
    .join("\n");
  const line = text.split("\n").find((part) => part.trim() !== "")?.trim() ?? "";
  if (line === "") {
    return null;
  }
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/**
 * What one session event adds to the host's view of the run, or null.
 *
 * The log is a view of the work session — the tools it runs and the lines it
 * says — because a human watching a run cannot otherwise see, from the session
 * they are typing in, what the run is doing.
 */
export function logLine(event: SessionEvent): string | null {
  switch (event.type) {
    case "tool_execution_start":
      return event.toolName === undefined
        ? null
        : `→ ${describeToolCall({ toolName: event.toolName, input: event.args })}`;
    case "message_end": {
      const line = assistantLine(event.message);
      return line === null ? null : `· ${line}`;
    }
    default:
      return null;
  }
}
