/**
 * The steps the graph is made of.
 *
 * A step is one state of the session: the runner's own code runs the turn, and
 * the step carries the state through the engine. The engine is Mastra's
 * workflow engine, and it is told one thing about a state — the answer it
 * gave — and that answer is the edge the branch is keyed by.
 *
 * The failure a step runs into does not go through the engine: the engine
 * keeps its own copy, and that copy is a plain object by the time the run
 * comes back — the class and the details under it are gone. The runner's
 * failures are told apart by exactly those, so the failure is carried beside
 * the run, and the run is stopped rather than continued past it.
 */

import {
  createStep,
  type AnyWorkflow,
  type DefaultEngineType,
  type Step,
} from "@mastra/core/workflows";
import { toStandardSchema, type JSONSchema7 } from "@mastra/schema-compat";
import { isCutOff, messageOf, WorkflowError, WORKFLOW_ERROR_CODE } from "./errors.js";
import type { StateOutcome, StatesResult, TurnRunner, WorkflowState } from "./states.js";

/**
 * What a state answered.
 *
 * The token is what the branch is keyed by — the triage's `skip`, the scope's
 * `split`, `ok` for everything else. The state that answered is the step's
 * own id, and the engine writes it in the trace; it is not carried twice.
 */
export interface StateAnswer {
  /** The token the state returned. */
  readonly token: string;
}

/**
 * The schema of an answer.
 *
 * It is a JSON Schema, because that is what the engine reads a step's input
 * as, and it is checked against the step's own schema before the step runs.
 */
export const answerSchema = toStandardSchema<StateAnswer>({
  type: "object",
  properties: {
    token: { type: "string" },
  },
  required: ["token"],
} satisfies JSONSchema7);

/**
 * The failure a run stopped on.
 *
 * It is carried here rather than through the engine, because the engine's own
 * copy of a failure is a plain object: the class that tells a cut-off from a
 * failure, and the details the runner reports, are both gone by the time the
 * run comes back.
 */
export interface Failure {
  value?: unknown;
}

/** The run's own state: what it ran, what finished, and what stopped it. */
export interface RunContext {
  /** Runs one state's turn or action. */
  readonly run: TurnRunner;
  /** The states that finished. */
  readonly completed: WorkflowState[];
  /** The failure the run stopped on, when it stopped on one. */
  readonly failure: Failure;
  /** A state the run says it does not need is not run. */
  readonly skip?: (state: WorkflowState) => boolean;
}

/**
 * The step that runs one state.
 *
 * The turn is the runner's own: the step asks for it and takes the answer. A
 * state that fails stops the run — the failure is kept in the run's context
 * and the run is aborted, because a run that carries on past a failed turn
 * looks like a run that worked.
 */
export function stateStep(options: {
  readonly state: WorkflowState;
  readonly context: RunContext;
}) {
  const state = options.state;
  return createStep({
    id: state.name,
    inputSchema: answerSchema,
    outputSchema: answerSchema,
    async execute({ abort }) {
      if (options.context.skip?.(state) === true) {
        // The state is not needed: it did not run, and it did not finish.
        return { token: "ok" };
      }

      let outcome: StateOutcome;
      try {
        outcome = await options.context.run(state);
      } catch (failure) {
        // A cut-off is the run's own abort error: it stops the run as it is.
        // Anything else is the failure the run reports, and it says the phase
        // it happened in — a failure without a place is a failure the record
        // cannot point at.
        options.context.failure.value = isCutOff(failure)
          ? failure
          : new WorkflowError(
              `the ${state.phase} phase failed: ${messageOf(failure)}`,
              WORKFLOW_ERROR_CODE.execution,
              { recoverable: false, details: failure },
            );
        abort();
        return { token: "failed" };
      }

      if (outcome.state === "error") {
        // The failure says which state it happened in: the states are what
        // the session is made of, and a failure without a place is a failure
        // the record cannot point at.
        options.context.failure.value = new WorkflowError(
          `the ${state.phase} phase failed: ${outcome.error.message}`,
          WORKFLOW_ERROR_CODE.execution,
          { recoverable: false, details: outcome.error },
        );
        abort();
        return { token: "failed" };
      }

      options.context.completed.push(state);
      // The graph reads an empty answer as a state that produced nothing,
      // and treats it as a recoverable failure: a state that finished says
      // so.
      return { token: outcome.result ?? "ok" };
    },
  });
}

/**
 * The step that fails the run with the graph's own error.
 *
 * It stands in for a state the session does not declare: the run reaches it,
 * the run stops there, and the error says which state was missing.
 */
export function failingStep(options: {
  readonly id: string;
  readonly error: WorkflowError;
  readonly context: RunContext;
}) {
  return createStep({
    id: options.id,
    inputSchema: answerSchema,
    outputSchema: answerSchema,
    async execute({ abort }) {
      options.context.failure.value = options.error;
      abort();
      return { token: "failed" };
    },
  });
}

/**
 * A workflow as the engine's step.
 *
 * A workflow **is** a step — that is how one workflow is nested in another —
 * but the engine's own types do not fit the project's `exactOptionalPropertyTypes`:
 * a workflow's optional description may be undefined, and a step's may not. The
 * cast is where the two meet, and it costs nothing: the shape is the engine's
 * own, and the engine is what checks it.
 */
export function asStep(
  workflow: AnyWorkflow,
): Step<string, any, StateAnswer, StateAnswer, any, any, DefaultEngineType, any> {
  return workflow as unknown as Step<
    string,
    any,
    StateAnswer,
    StateAnswer,
    any,
    any,
    DefaultEngineType,
    any
  >;
}

/** What the engine's run came back as. */
export interface EngineResult {
  /** The run's status. */
  readonly status: string;
  /** The engine's own failure, when the run failed for the engine's reasons. */
  readonly error?: Error;
}

/**
 * Read the run's outcome, in the runner's own words.
 *
 * The failure the run stopped on is the one the context kept: it is the
 * failure the caller is told about, with its class and its details. A cut-off
 * is not a failure — the run comes back as a cut-off run, with the states
 * that finished. A run that ended in any other way — the engine failed it, or
 * cancelled it for a reason of its own — is a failure the caller is told
 * about too: a run that was cancelled is not a run that worked.
 */
export function readOutcome(context: RunContext, result: EngineResult): StatesResult {
  const failure = context.failure.value;
  if (failure !== undefined) {
    if (isCutOff(failure)) {
      return { completed: context.completed, aborted: true };
    }
    throw failure;
  }
  if (result.status !== "success") {
    throw new Error(result.error?.message ?? `the workflow ${result.status}`);
  }
  return { completed: context.completed, aborted: false };
}
