/**
 * The graph's own errors.
 *
 * They are the runner's, not the engine's: the engine catches a failure and
 * hands it back as a plain object, and these are told apart by their class
 * and by what they carry — the cut-off from the failure, the failure under the
 * graph's error.
 */

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
export function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
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
