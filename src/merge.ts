/**
 * The merge pipeline: land the pull requests the work pipeline opened.
 *
 * It is a **separate, opt-in mode**. The work pipeline never merges — that is
 * its guarantee, and a human lands what it opens. This pipeline is the one that
 * lands, and only a pull request that has already passed the work pipeline's
 * review and the target repository's CI is a candidate.
 *
 * A candidate is merged only when this run does not change its branch. A branch
 * that has to move — because the base moved under it, a conflict had to be
 * resolved, or the gate failed — is synced, gated, pushed and reviewed, and
 * then left for the **next** run: a merge never lands a commit CI has not
 * judged. The timer model makes that a delay of one tick, not a manual step.
 *
 * The record of each pull request lives under
 * `build/diagnostics/merge/pr-<N>/`, beside the work runs' own records.
 */

import { join } from "node:path";

import { errorMessage } from "./cli.js";
import {
  RECOUNT_LABEL,
  mergePullRequest,
  newestReviewVerdict,
  readOpenPullRequests,
  type GhRunner,
  type OpenPullRequest,
} from "./gh.js";
import {
  CommandFailed,
  fetchCommit,
  headRef,
  pushWorkBranch,
  readRemoteSha,
  removeWorktree,
  type CommandRunner,
  type GitRunner,
} from "./git.js";
import {
  RunFailed,
  checkoutPullRequestBranch,
  commitAll,
  headSha,
  newRunId,
  readCiOutcome,
  reviewPullRequest,
  runSteps,
  type Step,
  type StepRecord,
} from "./runner.js";
import {
  UNTRUSTED_INPUT_RULE,
  UNTRUSTED_INPUT_SECTION,
  runPromptArray,
  type SessionFactory,
} from "./session.js";

/** The branch an issue's work is pushed to. A pull request from it is ours. */
export const WORK_BRANCH_PATTERN = /^agent\/issue-(\d+)$/;

/** The repository's own gate — the command the work prompt names. */
export const GATE_SCRIPT = "./check.sh";

/** A marker a resolved conflict must not leave behind. */
const CONFLICT_MARKER = "^<<<<<<< ";

/** How long the gate may run before it is a failure of its own. */
const DEFAULT_GATE_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * The prompt the merge agent is given.
 *
 * It runs only when the branch had to move: a conflict, or a gate the base's
 * arrival broke. It resolves and commits; the runner pushes and reviews.
 */
export const MERGE_PROMPT = [
  "A pull request branch had to be brought up to date with its base, and the",
  "worktree is in the middle of it. Resolve it.",
  "",
  "1. Resolve every conflict. Read both sides: keep what each was trying to do,",
  "   do not drop one side to make the merge quiet.",
  "",
  "2. Run the repository's gate:",
  "",
  "   ```bash",
  `   ${GATE_SCRIPT}`,
  "   ```",
  "",
  "   Fix what it reports. A gate that fails is the merge not being finished.",
  "",
  "3. Leave the tree with no conflict markers and the gate green. Do not commit,",
  "   do not push: the pipeline commits and pushes so the push stays under its",
  "   control.",
].join("\n");

/** A pull request the merge pipeline considered. */
export interface MergeSubject {
  readonly pullRequest: number;
  readonly title: string;
}

/** What the merge pipeline did. */
export interface MergeResult {
  /** The pull requests this run landed. */
  readonly merged: readonly number[];
  /** The candidates it left alone, and why. */
  readonly skipped: readonly { readonly pullRequest: number; readonly reason: string }[];
  /** The candidates whose processing stopped, and the step it stopped at. */
  readonly failed: readonly {
    readonly pullRequest: number;
    readonly step: string;
    readonly message: string;
  }[];
}

export interface MergeOptions {
  /** The repository the pull requests live in — `owner/name`. */
  readonly repo: string;
  /** The checkout the worktrees are made from. */
  readonly checkout: string;
  readonly remote: string;
  readonly baseBranch: string;
  readonly worktreeRoot: string;
  readonly git: GitRunner;
  readonly gh: GhRunner;
  readonly run: CommandRunner;
  /** The agent that resolves a conflict or a gate failure. */
  readonly session: SessionFactory;
  readonly deadlineMs: number;
  /** Whether the target repository's pre-push hook may gate the push. */
  readonly verifyPushes?: boolean;
  /** Whether somebody has stopped the run. */
  readonly stopped?: () => boolean;
  readonly onStep?: (record: StepRecord) => void;
  readonly onStepStart?: (step: string) => void;
  /** The pull request under way, told before its first step. */
  readonly onSubject?: (subject: MergeSubject) => void;
  readonly now?: Date;
  readonly runId?: string;
  readonly gateTimeoutMs?: number;
}

