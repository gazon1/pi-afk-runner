/**
 * The work session's script.
 *
 * It is the issue's own: a triage that may close the issue instead of working
 * it, a scope check that may split it into smaller issues, and then the four
 * work turns. The issue's own data — its body and its comments — travels with
 * the first turn, above that turn's instruction; it is not a turn of its own.
 *
 * The script is a composition of workflows: the two decisions and what each of
 * them leads to. Each of them is a workflow of its own, and the branch is what
 * puts them together — the triage's answer picks the closing workflow or the
 * working one, and the scope's answer picks the splitting workflow or the work
 * turns.
 */

import { createWorkflow } from "@mastra/core/workflows";

import { SCOPE_TOKEN, TRIAGE_TOKEN } from "./tokens.js";
import { WorkflowError, WORKFLOW_ERROR_CODE } from "./errors.js";
import { WORK_STATES, type StatesResult, type TurnRunner, type WorkflowState } from "./states.js";
import {
  answerSchema,
  asStep,
  failingStep,
  readOutcome,
  stateStep,
  type RunContext,
} from "./steps.js";

/**
 * A workflow of the script.
 *
 * Every one of them takes an answer and gives an answer: the token the branch
 * is keyed by. The shape is written once, here.
 */
function sub(id: string) {
  return createWorkflow({
    id,
    inputSchema: answerSchema,
    outputSchema: answerSchema,
  });
}

/**
 * Run the work session's graph.
 *
 * A decision is the token the turn returned, and what follows it is the
 * branch.
 */
export async function runWorkSession(options: {
  readonly nodes: readonly WorkflowState[];
  readonly run: TurnRunner;
}): Promise<StatesResult> {
  const context: RunContext = { run: options.run, completed: [], failure: {} };
  const byName = new Map(options.nodes.map((node) => [node.name, node]));

  /**
   * The step that runs a node of the script.
   *
   * A node the session does not declare is a failure the graph reports where
   * it reached it: the script runs the states the session declares, and says
   * which one it did not find.
   */
  const node = (name: string) => {
    const state = byName.get(name);
    if (state !== undefined) {
      return stateStep({ state, context });
    }
    return failingStep({
      id: name,
      error: new WorkflowError(
        `the workflow ran a state the session does not declare: ${name}`,
        WORKFLOW_ERROR_CODE.script,
        { recoverable: false },
      ),
      context,
    });
  };

  // The optional related-issues turn, when the session declares it, runs
  // before the triage: it decides whether several issues are one piece of
  // work, and the triage then judges the issue it was given.
  const hasRelated = options.nodes.some((node) => node.name === "related");

  // What the triage's `skip` leads to: the runner closes the issue.
  const closeSkip = sub("work-session-close-skip").then(node("close-skip")).commit();

  // What the scope's `split` leads to: the runner files the smaller issues.
  const split = sub("work-session-split").then(node("split")).commit();

  // The work turns, in the session's order.
  const workTurns = sub("work-session-work");
  for (const name of WORK_STATES) {
    workTurns.then(node(name));
  }
  workTurns.commit();

  // The scope check, and what its answer leads to.
  //
  // The two conditions are one branch and its other half: the engine runs
  // every condition that holds, so a pair that cannot both hold is what makes
  // the branch exclusive.
  const work = sub("work-session-scope")
    .then(node("scope"))
    .branch([
      [
        async ({ inputData }) => inputData.token === SCOPE_TOKEN.split,
        asStep(split),
      ],
      [
        async ({ inputData }) => inputData.token !== SCOPE_TOKEN.split,
        asStep(workTurns),
      ],
    ])
    .commit();

  // The script itself: the optional related turn, the triage, and what the
  // triage leads to.
  const script = sub("work-session");
  if (hasRelated) {
    script.then(node("related"));
  }
  script.then(node("triage"));
  script.branch([
    [
      async ({ inputData }) => inputData.token === TRIAGE_TOKEN.skip,
      asStep(closeSkip),
    ],
    [
      async ({ inputData }) => inputData.token !== TRIAGE_TOKEN.skip,
      asStep(work),
    ],
  ]);

  const run = await script.commit().createRun();
  const result = await run.start({ inputData: { token: "start" } });
  return readOutcome(context, result);
}
