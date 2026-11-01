/**
 * The session's workflow: the states it moves through, and the engine that
 * moves it.
 *
 * The engine is `@quintinshaw/pi-dynamic-workflows`. Its own agents are
 * **separate sessions, in separate worktrees** — a fleet of subagents, each
 * with a model of its own. That is a different thing from what the runner
 * needs: the work session is **one** session — one system prompt, one set of
 * tools, one context that every turn sees — and the runner's own rules (the
 * deadline, the stop, the turn whose model call failed) are the runner's to
 * hold, not the engine's.
 *
 * So the engine is given a **turn runner** instead of subagents: the engine
 * decides what runs next and in which phase, and the runner's code decides
 * what a turn does. The states below are the work session's four; the intake
 * turns that come before them are the issue's body and its comments.
 */

import {
  runWorkflow,
  WorkflowError,
  WorkflowErrorCode,
  type AgentRunOptions,
} from "@quintinshaw/pi-dynamic-workflows";
import type { TSchema } from "typebox";

/**
 * The work session's four states, and the prompt file each one runs.
 *
 * The order is the session's order, and the names are the phases the run is
 * recorded under: brief, implement, verify, next.
 */
export const WORKFLOW_STATES = [
  { name: "brief", phase: "Brief", promptFile: "01-brief.md" },
  { name: "implement", phase: "Implement", promptFile: "02-implement.md" },
  { name: "verify", phase: "Verify", promptFile: "03-verify.md" },
  { name: "next", phase: "Next", promptFile: "04-next.md" },
] as const;

/**
 * The name and the phase of a state, without its turn.
 *
 * The turn's text belongs to the caller: the work session's states run the
 * prompt files, and the review session's states run one prompt of their own.
 */
export interface StateName {
  /** The state's name — the label the engine runs it under. */
  readonly name: string;
  /** The phase the turn runs in. */
  readonly phase: string;
}

/** A state of a session's workflow: one turn, in one phase. */
export interface WorkflowState extends StateName {
  /** The text of the turn. */
  readonly text: string;
  /**
   * Whether the turn counts towards the run's completed prompts.
   *
   * The intake turns — the issue's body and its comments — are data, not
   * prompts: they are not counted, as the prompt array never counted them.
   */
  readonly counts: boolean;
}

/**
 * What one state did.
 *
 * A state either finished or failed, and the failure is a value the runtime
 * handles: the engine stops the run on it, and the runner reports it.
 */
export type StateOutcome =
  | { readonly state: "ok" }
  | { readonly state: "error"; readonly error: Error };

/** Runs one state's turn. */
export type TurnRunner = (state: WorkflowState) => Promise<StateOutcome>;

/** What a run of the states did. */
export interface StatesResult {
  /** The states that finished. */
  readonly completed: readonly WorkflowState[];
  /** Whether the run was cut off before its last state. */
  readonly aborted: boolean;
}

/**
 * The script the engine runs.
 *
 * It is the whole graph: the states come in as arguments, and each one is a
 * phase and a turn. The engine's own vocabulary — `phase`, `agent` — is the
 * state machine, and the runner's rules stay outside it.
 */
const STATES_SCRIPT = `export const meta = {
  name: 'afk_session',
  description: "The runner's session: one turn per state, in one session.",
}

const outcomes = []
for (const state of args.states) {
  phase(state.phase)
  outcomes.push(await agent(state.text, { label: state.name }))
}
return outcomes
`;

/**
 * The error that says the run was cut off.
 *
 * It is the engine's own abort error, so the engine stops the run on it
 * instead of treating it as a recoverable failure and carrying on to the next
 * state.
 */
export function cutOffError(message: string): WorkflowError {
  return new WorkflowError(message, WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: false });
}

/** Whether an error says the run was cut off. */
export function isCutOff(error: unknown): boolean {
  return error instanceof WorkflowError && error.code === WorkflowErrorCode.WORKFLOW_ABORTED;
}

/**
 * The error a state failed with, when the engine is carrying one.
 *
 * The engine wraps a failed turn in its own error; the failure underneath it
 * is the one the runner reports, with the message the caller expects.
 */
export function stateFailure(error: unknown): Error | null {
  if (error instanceof WorkflowError && error.details instanceof Error) {
    return error.details;
  }
  return null;
}

/**
 * Run the states, in order, in one session.
 *
 * The engine runs the graph; the runner's `run` runs the turns. A state that
 * fails stops the run and the failure comes back out of it; a run that is cut
 * off comes back as an aborted run, with the states that finished.
 */
export async function runStates(options: {
  readonly states: readonly WorkflowState[];
  readonly run: TurnRunner;
}): Promise<StatesResult> {
  const completed: WorkflowState[] = [];

  /**
   * Run one state's turn, and turn a thrown failure into a failed state.
   *
   * The engine treats a thrown failure as **recoverable**: it logs it, returns
   * nothing, and carries on to the next state. A run that carries on past a
   * failed turn looks like a run that worked, so the failure is made
   * unrecoverable here — and a cut-off is left alone, because that is the
   * engine's own abort and it ends the run.
   */
  const runTurn = async (state: WorkflowState): Promise<StateOutcome> => {
    try {
      return await options.run(state);
    } catch (error) {
      if (isCutOff(error)) {
        throw error;
      }
      return {
        state: "error",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  };

  // The engine runs a state by its name, so two states with one name are one
  // state: the second one's turn would never run, and the first one's would
  // run twice.
  const names = new Set<string>();
  for (const state of options.states) {
    if (names.has(state.name)) {
      throw new Error(`the session declares two states named ${state.name}`);
    }
    names.add(state.name);
  }

  const agent = {
    async run(prompt: string, agentOptions?: AgentRunOptions<TSchema>): Promise<unknown> {
      const name = agentOptions?.label ?? "";
      const state = options.states.find((candidate) => candidate.name === name);
      if (state === undefined) {
        // The engine ran a state the runner did not declare: the graph and
        // the runner's states have drifted apart, and a turn nobody knows
        // about is a turn nobody waited for.
        throw new WorkflowError(
          `the workflow ran a state the session does not declare: ${name}`,
          WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
          { recoverable: false },
        );
      }
      const outcome = await runTurn(state);
      if (outcome.state === "error") {
        // The failure says which state it happened in: the states are what the
        // session is made of, and a failure without a place is a failure the
        // record cannot point at.
        throw new WorkflowError(
          `the ${state.phase} phase failed: ${outcome.error.message}`,
          WorkflowErrorCode.AGENT_EXECUTION_ERROR,
          {
            recoverable: false,
            details: outcome.error,
          },
        );
      }
      completed.push(state);
      // The engine reads an empty answer as a state that produced nothing, and
      // treats it as a recoverable failure: a state that finished says so.
      return `${state.name}: ok`;
    },
  };

  try {
    await runWorkflow(STATES_SCRIPT, {
      args: { states: options.states },
      agent,
      // The runner's deadline is the run's timeout: a second one here would
      // cut a turn the runner still wants, and a retry here would send a
      // turn twice.
      agentTimeoutMs: null,
      agentRetries: 0,
      // The record of a run belongs to the runner, under
      // `build/diagnostics/`: the engine's own logs are not it.
      persistLogs: false,
    });
    return { completed, aborted: false };
  } catch (error) {
    if (isCutOff(error)) {
      return { completed, aborted: true };
    }
    throw error;
  }
}
