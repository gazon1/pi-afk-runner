/**
 * The runner's state, derived from what can be seen.
 *
 * The runner keeps no journal. Everything it needs to know about an issue it
 * reads from GitHub and from git, so the state of an issue is *derived* from six
 * observables rather than remembered:
 *
 * | | Observable | Question it answers |
 * |---|---|---|
 * | `L` | `claimLabel` | does the issue carry `agent-in-progress`? |
 * | `P` | `pullRequest` | does a pull request exist for the branch? |
 * | `V` | `reviewComment` | does that pull request carry a review comment? |
 * | `C` | `recountLabel` | does that pull request carry `agent-reviewed`? |
 * | `R` | `workBranch` | does the remote branch `agent/issue-<N>` exist? |
 * | `A` | `stale` | is the claim older than the window? |
 *
 * The derivation is a pure function of those six. That is what makes recovery
 * possible: a run that died leaves the world in some state, and a later run
 * re-derives that state rather than replaying a log it does not have.
 *
 * Three of the runner's ten states — `Isolated`, `Working`, `Ready` — belong to
 * a process that is *running*: they live in one host's worktree, and nothing
 * outside that host can see them. They are never derived. A run that finds them
 * on its own host continues; a run on another host sees the claim as stale and
 * takes it over.
 */

import {
  CLAIM_LABEL,
  RECOUNT_LABEL,
  REVIEW_MARKER,
  type IssueSummary,
  type PullRequestSummary,
} from "./gh.js";

/** The states that can be derived from the observables. */
export type DerivedState =
  | "Queue"
  | "Claimed"
  | "Orphaned"
  | "Pushed"
  | "Opened"
  | "Reviewed"
  | "Counted";

/**
 * The states that belong to a running process and are never derived.
 *
 * `Isolated` — the worktree exists and the setup script has run.
 * `Working` — the agent session is running.
 * `Ready` — the agent finished and the worktree holds commits.
 */
export type LiveState = "Isolated" | "Working" | "Ready";

/** Every state the runner knows an issue to be in. */
export type RunnerState = DerivedState | LiveState;

/** What can be seen of one issue. */
export interface Observables {
  /** `L` — the issue carries `agent-in-progress`. */
  readonly claimLabel: boolean;
  /** `P` — a pull request exists for the branch. */
  readonly pullRequest: boolean;
  /** `V` — that pull request carries a review comment that opens with the marker. */
  readonly reviewComment: boolean;
  /** `C` — that pull request carries `agent-reviewed`. */
  readonly recountLabel: boolean;
  /** `R` — the remote branch `agent/issue-<N>` exists. */
  readonly workBranch: boolean;
  /** `A` — the claim is older than the staleness window. */
  readonly stale: boolean;
}

/** The observables of an issue nobody has touched. */
export const UNCLAIMED: Observables = {
  claimLabel: false,
  pullRequest: false,
  reviewComment: false,
  recountLabel: false,
  workBranch: false,
  stale: false,
};

/**
 * Derive the state of an issue from what can be seen of it.
 *
 * The order of the questions is the order of the decisions:
 *
 * 1. No claim label → the issue is in the queue, whoever gets it.
 * 2. A pull request exists → the issue has left the queue, and how far it got
 *    is what the pull request's own state says.
 * 3. No pull request but a work branch → the work was pushed and the pull
 *    request was never opened.
 * 4. Neither → the claim is either live or stranded, and the age decides.
 */
export function deriveState(observables: Observables): DerivedState {
  if (!observables.claimLabel) {
    return "Queue";
  }
  if (observables.pullRequest) {
    if (observables.reviewComment) {
      return observables.recountLabel ? "Counted" : "Reviewed";
    }
    return "Opened";
  }
  if (observables.workBranch) {
    return "Pushed";
  }
  return observables.stale ? "Orphaned" : "Claimed";
}

/**
 * Pick the issue this run will work.
 *
 * The queue query already excludes the claimed issues — the exclusion is in the
 * search form, so the claimed issues are never fetched. This is the second
 * half of the same rule: the runner does not *trust* the query to have done
 * it. A queue that somehow carries a claimed issue is a bug in the query, and
 * working it anyway would put two runs on one issue — the exact thing the
 * claim exists to prevent.
 */
export function selectIssue(
  queue: readonly IssueSummary[],
): IssueSummary | undefined {
  return queue.find((issue) => !issue.labels.includes(CLAIM_LABEL));
}

/**
 * What a pull request says about itself.
 *
 * `reviewComment` is true only for a comment that **opens** with the marker:
 * the gate wants the marker on the first non-blank line, so a comment that
 * quotes the format somewhere in the middle is not a review.
 */
export function observePullRequest(
  pullRequest: PullRequestSummary | null,
): { readonly reviewComment: boolean; readonly recountLabel: boolean } {
  if (pullRequest === null) {
    return { reviewComment: false, recountLabel: false };
  }
  const reviewComment = pullRequest.comments.some((body) =>
    body.trimStart().startsWith(REVIEW_MARKER),
  );
  return {
    reviewComment,
    recountLabel: pullRequest.labels.includes(RECOUNT_LABEL),
  };
}

/**
 * Is the claim old enough to take over?
 *
 * The window is a parameter, not a constant, because its value is a decision
 * the plan has not made: too short and a slow run loses its issue to a second
 * runner, too long and a killed run keeps the issue out of the queue for
 * hours. The caller supplies it.
 */
export function isStale(
  updatedAt: string,
  now: Date,
  staleAfterMs: number,
): boolean {
  const updated = Date.parse(updatedAt);
  if (Number.isNaN(updated)) {
    // An issue whose last-update time cannot be read is not treated as stale:
    // guessing wrong in that direction takes an issue from a live run.
    return false;
  }
  return now.getTime() - updated >= staleAfterMs;
}
