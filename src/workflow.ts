/**
 * The session's workflow: the states it moves through, and the graph that moves
 * them.
 *
 * The graph is the runner's own code. It used to be an engine of its own —
 * `@quintinshaw/pi-dynamic-workflows` — but that engine was built for Pi and
 * pulled Pi's SDK in with it, and the runner used three things of it: `phase()`,
 * `agent()` and `gate()`. Those are three pieces of control flow, and they are
 * here now, in the runner's own words.
 *
 * What the engine gave the runner is kept, because the runner's rules depend on
 * it: a failed turn **stops** the run, a cut-off run comes back as an aborted
 * run with the states that finished, and the review loop retries until the
 * verdict passes or the attempts run out.
 *
 * The engine's own subagents are not used, and never were: they are separate
 * sessions in separate worktrees, and the work session is **one** session — one
 * system prompt, one set of tools, one context that every turn sees.
 */

import { GateFailed } from "./gates.js";

/** What a node of the graph is: a turn of the session, or work the runner does. */
export type NodeKind = "turn" | "action";

/**
 * The work session's turn states, and the prompt file each one runs.
 *
 * The order is the session's order when every branch is taken, and the names
 * are the phases the run is recorded under. The intake turns that come before
 * them are the issue's body and its comments.
 */
export const WORKFLOW_STATES = [
  { name: "triage", phase: "Triage", promptFile: "00-triage.md" },
  { name: "scope", phase: "Scope", promptFile: "00-scope.md" },
  { name: "brief", phase: "Brief", promptFile: "01-brief.md" },
  { name: "implement", phase: "Implement", promptFile: "02-implement.md" },
  { name: "verify", phase: "Verify", promptFile: "03-verify.md" },
  { name: "next", phase: "Next", promptFile: "04-next.md" },
] as const;

/**
 * The nodes that do not run a turn.
 *
 * They are the runner's own work — closing an issue, filing smaller ones — and
 * they run inside the same graph so that the branch that reaches them is the
 * graph's decision, not a condition beside it.
 */
export const WORKFLOW_ACTIONS = [
  { name: "close-skip", phase: "Close", action: "close-skip" },
  { name: "split", phase: "Split", action: "split" },
] as const;

/**
 * The name and the phase of a state, without its turn.
 *
 * The turn's text belongs to the caller: the work session's states run the
 * prompt files, and the review session's states run one prompt of their own.
 */
export interface StateName {
  /** The state's name — the label the graph runs it under. */
  readonly name: string;
  /** The phase the turn runs in. */
  readonly phase: string;
}

/** A state of a session's workflow: one turn or action. */
export interface WorkflowState extends StateName {
  /** The text of the turn. An action node has no text. */
  readonly text: string;
  /**
   * Whether the turn counts towards the run's completed prompts.
   *
   * The intake turns — the issue's body and its comments — are data, not
   * prompts: they are not counted, as the prompt array never counted them.
   * Neither are the action nodes: they are the runner's work, not the model's.
   */
  readonly counts: boolean;
  /** The kind of node. A turn when it is absent. */
  readonly kind?: NodeKind;
  /** The action's name, for an action node. */
  readonly action?: string;
}

/**
 * What one state did.
 *
 * A state either finished — with the token the branch is keyed by — or failed,
 * and the failure is a value the runtime handles: the graph stops the run on
 * it, and the runner reports it.
 */
export type StateOutcome =
  | { readonly state: "ok"; readonly result?: string }
  | { readonly state: "error"; readonly error: Error };

/** Runs one state's turn or action. */
export type TurnRunner = (state: WorkflowState) => Promise<StateOutcome>;

/** What a run of the states did. */
export interface StatesResult {
  /** The states that finished. */
  readonly completed: readonly WorkflowState[];
  /** Whether the run was cut off before its last state. */
  readonly aborted: boolean;
}

/** The codes the graph's own errors carry. */
export const WORKFLOW_ERROR_CODE = {
  /** The run was cut off — the deadline, or a stop. */
  aborted: "workflow_aborted",
  /** The graph ran a state the session does not declare. */
  script: "script_validation_error",
  /** A turn failed. */
  execution: "agent_execution_error",
} as const;

/**
 * The graph's own error.
 *
 * `details` is the failure underneath: the one the runner reports, with the
 * message the caller expects. `recoverable` says whether the run may carry on
 * past it — a failed turn is not recoverable, because a run that carries on
 * past a failed turn looks like a run that worked.
 */
