/**
 * The tool the scope turn ends on.
 *
 * `fits` goes on to the brief. `split` goes to the action that files the pieces
 * as issues, links them from the original and closes it. The bounds are here,
 * not in the agent: two is the smallest split that is a split, and
 * {@link MAX_SPLIT_SUBTASKS} is what keeps one issue from becoming a backlog.
 */

import { Type } from "typebox";

import { BRIEF_MARKER } from "../gh.js";
import { defineTool } from "../tools.js";
import { SCOPE_TOKEN, type ScopeToken } from "../workflow/index.js";

/** The name of the tool the scope turn decides with. */
export const SCOPE_DECISION_TOOL_NAME = "agent_scope_decision";

/** How many pieces a too-large issue may be split into. */
export const MAX_SPLIT_SUBTASKS = 8;

/** One piece of a split issue. */
export interface ScopeSubtask {
  readonly title: string;
  /** The subtask's brief. It opens with `## Agent Brief`. */
  readonly brief: string;
}

/** What the scope turn decided. */
export interface ScopeDecision {
  readonly decision: ScopeToken;
  readonly reason: string;
  readonly subtasks: readonly ScopeSubtask[];
}

/** A refusal the model sees as a failed call, and why. */
function scopeRefusal(reason: string): {
  content: { type: "text"; text: string }[];
  details: { decision: ScopeToken; reason: string; subtasks: ScopeSubtask[] };
  isError: true;
} {
  return {
    content: [{ type: "text", text: `Not recorded: ${reason}` }],
    details: { decision: SCOPE_TOKEN.fits, reason, subtasks: [] },
    isError: true,
  };
}

/** The tool the scope turn ends on. */
export function createScopeDecisionTool(holder: { value?: ScopeDecision }) {
  return defineTool({
    name: SCOPE_DECISION_TOOL_NAME,
    label: "Decide whether the issue fits one run",
    description:
      "Decide whether this issue fits one run, or has to be split. Call it as your last " +
      "action of the scope turn. `fits` goes on to the brief; `split` files the subtasks as " +
      "issues and closes this one.",
    promptSnippet: "Decide whether the issue fits one run",
    promptGuidelines: [
      `Use ${SCOPE_DECISION_TOOL_NAME} as the scope turn's final action.`,
      "`split` needs at least two and at most eight subtasks, each with a title and a brief that opens with `## Agent Brief`.",
    ],
    parameters: Type.Object({
      decision: Type.Union([Type.Literal(SCOPE_TOKEN.fits), Type.Literal(SCOPE_TOKEN.split)], {
        description: "fits when one run can finish it; split when it has to be smaller issues",
      }),
      reason: Type.String({
        description: "Why — one sentence a human can read.",
      }),
      subtasks: Type.Optional(
        Type.Array(
          Type.Object({
            title: Type.String({ description: "The subtask's title — one line." }),
            brief: Type.String({
              description:
                "The subtask's brief, in the target repository's format: it opens with " +
                "`## Agent Brief` and carries the behaviour, the criteria and what is out of scope.",
            }),
          }),
          {
            description:
              "For `split`: at least two and at most eight subtasks, in the order they must run.",
          },
        ),
      ),
    }),
    async execute(_toolCallId, params) {
      const subtasks = params.subtasks ?? [];
      const reason = params.reason.trim();
      if (params.decision === SCOPE_TOKEN.split) {
        if (subtasks.length < 2) {
          return scopeRefusal("a split needs at least two subtasks");
        }
        if (subtasks.length > MAX_SPLIT_SUBTASKS) {
          return scopeRefusal(
            `a split is bounded at ${MAX_SPLIT_SUBTASKS} subtasks — this one has ${subtasks.length}`,
          );
        }
        const notABrief = subtasks.find(
          (task) => !task.brief.trimStart().startsWith(BRIEF_MARKER),
        );
        if (notABrief !== undefined) {
          return scopeRefusal(
            `the subtask "${notABrief.title}" does not open with \`${BRIEF_MARKER}\``,
          );
        }
        if (subtasks.some((task) => task.title.trim() === "")) {
          return scopeRefusal("every subtask needs a title");
        }
      }
      const decision: ScopeDecision = {
        decision: params.decision,
        reason,
        subtasks: params.decision === SCOPE_TOKEN.split ? subtasks : [],
      };
      holder.value = decision;
      return {
        content: [
          { type: "text", text: `Scope decision recorded: ${decision.decision}` },
        ],
        details: decision,
      };
    },
  });
}
