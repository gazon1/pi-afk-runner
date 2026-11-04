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

/**
 * The tool the related-issues turn ends on.
 *
 * @param holder Where the decision is kept.
 * @param candidates The numbers the runner fetched for the turn to choose from.
 *   When it is given, the turn may only name one of them: a number nobody
 *   fetched is nobody's issue, and the record is what the run is judged by.
 */
export function createRelatedDecisionTool(
  holder: { value?: RelatedDecision },
  candidates?: readonly number[],
) {
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
      if (candidates !== undefined) {
        const unknown = batch.filter((n) => !candidates.includes(n));
        if (unknown.length > 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  `Not among the fetched issues: ${unknown.join(", ")} — ` +
                  "the decision lists the issues the runner fetched for this turn.",
              },
            ],
            details: { batch: [] },
            isError: true,
          };
        }
      }
      const decision: RelatedDecision = { batch };
      holder.value = decision;
      return {
        content: [{ type: "text", text: `Related decision recorded: ${batch.join(", ") || "solo"}` }],
        details: decision,
      };
    },
  });
}