export class WorkflowError extends Error {
  /** The code the failure is told apart by. */
  readonly code: string;
  /** The failure underneath, when there is one. */
  readonly details: unknown;
  /** Whether the run may carry on past this failure. */
  readonly recoverable: boolean;

  constructor(
    message: string,
    code: string,
    options: { readonly recoverable?: boolean; readonly details?: unknown } = {},
  ) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    this.recoverable = options.recoverable ?? true;
    this.details = options.details;
  }
}

/**
 * The error that says the run was cut off.
 *
 * It is the graph's own abort error, so the run stops on it instead of
 * treating it as a recoverable failure and carrying on to the next state.
 */
export function cutOffError(message: string): WorkflowError {
  return new WorkflowError(message, WORKFLOW_ERROR_CODE.aborted, { recoverable: false });
}

/** Whether an error says the run was cut off. */
export function isCutOff(error: unknown): boolean {
  return error instanceof WorkflowError && error.code === WORKFLOW_ERROR_CODE.aborted;
}

/**
 * The error a state failed with.
 *
 * The failure underneath the graph's own error is the one the runner reports,
 * with the message the caller expects.
 */
export function stateFailure(error: unknown): Error | null {
  if (error instanceof WorkflowError && error.details instanceof Error) {
    return error.details;
  }
  return null;
}

/** The message of a failure, whatever it was thrown as. */
function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

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
 * Run one state and record what it did.
 *
 * It answers the token the branch is keyed by — the triage's `skip`, the
 * scope's `split`, `ok` for everything else. A failed state stops the run: the
 * failure is raised as the graph's own error, with the failure underneath it
 * kept, because the record and the exit code must name it.
 */
async function runState(
  state: WorkflowState,
  run: TurnRunner,
  completed: WorkflowState[],
): Promise<string> {
  let outcome: StateOutcome;
  try {
    outcome = await run(state);
  } catch (failure) {
    if (isCutOff(failure)) {
      throw failure;
    }
    throw new WorkflowError(
      `the ${state.phase} phase failed: ${messageOf(failure)}`,
      WORKFLOW_ERROR_CODE.execution,
      { recoverable: false, details: failure },
    );
  }
  if (outcome.state === "error") {
    // The failure says which state it happened in: the states are what the
    // session is made of, and a failure without a place is a failure the
    // record cannot point at.
    throw new WorkflowError(
      `the ${state.phase} phase failed: ${outcome.error.message}`,
      WORKFLOW_ERROR_CODE.execution,
      { recoverable: false, details: outcome.error },
    );
  }
  completed.push(state);
  // The graph reads an empty answer as a state that produced nothing, and
  // treats it as a recoverable failure: a state that finished says so.
  return outcome.result ?? "ok";
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
}): Promise<StatesResult> {
  const completed: WorkflowState[] = [];
  uniqueNames(options.states);

  for (const state of options.states) {
    try {
      await runState(state, options.run, completed);
    } catch (error) {
      if (isCutOff(error)) {
        return { completed, aborted: true };
      }
      throw error;
    }
  }
  return { completed, aborted: false };
}

/**
 * Run the work session's graph.
 *
 * The branch is the issue's own: the intake data, a triage that may close the
 * issue instead of working it, a scope check that may split it into smaller
 * issues, and then the four work turns. A decision is the token the turn
 * returned, and what follows it is the branch.
 */
export async function runWorkSession(options: {
  readonly nodes: readonly WorkflowState[];
  readonly run: TurnRunner;
}): Promise<StatesResult> {
  const completed: WorkflowState[] = [];
  const byName = new Map(options.nodes.map((node) => [node.name, node]));

  /** The node the branch names, or a failure that says the graph drifted. */
  const node = (name: string): WorkflowState => {
    const found = byName.get(name);
    if (found === undefined) {
      throw new WorkflowError(
        `the workflow ran a state the session does not declare: ${name}`,
        WORKFLOW_ERROR_CODE.script,
        { recoverable: false },
      );
    }
    return found;
  };

  /** Run one node of the branch and answer the token it returned. */
  const step = async (name: string): Promise<string> =>
    await runState(node(name), options.run, completed);

  try {
    for (const name of ["issue-body", "issue-comments", "related"]) {
      if (byName.has(name)) {
        await step(name);
      }
    }

    const triage = await step("triage");
    if (triage === "skip") {
      await step("close-skip");
      return { completed, aborted: false };
    }

    const scope = await step("scope");
    if (scope === "split") {
      await step("split");
      return { completed, aborted: false };
    }

    for (const name of ["brief", "implement", "verify", "next"]) {
      await step(name);
    }
    return { completed, aborted: false };
  } catch (error) {
    if (isCutOff(error)) {
      return { completed, aborted: true };
    }
    throw error;
  }
}

