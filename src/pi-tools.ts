/**
 * Pi's tools, built from the runner's descriptions.
 *
 * Pi's own tool object carries things the runner does not use — a renderer, a
 * loadout, an exposure — and the runner's description does not. So the tool
 * is built here, once, and the runner's tools stay the runner's own.
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { AnyToolSpec } from "./tools.js";

/**
 * The Pi tool the runner's description becomes.
 *
 * The result is Pi's own: the text the model reads, the details the runner's
 * own code reads, and the refusal flag — a refusal Pi's model sees as a failed
 * call, exactly as the description says it is.
 */
export function toPiTool(spec: AnyToolSpec): ToolDefinition {
  return defineTool({
    name: spec.name,
    label: spec.label,
    description: spec.description,
    ...(spec.promptSnippet === undefined ? {} : { promptSnippet: spec.promptSnippet }),
    ...(spec.promptGuidelines === undefined
      ? {}
      : { promptGuidelines: [...spec.promptGuidelines] }),
    parameters: spec.parameters,
    async execute(toolCallId, params) {
      const result = await spec.execute(toolCallId, params);
      return {
        content: result.content.map((block) => ({ type: "text" as const, text: block.text })),
        details: result.details,
        ...(result.isError === undefined ? {} : { isError: result.isError }),
      };
    },
  });
}

/** The Pi tools the runner's descriptions become. */
export function toPiTools(specs: readonly AnyToolSpec[]): ToolDefinition[] {
  return specs.map(toPiTool);
}
