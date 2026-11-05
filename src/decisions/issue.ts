/**
 * The tool the triage turn ends on.
 *
 * It is the graph's first branch, and it is a **value**: the runner closes the
 * issue with the reason when the decision is `skip`, and otherwise carries on
 * to the scope turn. A triage that says nothing does not close anything.
 */

import { Type } from "typebox";

import { defineTool } from "../tools.js";
import { TRIAGE_TOKEN, type TriageToken } from "../workflow/index.js";

/** The name of the tool the triage turn decides with. */
export const ISSUE_DECISION_TOOL_NAME = "agent_issue_decision";

/** What the triage turn decided. */
export interface IssueDecision {
  readonly decision: TriageToken;
  readonly reason: string;
}

/** The tool the triage turn ends on. */
export function createIssueDecisionTool(holder: { value?: IssueDecision }) {
  return defineTool({
    name: ISSUE_DECISION_TOOL_NAME,
    label: "Decide whether the issue is worked",
    description:
      "Decide whether this issue should be worked at all. Call it as your last action of the " +
      "triage turn: `work` when the brief is still worth doing, `skip` when the issue should be " +
      "closed with the reason and the runner should move to the next one.",
    promptSnippet: "Decide whether the issue is worked",
    promptGuidelines: [
      `Use ${ISSUE_DECISION_TOOL_NAME} as the triage turn's final action.`,
      "`skip` closes the issue with the reason; the next issue in the queue is taken instead.",
    ],
    parameters: Type.Object({
      decision: Type.Union([Type.Literal(TRIAGE_TOKEN.work), Type.Literal(TRIAGE_TOKEN.skip)], {
        description: "work to do the brief; skip to close the issue with the reason",
      }),
      reason: Type.String({
        description: "Why — one sentence a human can read. Required when the decision is skip.",
      }),
    }),
    async execute(_toolCallId, params) {
      const decision: IssueDecision = {
        decision: params.decision,
        reason: params.reason.trim(),
      };
      holder.value = decision;
      return {
        content: [{ type: "text", text: `Issue decision recorded: ${decision.decision}` }],
        details: decision,
      };
    },
  });
}
