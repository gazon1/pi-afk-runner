/**
 * The straight line: the states, in order, in one session.
 *
 * It is the workflow of a session that does not branch — the review's
 * session, the merge resolution's — and it is the same shape as the work
 * session's script without the branches.
 */

import { createWorkflow } from "@mastra/core/workflows";

import type { StatesResult, TurnRunner, WorkflowState } from "./states.js";
import { answerSchema, readOutcome, stateStep, type RunContext } from "./steps.js";

/**
 * The states' names, checked for duplicates.
 *
 * The graph runs a state by its name, so two states with one name are one
 * state: the second one's turn would never run, and the first one's would run
 * twice.
 */
function uniqueNames(states: readonly WorkflowState[]): void {
  const seen = new Set<string>();
  for (const state of states) {
    if (seen.has(state.name)) {
      throw new Error(`the session declares two states named ${state.name}`);
    }
    seen.add(state.name);
  }
}

/**
 * Run the states, in order, in one session.
 *
 * The runner's `run` runs the turns. A state that fails stops the run and the
 * failure comes back out of it; a run that is cut off comes back as an aborted
 * run, with the states that finished.
 */
export async function runStates(options: {
  readonly states: readonly WorkflowState[];
  readonly run: TurnRunner;
  /**
   * A state the run says it does not need is not run.
   *
   * The answer is asked before the state runs, so a state that depends on what
   * the earlier states did — a second chance, given only when the first one
   * did not do its job — is skipped or not, and the run says which.
   */
  readonly skip?: (state: WorkflowState) => boolean;
}): Promise<StatesResult> {
  uniqueNames(options.states);
  const context: RunContext = {
    run: options.run,
    completed: [],
    failure: {},
    ...(options.skip === undefined ? {} : { skip: options.skip }),
  };
  if (options.states.length === 0) {
    return { completed: [], aborted: false };
  }

  const script = createWorkflow({
    id: "states",
    inputSchema: answerSchema,
    outputSchema: answerSchema,
  });
  for (const state of options.states) {
    script.then(stateStep({ state, context }));
  }

  const run = await script.commit().createRun();
  const result = await run.start({ inputData: { token: "start" } });
  return readOutcome(context, result);
}
