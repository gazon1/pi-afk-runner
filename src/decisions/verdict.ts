/**
 * The tool a review ends on.
 *
 * It is a **terminating** tool: the turn ends on the call, so the review does
 * not pay for another model turn to say what it already said. The verdict is
 * a value the runner reads, not a sentence it has to parse out of prose.
 */

import { Type } from "typebox";

import { defineTool } from "../tools.js";

/** The name of the tool the reviewer ends its turn with. */
export const VERDICT_TOOL_NAME = "agent_review_verdict";

/** What a review says. */
export interface ReviewVerdict {
  readonly verdict: "pass" | "fail";
  readonly findings: readonly string[];
}

/** The tool a review ends on. */
export function createVerdictTool(holder: { value?: ReviewVerdict }) {
  return defineTool({
    name: VERDICT_TOOL_NAME,
    label: "Agent review verdict",
    description:
      "End the review with its verdict. Use this as your last action: it states whether " +
      "the review found something that blocks the change, and what it found.",
    promptSnippet: "End the review with its verdict",
    promptGuidelines: [
      `Use ${VERDICT_TOOL_NAME} as your final action, with the verdict you reached.`,
      "After calling it, do not write another assistant message in the same turn.",
    ],
    parameters: Type.Object({
      verdict: Type.Union([
        Type.Literal("pass"),
        Type.Literal("fail"),
      ], { description: "pass when nothing blocks the change, fail when something does" }),
      findings: Type.Array(Type.String(), {
        description: "What the review found, one finding per entry. Empty when it passed.",
      }),
    }),
    async execute(_toolCallId, params) {
      const verdict: ReviewVerdict = {
        verdict: params.verdict,
        findings: params.findings,
      };
      // The first verdict stands. A review that ends on the tool and then gets
      // asked for the verdict again must not change what it already decided:
      // the review is one verdict, and the comment the runner posts is one.
      holder.value ??= verdict;
      return {
        content: [
          {
            type: "text",
            text: `Review recorded: ${params.verdict}`,
          },
        ],
        details: verdict,
      };
    },
  });
}
