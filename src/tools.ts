/**
 * The runner's tools, as the runner knows them.
 *
 * The runner has two engines — Pi and Mastra — and the tools both of them
 * carry are the same: the decisions a turn ends on and the leftover the fourth
 * turn files. So a tool is **described here**, in the runner's own terms, and
 * each engine builds its own object from the description — Pi's `defineTool`
 * and Mastra's `createTool`.
 *
 * The description is what the runner means; the engine's object is what the
 * model calls. A tool written twice is a tool whose two copies drift, and the
 * drift is a decision the runner would read differently depending on which
 * engine ran it.
 */

import type { Static, TSchema } from "typebox";

/** A block of text a tool answers with. */
export interface ToolText {
  readonly type: "text";
  readonly text: string;
}

/**
 * What a tool answers with.
 *
 * `isError` is a **refusal**, not a crash: the model sees the call as failed
 * and reads why, and the turn carries on. The runner's own bound — the split
 * that is too small, the leftover that is already open — is a refusal, and the
 * model has to be able to try again.
 */
export interface ToolResult<TDetails = unknown> {
  readonly content: readonly ToolText[];
  readonly details: TDetails;
  readonly isError?: boolean;
}

/** A tool, as the runner describes it. */
export interface ToolSpec<TParams extends TSchema = TSchema, TDetails = unknown> {
  /** The name the model calls it by. */
  readonly name: string;
  /** The name a human reads it under. */
  readonly label: string;
  /** What the model is told the tool is for. */
  readonly description: string;
  /** The one-line summary the system prompt carries. */
  readonly promptSnippet?: string;
  /** The rules the model is told to follow when it calls the tool. */
  readonly promptGuidelines?: readonly string[];
  /** The parameters the model calls it with. */
  readonly parameters: TParams;
  /** Runs the tool. */
  execute(toolCallId: string, params: Static<TParams>): Promise<ToolResult<TDetails>>;
}

/** A tool with its parameters forgotten — what the adapters take. */
export type AnyToolSpec = ToolSpec<any, any>;

/**
 * Describe a tool.
 *
 * It is the inference helper the engines' own `defineTool` is: the parameters
 * are read from the schema, and the `execute` that follows is typed by them.
 * Without it a description would widen its own parameters to `unknown`, and
 * every tool would cast its way to the parameters it was given.
 */
export function defineTool<TParams extends TSchema, TDetails = unknown>(
  spec: ToolSpec<TParams, TDetails>,
): ToolSpec<TParams, TDetails> & AnyToolSpec {
  return spec;
}
