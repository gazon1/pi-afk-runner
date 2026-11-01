/**
 * The gates the agent runs, and the report it hands back.
 *
 * The agent runs the target repository's gates; the runner holds it to that.
 * The report is a **tool** the agent ends its last turn with — the same shape
 * as the review's verdict, for the same reason: a value the runner reads, not
 * a sentence it has to parse out of prose.
 *
 * The report carries the **tree it was made against**. A gate run on an
 * earlier tree is not a gate run on this one, so the runner compares the tree
 * the report names with the tree it is about to push: the work that reaches
 * the remote has to be the work the gates saw.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { GitRunner } from "./git.js";

/** The tool the work session ends its last turn with. */
export const GATES_TOOL_NAME = "agent_gates";

/** The gates the target repository runs, in the order they run. */
export const GATES = ["./check.sh", "just tcheck-evals", "just docs-audit"] as const;

/** One gate's outcome. */
export interface GateOutcome {
  /** The command that runs the gate. */
  readonly gate: string;
  /** Whether the gate is green. */
  readonly outcome: "pass" | "fail";
  /** What the gate said, in a line. */
  readonly detail: string;
}

/** What the agent reported about the gates. */
export interface GateReport {
  /** What each gate said. */
  readonly outcomes: readonly GateOutcome[];
  /** The tree the gates were run against. */
  readonly tree: string;
}

/** The tool the agent ends its last turn with. */
export function createGatesTool(options: {
  readonly git: GitRunner;
  readonly cwd: string;
  /** Where the report goes. */
  readonly holder: { value?: GateReport };
}) {
  return defineTool({
    name: GATES_TOOL_NAME,
    label: "Agent gate results",
    description:
      "Report what the repository's gates said. Use this as your last action: it states " +
      "whether each gate passed after your last change, and what it said. The gates are " +
      `${GATES.join(", ")}.`,
    promptSnippet: "End the turn with the gate results",
    promptGuidelines: [
      `Call ${GATES_TOOL_NAME} as your final action, after the gates have run and after your last change.`,
      "Report a gate that failed as a failure: the run stops on a red gate, and that is where the failure belongs.",
      "After calling it, change nothing and write no further message in the same turn.",
    ],
    parameters: Type.Object({
      gates: Type.Array(
        Type.Object({
          gate: Type.String({
            description: `The command that runs the gate: ${GATES.join(", ")}.`,
          }),
          outcome: Type.Union([Type.Literal("pass"), Type.Literal("fail")], {
            description: "pass when the gate is green, fail when it is not",
          }),
          detail: Type.String({ description: "What the gate said, in a line." }),
        }),
        { minItems: GATES.length },
      ),
    }),
    async execute(_toolCallId, params) {
      const outcomes = params.gates;
      if (!Array.isArray(outcomes)) {
        // The model is the caller here, and a call it got wrong is worth
        // saying so about: it gets the message and can make the call again.
        throw new Error(
          `the gates tool takes a list of gates — one for each of ${GATES.join(", ")}`,
        );
      }
      const report: GateReport = {
        outcomes,
        tree: await treeDigest(options.git, options.cwd),
      };
      options.holder.value = report;
      return {
        content: [
          {
            type: "text",
            text: `Gates recorded: ${report.outcomes
              .map((entry) => `${entry.gate} ${entry.outcome}`)
              .join(", ")}`,
          },
        ],
        details: report,
        // The report ends the turn: the prompt asks for it as the last
        // action, and a tool result that says so is what makes it true. The
        // agent that edits after it would trip the tree check in
        // `assertGatesGreen`, and the failure would blame the tree rather
        // than the agent that kept writing after it had reported.
        terminate: true,
      };
    },
  });
}

/**
 * Refuse a run whose work has not been through the gates.
 *
 * Four things have to hold, and each of them is a way the work could reach
 * the remote ungated: the agent reported no gates at all, a gate failed, a
 * gate the target repository runs was not reported, or the tree changed after
 * the report — so the gates saw a different tree from the one that is pushed.
 */
export async function assertGatesGreen(options: {
  readonly git: GitRunner;
  readonly cwd: string;
  readonly report: GateReport | undefined;
}): Promise<void> {
  const report = options.report;
  if (report === undefined) {
    throw new Error(
      "the agent reported no gates — the work session has to end its last turn with the agent_gates tool",
    );
  }
  const reported = new Map(report.outcomes.map((entry) => [entry.gate, entry]));
  const missing = GATES.filter((gate) => !reported.has(gate));
  if (missing.length > 0) {
    const said = report.outcomes.map((entry) => entry.gate).join(", ");
    throw new Error(
      `the agent reported no result for ${missing.join(", ")} — it reported: ${said}`,
    );
  }
  // Only the gates this workflow runs decide. An entry for a gate it does not
  // run — `just gate`, which needs a device — is the agent's noise, not a
  // finding: the three gates it was asked about are the ones that count.
  const failed = GATES.filter((gate) => reported.get(gate)?.outcome !== "pass");
  if (failed.length > 0) {
    throw new Error(
      `the gates failed: ${failed
        .map((gate) => `${gate} — ${reported.get(gate)?.detail ?? ""}`)
        .join("; ")}`,
    );
  }
  const tree = await treeDigest(options.git, options.cwd);
  if (tree !== report.tree) {
    throw new Error(
      "the tree changed after the gates were reported — the gates have to be run again, and reported again, before the work is pushed",
    );
  }
}

/**
 * The tree the worktree holds, as git sees it.
 *
 * It is the tree a commit of the worktree would carry: the index is filled
 * with everything the worktree holds, and the tree is written from it. Two
 * calls at two moments answer the same question only when nothing changed in
 * between — which is the question the report is asked.
 */
async function treeDigest(git: GitRunner, cwd: string): Promise<string> {
  await git(["add", "-A"], { cwd });
  return (await git(["write-tree"], { cwd })).trim();
}