/** The issue a work branch belongs to, or null when it is not one of ours. */
export function issueNumberFromBranch(branch: string): number | null {
  const match = WORK_BRANCH_PATTERN.exec(branch);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/**
 * Land every reviewed, green pull request the work pipeline opened.
 *
 * The read is the repository's, the filter is the branch prefix, and the two
 * gates are the review's verdict and the CI's own exit — nothing here guesses
 * that a pull request is good because it is open.
 */
export async function mergeReviewedPullRequests(
  options: MergeOptions,
): Promise<MergeResult> {
  const runId = options.runId ?? newRunId(options.now);
  const candidates = await readOpenPullRequests(
    options.repo,
    options.baseBranch,
    options.gh,
  );

  const merged: number[] = [];
  const skipped: { pullRequest: number; reason: string }[] = [];
  const failed: { pullRequest: number; step: string; message: string }[] = [];

  for (const candidate of candidates) {
    if (options.stopped?.() === true) {
      break;
    }
    const issueNumber = issueNumberFromBranch(candidate.headRefName);
    if (issueNumber === null) {
      // Another author's pull request. The pipeline lands only its own.
      continue;
    }
    const reason = await skipReason(options, candidate);
    if (reason !== null) {
      skipped.push({ pullRequest: candidate.number, reason });
      continue;
    }

    options.onSubject?.({ pullRequest: candidate.number, title: candidate.title });
    try {
      const outcome = await mergeOne(options, candidate, issueNumber, runId);
      if (outcome.merged) {
        merged.push(candidate.number);
      } else {
        skipped.push({ pullRequest: candidate.number, reason: outcome.reason });
      }
    } catch (failure) {
      failed.push({
        pullRequest: candidate.number,
        step: failure instanceof RunFailed ? failure.step : "merge",
        message: errorMessage(failure),
      });
    }
  }

  return { merged, skipped, failed };
}

/** Why a pull request is not a candidate, or null when it is. */
async function skipReason(
  options: MergeOptions,
  candidate: OpenPullRequest,
): Promise<string | null> {
  if (candidate.isDraft) {
    return "it is a draft";
  }
  const verdict = newestReviewVerdict(candidate.comments);
  if (verdict === null) {
    return "it carries no review verdict";
  }
  if (verdict === "fail") {
    return "its newest review said fail";
  }
  if (!candidate.labels.includes(RECOUNT_LABEL)) {
    return `it was not re-counted — it carries no ${RECOUNT_LABEL} label`;
  }
  const ci = await readCiOutcome(options.run, options.checkout, {
    ref: String(candidate.number),
    repo: options.repo,
  });
  if (ci === null) {
    return "its CI could not be read";
  }
  if (!ci.success) {
    return `its CI is not green — ${ci.verdict}`;
  }
  return null;
}

/**
 * The steps of one pull request.
 *
 * The branch is read, the base is merged into it, and the gate runs only when
 * the branch changed — an unchanged branch is the commit CI already judged.
 * A change is pushed and reviewed, and then deliberately **not** merged: the
 * next run lands it once CI has judged the new commit.
 */
async function mergeOne(
  options: MergeOptions,
  candidate: OpenPullRequest,
  issueNumber: number,
  runId: string,
): Promise<{ readonly merged: true } | { readonly merged: false; readonly reason: string }> {
  const worktreePath = join(options.worktreeRoot, `pull-request-${candidate.number}`);
  const branch = candidate.headRefName;
  const state = { before: "", after: "", changed: false };

  const steps: Step[] = [
    {
      name: "merge-worktree",
      run: async () => {
        state.before = await checkoutPullRequestBranch({
          checkout: options.checkout,
          remote: options.remote,
          branch,
          worktreePath,
          git: options.git,
          run: options.run,
        });
        state.after = state.before;
        return `${branch} at ${state.before.slice(0, 8)}`;
      },
    },
    {
      name: "merge-sync",
      run: async () => {
        // The commit comes from a ref this step fetches for itself, not from
        // `FETCH_HEAD`: one file serves the whole repository, and a work run's
        // fetch can land between this one's fetch and the read.
        const baseSha = await fetchCommit(options.git, options.checkout, {
          remote: options.remote,
          ref: headRef(options.baseBranch),
        });
        try {
          await options.git(
            [
              "-c",
              "user.name=afk-runner",
              "-c",
              "user.email=afk-runner@localhost",
              "merge",
              "--no-edit",
              baseSha,
            ],
            { cwd: worktreePath },
          );
        } catch (failure) {
          if (!(failure instanceof CommandFailed)) {
            throw failure;
          }
          await resolveWithAgent(options, worktreePath);
        }
        state.after = await headSha(options.git, worktreePath);
        state.changed = state.after !== state.before;
        return state.changed ? `branch moved to ${state.after.slice(0, 8)}` : "up to date";
      },
    },
    {
      name: "merge-gate",
      run: async () => {
        if (!state.changed) {
          return "not needed — CI judged this commit";
        }
        return await verifyGate(options, worktreePath);
      },
    },
    {
      name: "merge-push",
      run: async () => {
        if (!state.changed) {
          return "unchanged";
        }
        // The gate's agent may have committed a fix after merge-sync recorded
        // the head. Push what the worktree holds now, or the fix is never sent.
        state.after = await headSha(options.git, worktreePath);
        await pushWorkBranch(options.git, worktreePath, {
          remote: options.remote,
          issueNumber,
          sha: state.after,
          ...(options.verifyPushes === undefined
            ? {}
            : { verify: options.verifyPushes }),
        });
        return state.after.slice(0, 8);
      },
    },
    {
      name: "merge-review",
      run: async () => {
        if (!state.changed) {
          return "unchanged";
        }
        const outcome = await reviewPullRequest({
          repo: options.repo,
          pullRequest: candidate.number,
          cwd: worktreePath,
          factory: options.session,
          gh: options.gh,
          run: options.run,
          deadlineMs: options.deadlineMs,
          ...(options.stopped === undefined ? {} : { stopped: options.stopped }),
        });
        if (outcome.verdict !== "pass") {
          throw new Error(`the review of the synced branch said ${outcome.verdict}`);
        }
        return "pass";
      },
    },
    {
      name: "merge",
      run: async () => {
        if (state.changed) {
          return "left for the next run — CI has not judged the new commit";
        }
        // The verdict and the CI were read before the worktree and the gate. A
        // human can post `fail`, or push, in the minutes since. Re-read the
        // pull request and the branch, and land only the head this run checked.
        const current = (
          await readOpenPullRequests(options.repo, options.baseBranch, options.gh)
        ).find((entry) => entry.number === candidate.number);
        if (current === undefined) {
          throw new Error(`pull request ${candidate.number} is no longer open`);
        }
        const stale = await skipReason(options, current);
        if (stale !== null) {
          throw new Error(`its re-check said no — ${stale}`);
        }
        const head = await readRemoteSha(options.git, options.checkout, {
          remote: options.remote,
          ref: headRef(branch),
        });
        if (head !== state.before) {
          throw new Error(
            `the branch moved after it was checked: ${state.before.slice(0, 8)} is not ` +
              `${head === null ? "on the remote" : head.slice(0, 8)}`,
          );
        }
        await mergePullRequest(options.repo, candidate.number, state.before, options.gh);
        return `#${candidate.number}`;
      },
    },
  ];

  try {
    await runSteps({
      issue: candidate.number,
      runId,
      root: options.checkout,
      steps,
      directory: join(
        options.checkout,
        "build",
        "diagnostics",
        "merge",
        `pr-${candidate.number}`,
      ),
      heading: `# Merge pull request ${candidate.number}`,
      subject: "pull request",
      ...(options.onStep === undefined ? {} : { onStep: options.onStep }),
      ...(options.onStepStart === undefined ? {} : { onStepStart: options.onStepStart }),
      release: async () => {
        await removeWorktree(options.git, options.checkout, worktreePath);
      },
    });
  } finally {
    // Scratch, on both paths: the branch holds the work.
    await removeWorktree(options.git, options.checkout, worktreePath).catch(() => {
      // A worktree that could not be removed is cleaned up by the next attempt.
    });
  }

  return state.changed
    ? {
        merged: false,
        reason: "its branch was synced and reviewed; it lands once CI is green",
      }
    : { merged: true };
}

/**
 * Run the gate, and let the agent fix a failure once.
 *
 * A second failure is the pull request's, not the agent's: it is thrown, the
 * step is recorded as failed, and the pull request stays open.
 */
async function verifyGate(options: MergeOptions, worktreePath: string): Promise<string> {
  const run = async (): Promise<void> => {
    await options.run({
      command: "bash",
      args: [GATE_SCRIPT],
      cwd: worktreePath,
      timeoutMs: options.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS,
    });
  };
  try {
    await run();
    return "passed";
  } catch {
    await resolveWithAgent(options, worktreePath);
    await run();
    return "passed after the agent's fix";
  }
}

/**
 * Let the merge agent resolve the worktree, and refuse to go on with markers.
 *
 * The agent is told not to commit; the runner commits, so the identity and the
 * push stay its own. A marker left behind is a resolution that is not one.
 */
async function resolveWithAgent(options: MergeOptions, worktreePath: string): Promise<void> {
  const session = await options.session({
    cwd: worktreePath,
    systemPromptSections: { [UNTRUSTED_INPUT_SECTION]: UNTRUSTED_INPUT_RULE },
  });
  const result = await runPromptArray({
    session,
    prompts: [MERGE_PROMPT],
    deadlineMs: options.deadlineMs,
    ...(options.stopped === undefined ? {} : { stopped: options.stopped }),
  });
  if (result.aborted) {
    throw new Error("the merge session was cut off before it resolved the worktree");
  }

  const marked = await options
    .git(["grep", "-l", "-e", CONFLICT_MARKER], { cwd: worktreePath })
    .catch((failure: unknown) => {
      // `git grep` exits 1 when nothing matches. Anything else is a real
      // failure, and a resolution the runner cannot inspect is not one.
      if (failure instanceof CommandFailed && failure.exitCode === 1) {
        return "";
      }
      throw failure;
    });
  if (marked.trim() !== "") {
    throw new Error(`conflict markers remain in ${marked.trim().split("\n")[0] ?? "the tree"}`);
  }

  await commitAll(options.git, worktreePath, "merge: bring the branch up to date");
}
