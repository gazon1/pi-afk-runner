/**
 * The tokens the work session's branch is keyed by.
 *
 * They are named once, here: the branch and the turn that decides it read the
 * same names, so the edge the graph takes and the word the model said cannot
 * drift apart.
 */

/** The token the triage turn answered with. */
export const TRIAGE_TOKEN = {
  /** The issue is worth working. */
  work: "work",
  /** The issue should be closed instead of worked. */
  skip: "skip",
} as const;

/** The token the scope turn answered with. */
export const SCOPE_TOKEN = {
  /** The issue fits one run. */
  fits: "fits",
  /** The issue has to become smaller issues. */
  split: "split",
} as const;

/** The decision the triage turn made. */
export type TriageToken = (typeof TRIAGE_TOKEN)[keyof typeof TRIAGE_TOKEN];

/** The decision the scope turn made. */
export type ScopeToken = (typeof SCOPE_TOKEN)[keyof typeof SCOPE_TOKEN];
