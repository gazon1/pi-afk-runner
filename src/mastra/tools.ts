/**
 * Mastra's tools, built from the runner's descriptions.
 *
 * Mastra's tool is a different object from Pi's: the schema is a Standard
 * Schema, the call is `(input, context)`, and a refusal is an exception the
 * model reads as a failed call. The **description** is the runner's own — the
 * same one the Pi engine builds from — so the two engines cannot drift on
 * what a tool means or on what it refuses.
 */

import { createTool } from "@mastra/core/tools";
import { toStandardSchema, type JSONSchema7 } from "@mastra/schema-compat";

import type { AnyToolSpec } from "../tools.js";

/**
 * The description the model is told, in Mastra's own shape.
 *
 * Pi puts a tool's guidelines in the system prompt; Mastra has no such
 * section, so the guidelines go into the tool's description — which is where
 * the model reads them anyway.
 */
function describeForMastra(spec: AnyToolSpec): string {
  if (spec.promptGuidelines === undefined || spec.promptGuidelines.length === 0) {
    return spec.description;
  }
  return `${spec.description}\n\n${spec.promptGuidelines.join("\n")}`;
}

/**
 * The Mastra tool the runner's description becomes.
 *
 * The schema is the description's own: typebox's schema is JSON Schema with
 * its type metadata on it, and Mastra's converter reads the JSON Schema part
 * and validates the call against it.
 */
export function toMastraTool(spec: AnyToolSpec) {
  return createTool({
    id: spec.name,
    title: spec.label,
    description: describeForMastra(spec),
    inputSchema: toStandardSchema(spec.parameters as unknown as JSONSchema7),
    async execute(input, context) {
      const result = await spec.execute(context?.agent?.toolCallId ?? "call", input);
      const text = result.content.map((block) => block.text).join("\n");
      if (result.isError === true) {
        // A refusal is a failed call: the model reads why it was refused, and
        // the turn carries on. Throwing is what makes Mastra mark the call as
        // failed — a returned string would read as a result.
        throw new Error(text);
      }
      return text;
    },
  });
}

/** The Mastra tools the runner's descriptions become, keyed by their names. */
export function toMastraTools(
  specs: readonly AnyToolSpec[],
): Record<string, ReturnType<typeof toMastraTool>> {
  const tools: Record<string, ReturnType<typeof toMastraTool>> = {};
  for (const spec of specs) {
    tools[spec.name] = toMastraTool(spec);
  }
  return tools;
}
