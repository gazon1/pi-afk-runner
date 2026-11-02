/**
 * The tool the related-issues turn ends on.
 *
 * It names the issues the agent will fold into this run's change. An empty
 * list means the issue stands alone. The runner records the choice; the work
 * itself — addressing every batched issue's criteria in one diff — is the
 * agent's.
 */

import { Type } from "typebox";

import { defineTool } from "../tools.js";

/** The name of the tool the related-issues turn ends on. */
export const RELATED_DECISION_TOOL_NAME = "agent_related_decision";

/** What the related-issues turn decided to batch. */
export interface RelatedDecision {
  readonly batch: readonly number[];
}

/** The tool the related-issues turn ends on. */
export function createRelatedDecisionTool(holder: { value?: RelatedDecision }) {
  return defineTool({
    name: RELATED_DECISION_TOOL_NAME,
    label: "Decide which related issues to batch",
    description:
      "Decide which related ready-for-agent issues this run will work together with the " +
      "current one. Call it as your last action of the related turn. An empty list means " +
      "the issue stands alone.",
    promptSnippet: "Decide which related issues to batch",
    promptGuidelines: [
      `Use ${RELATED_DECISION_TOOL_NAME} as the related turn's final action.`,
      "List only issues whose criteria this run will actually address in the same change.",
    ],
    parameters: Type.Object({
      batch: Type.Array(Type.Number(), {
        description: "Issue numbers to fold into this run's change. Empty when solo.",
      }),
    }),
    async execute(_toolCallId, params) {
      const batch = params.batch.filter((n) => Number.isInteger(n) && n > 0);
      const decision: RelatedDecision = { batch };
      holder.value = decision;
      return {
        content: [{ type: "text", text: `Related decision recorded: ${batch.join(", ") || "solo"}` }],
        details: decision,
      };
    },
  });
}
