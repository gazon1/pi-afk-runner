/**
 * What the live chat shows while a run is under way.
 *
 * A human watching the run needs three facts and nothing else: which issue the
 * run is on, what that issue is called, and how far the run has got. The stage
 * names are the runner's own step names, so the line in the footer is the same
 * vocabulary the record under `build/diagnostics/issue-<N>/` uses.
 */

/** What the footer says about the run in flight. */
export interface RunStatus {
  /** The issue the run works. */
  readonly issue: number;
  /** The issue's title, as GitHub has it. */
  readonly title: string;
  /** The step the run has reached. */
  readonly stage: string;
}

/**
 * The status line.
 *
 * One line, because the footer is a status line and not a report: the issue,
 * its title, and the stage, separated so that a truncated title still leaves
 * the issue number readable. The stage is absent for the moment between the run
 * taking its issue and taking its first step.
 */
export function statusLine(status: RunStatus): string {
  return [`#${status.issue}`, status.title, status.stage]
    .filter((part) => part !== "")
    .join(" · ");
}

/**
 * The state a session needs to remember so that the next human who opens it
 * sees the same line.
 *
 * It is a session entry and not a file of the runner's own: the runner has no
 * state store — everything it knows lives in GitHub and in git — and a session
 * already is the place a live chat's own progress belongs.
 */
export const RUN_STATUS_ENTRY = "afk-runner-status";

/** The entry's payload. */
export interface RunStatusEntry {
  readonly issue: number;
  readonly title: string;
  readonly stage: string;
}

/**
 * The status a session remembers, or null when it remembers none.
 *
 * The newest entry wins: a session that ran twice shows the second run.
 */
export function statusFromEntries(
  entries: readonly { readonly type: string; readonly customType?: string; readonly data?: unknown }[],
): RunStatus | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined || entry.type !== "custom" || entry.customType !== RUN_STATUS_ENTRY) {
      continue;
    }
    const data = entry.data as Partial<RunStatusEntry> | undefined;
    if (
      data === undefined ||
      typeof data.issue !== "number" ||
      typeof data.title !== "string" ||
      typeof data.stage !== "string"
    ) {
      continue;
    }
    return { issue: data.issue, title: data.title, stage: data.stage };
  }
  return null;
}
