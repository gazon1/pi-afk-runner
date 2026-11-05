import {
  CLAIM_LABEL,
  RECOUNT_LABEL,
  REVIEW_MARKER,
  newestReviewVerdict,
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
  | "Failed"
  | "Reviewed"
  | "Counted";

/** What can be seen of one issue. */
export interface Observables {
  /** `L` — the issue carries `agent-in-progress`. */
  readonly claimLabel: boolean;
  /** `P` — a pull request exists for the branch. */
  readonly pullRequest: boolean;
  /** `V` — that pull request carries a review comment that opens with the marker. */
  readonly reviewComment: boolean;
  /** `W` — what the newest marked review comment states, or null when it states nothing. */
  readonly reviewVerdict: "pass" | "fail" | null;
  /** `C` — that pull request carries `agent-reviewed`. */
  readonly recountLabel: boolean;
  /**
   * `R` — the remote branch `agent/issue-<N>` carries work.
   *
   * Existence is not enough: a branch that points at the base carries nothing,
   * and GitHub refuses a pull request for it.
   */
  readonly workBranch: boolean;
  /** `A` — the claim is older than the staleness window. */
  readonly stale: boolean;
}

/** The observables of an issue nobody has touched. */
export const UNCLAIMED: Observables = {
  claimLabel: false,
  pullRequest: false,
  reviewComment: false,
  reviewVerdict: null,
  recountLabel: false,
  workBranch: false,
  stale: false,
};

/**
 * Derive the state of an issue from what can be seen of it.
 */
export function deriveState(observables: Observables): DerivedState {
  if (
    observables.pullRequest &&
    observables.reviewComment &&
    observables.reviewVerdict === "fail"
  ) {
    return "Failed";
  }
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
 */
export function selectIssue(queue: readonly IssueSummary[]): IssueSummary | undefined {
  return queue.find((issue) => !issue.labels.includes(CLAIM_LABEL));
}

/**
 * What a pull request says about itself.
 */
export function observePullRequest(pullRequest: PullRequestSummary | null): {
  readonly reviewComment: boolean;
  readonly recountLabel: boolean;
  readonly reviewVerdict: "pass" | "fail" | null;
} {
  if (pullRequest === null) {
    return { reviewComment: false, recountLabel: false, reviewVerdict: null };
  }
  const reviewComment = pullRequest.comments.some((body) =>
    body.trimStart().startsWith(REVIEW_MARKER),
  );
  return {
    reviewComment,
    recountLabel: pullRequest.labels.includes(RECOUNT_LABEL),
    reviewVerdict: newestReviewVerdict(pullRequest.comments),
  };
}

/**
 * Is the claim old enough to take over?
 */
export function isStale(updatedAt: string, now: Date, staleAfterMs: number): boolean {
  const updated = Date.parse(updatedAt);
  if (Number.isNaN(updated)) {
    return false;
  }
  return now.getTime() - updated >= staleAfterMs;
}