/**
 * The error a fix raises when it changed nothing.
 *
 * The review loop stops on it: a fix that moved nothing has nothing to push
 * and nothing to review again, and the loop would spend a review on the same
 * diff to hear the same verdict.
 */
export class FixChangedNothing extends WorkflowError {
  constructor(message = "the fix changed nothing") {
    super(message, WORKFLOW_ERROR_CODE.execution, { recoverable: false });
    this.name = "FixChangedNothing";
  }
}

/** The error a review raises when it ended without stating a verdict. */
export class ReviewStatedNoVerdict extends WorkflowError {
  constructor(message = "the review stated no verdict") {
    super(message, WORKFLOW_ERROR_CODE.execution, { recoverable: false });
    this.name = "ReviewStatedNoVerdict";
  }
}

/** Why the review loop stopped. One value per stop. */
export type ReviewGateStopReason =
  | { readonly kind: "passed" }
  | { readonly kind: "failed" }
  | { readonly kind: "noChange" }
  | { readonly kind: "statedNoVerdict" }
  | { readonly kind: "cutOff"; readonly message: string };

/** What the review loop did. */
export interface ReviewGateResult {
  /** How many reviews the loop asked for. */
  readonly reviews: number;
  /** Why the loop stopped. */
  readonly stopReason: ReviewGateStopReason;
}

/**
 * Review, fix, and review again until the verdict passes or the attempts run
 * out.
 *
 * `review` returns the verdict; `fix` gets the feedback the failed verdict
 * produced and does the correcting. The number of attempts bounds the loop, and
 * the caller's own deadline bounds each turn.
 *
 * A `fix` that raises {@link FixChangedNothing} stops the loop: there is
 * nothing to push and nothing to review again, and the loop comes back with
 * `noChange` set.
 *
 * A review that was cut off stops the loop too. A cut-off review stated no
 * verdict, so there is nothing to fix and nothing to review again, and the loop
 * comes back with `cutOff` set.
 */
export async function runReviewGate(options: {
  readonly attempts: number;
  readonly review: () => Promise<"pass" | "fail">;
  readonly fix: (feedback: string | undefined) => Promise<void>;
}): Promise<ReviewGateResult> {
  let reviews = 0;
  let feedback: string | undefined;

  try {
    for (let attempt = 0; attempt < options.attempts; attempt += 1) {
      if (feedback !== undefined) {
        try {
          await options.fix(feedback);
        } catch (error) {
          if (error instanceof GateFailed) {
            // A gate that refused the fix is not a failure the loop may carry
            // on from: it would carry on to the next review, and the review
            // would pass on a tree that was never pushed — the run would say it
            // worked, and nothing would name the gate. The failure under it is
            // kept, so the record and the exit code can name it.
            throw new WorkflowError(error.message, WORKFLOW_ERROR_CODE.execution, {
              recoverable: false,
              details: error,
            });
          }
          if (isCutOff(error)) {
            return {
              reviews,
              stopReason: { kind: "cutOff", message: messageOf(error) },
            };
          }
          // A fix that changed nothing carries its own way out, and a fix that
          // failed is a failure the run reports.
          throw error;
        }
      }

      reviews += 1;
      let verdict: "pass" | "fail";
      try {
        verdict = await options.review();
      } catch (error) {
        if (error instanceof ReviewStatedNoVerdict) {
          return { reviews, stopReason: { kind: "statedNoVerdict" } };
        }
        if (isCutOff(error)) {
          return { reviews, stopReason: { kind: "cutOff", message: messageOf(error) } };
        }
        throw error;
      }
      if (verdict === "pass") {
        return { reviews, stopReason: { kind: "passed" } };
      }
      feedback = "the review said fail";
    }
    return { reviews, stopReason: { kind: "failed" } };
  } catch (error) {
    // The fix that changed nothing stops the loop, and the loop's verdict is
    // a failure: the review did not pass, and the fix did not answer it.
    if (error instanceof FixChangedNothing) {
      return { reviews, stopReason: { kind: "noChange" } };
    }
    throw error;
  }
}
