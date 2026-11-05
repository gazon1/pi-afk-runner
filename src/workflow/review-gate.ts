/**
 * The review loop.
 *
 * Review, fix, and review again until the verdict passes or the attempts run
 * out. It is a loop in the engine: the body is one round — the fix the
 * previous round's verdict bought, and the review that follows it — and the
 * loop's condition says when it is over.
 *
 * `review` returns the verdict; `fix` gets the feedback the failed verdict
 * produced and does the correcting. The number of attempts bounds the loop,
 * and the caller's own deadline bounds each turn.
 */

import { createStep, createWorkflow } from "@mastra/core/workflows";

import { GateFailed } from "../gates.js";
import {
  FixChangedNothing,
  isCutOff,
  messageOf,
  ReviewStatedNoVerdict,
  WorkflowError,
  WORKFLOW_ERROR_CODE,
} from "./errors.js";
import { answerSchema, type Failure } from "./steps.js";

/** Why the review loop stopped. One value per stop. */
type ReviewGateStopReason =
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

/** What the loop knows while it runs. */
interface Gate {
  /** How many reviews the loop asked for. */
  reviews: number;
  /** The feedback the last failed verdict bought a fix with. */
  feedback: string | undefined;
  /** Why the loop stopped, when it stopped. */
  stop: ReviewGateStopReason | undefined;
}

/**
 * Review, fix, and review again until the verdict passes or the attempts run
 * out.
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
  if (options.attempts <= 0) {
    // No attempts, no reviews. The engine's loop runs its body at least once,
    // so the empty case is settled here rather than by the loop.
    return { reviews: 0, stopReason: { kind: "failed" } };
  }

  const gate: Gate = { reviews: 0, feedback: undefined, stop: undefined };
  const failure: Failure = {};

  const round = createStep({
    id: "review-round",
    inputSchema: answerSchema,
    outputSchema: answerSchema,
    async execute({ abort }) {
      try {
        if (gate.feedback !== undefined) {
          try {
            await options.fix(gate.feedback);
          } catch (error) {
            if (error instanceof GateFailed) {
              // A gate that refused the fix is not a failure the loop may carry
              // on from: it would carry on to the next review, and the review
              // would pass on a tree that was never pushed — the run would say
              // it worked, and nothing would name the gate. The failure under
              // it is kept, so the record and the exit code can name it.
              throw new WorkflowError(error.message, WORKFLOW_ERROR_CODE.execution, {
                recoverable: false,
                details: error,
              });
            }
            if (isCutOff(error)) {
              gate.stop = { kind: "cutOff", message: messageOf(error) };
              return { token: "stopped" };
            }
            if (error instanceof FixChangedNothing) {
              // The fix that changed nothing carries its own way out, and the
              // loop's verdict is a failure: the review did not pass, and the
              // fix did not answer it.
              gate.stop = { kind: "noChange" };
              return { token: "stopped" };
            }
            // A fix that failed is a failure the run reports.
            throw error;
          }
        }

        gate.reviews += 1;
        let verdict: "pass" | "fail";
        try {
          verdict = await options.review();
        } catch (error) {
          if (error instanceof ReviewStatedNoVerdict) {
            gate.stop = { kind: "statedNoVerdict" };
            return { token: "stopped" };
          }
          if (isCutOff(error)) {
            gate.stop = { kind: "cutOff", message: messageOf(error) };
            return { token: "stopped" };
          }
          throw error;
        }
        if (verdict === "pass") {
          gate.stop = { kind: "passed" };
          return { token: "passed" };
        }
        gate.feedback = "the review said fail";
        return { token: "failed" };
      } catch (error) {
        // The failure is carried beside the run, and the run is stopped: the
        // engine's own copy of it is a plain object, and this failure is told
        // apart by its class.
        failure.value = error;
        abort();
        return { token: "failed" };
      }
    },
  });

  const script = createWorkflow({
    id: "review-gate",
    inputSchema: answerSchema,
    outputSchema: answerSchema,
  }).dountil(round, async () => gate.stop !== undefined || gate.reviews >= options.attempts);

  const run = await script.commit().createRun();
  const result = await run.start({ inputData: { token: "review" } });

  if (failure.value !== undefined) {
    throw failure.value;
  }
  if (result.status !== "success") {
    // A run that ended in any other way — failed, cancelled, suspended — is a
    // failure the caller is told about: a loop that did not end is a loop that
    // did not work.
    const error = "error" in result ? result.error : undefined;
    throw new Error(error?.message ?? `the review loop ${result.status}`);
  }
  if (gate.stop !== undefined) {
    return { reviews: gate.reviews, stopReason: gate.stop };
  }
  return { reviews: gate.reviews, stopReason: { kind: "failed" } };
}
