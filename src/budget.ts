/**
 * The run's budget, and the shares it is divided into.
 *
 * The runner's budget is one wall-clock for everything a run does: the work
 * session, the gates and the review. Each keeps a share of it, and the shares
 * are **reserved** — a session that spends its whole budget must not leave
 * the gates nothing to run with, because a gate that is killed half-way
 * through leaves a run that pushes nothing.
 */
import { GATES, GATE_TIMEOUT_MS } from "./gates.js";

/** The work session's share of the run's budget. */
export const SESSION_SHARE_MS = 60 * 60 * 1000;

/**
 * The gates' share of the run's budget.
 *
 * An hour per gate: the same the merge door gives the same gate, because the
 * gate has the same work to do there — and a gate the merge door would have
 * let finish must not be killed here for want of time.
 */
export const GATES_SHARE_MS = GATES.length * GATE_TIMEOUT_MS;

/** The review session's share of the run's budget. */
export const REVIEW_SHARE_MS = 30 * 60 * 1000;

/** The default ceiling on a run: the three shares, added up. */
export const DEFAULT_DEADLINE_MS = SESSION_SHARE_MS + GATES_SHARE_MS + REVIEW_SHARE_MS;

/** The shares a run's budget is divided into. */
export interface BudgetShares {
  /** What the work session may spend. */
  readonly sessionMs: number;
  /** What the gates may spend, in the whole run. */
  readonly gatesMs: number;
  /** What the review may spend. */
  readonly reviewMs: number;
}

/**
 * Divide the run's budget into the three shares.
 *
 * The shares scale together: a smaller ceiling is a smaller run all the way
 * through, and not a run whose gates are the part that starves.
 */
export function budgetShares(deadlineMs: number): BudgetShares {
  const scale = deadlineMs / DEFAULT_DEADLINE_MS;
  const sessionMs = Math.floor(SESSION_SHARE_MS * scale);
  const gatesMs = Math.floor(GATES_SHARE_MS * scale);
  return {
    sessionMs,
    gatesMs,
    reviewMs: Math.max(0, deadlineMs - sessionMs - gatesMs),
  };
}
