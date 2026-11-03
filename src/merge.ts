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
 * `build/diagnostics/merge/pr-<N>/`, beside the work runs' own records, and
 * the journal of the merge — the session's lines, written while it works — is
 * the file beside that record. The sweep has a journal of its own, under
 * `build/diagnostics/merge/` beside those directories: the pull requests it
 * considered, the ones it left alone and why, and where it stopped.
 */

import { dirname, join } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";

import { budgetShares } from "./budget.js";
import { errorMessage } from "./cli.js";
import {
  RECOUNT_LABEL,
  mergePullRequest,
  newestReviewVerdict,
  readOpenPullRequests,
  type GhRunner,
  type OpenPullRequest,
} from "./gh.js";
import { GATE_OUTPUT_LIMIT_BYTES, GATE_TIMEOUT_MS, gateFailure, gateInvocation } from "./gates.js";
import {
  diagnosticsDirectory,
  gatesLogPath,
  journalFactory,
  journalHeader,
  journalPath,
  journalWriter,
  pullRequestSubject,
  sweepJournalDirectory,
  sweepJournalHeader,
} from "./journal.js";
import {
  CommandFailed,
  fetchCommit,
  hasUnmergedEntries,
  headRef,
  pushWorkBranch,
  readRemoteSha,
  removeWorktree,
  WORK_BRANCH_PATTERN,
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
  cutOffMessage,
  runPromptArray,
  UNTRUSTED_INPUT_RULE,
  UNTRUSTED_INPUT_SECTION,
  type SessionFactory,
} from "./session.js";

/**
 * The branch an issue's work is pushed to. A pull request from it is ours.
 *
 * The pattern is the runner's own — it lives beside the name it recognises,
 * so the two cannot drift — and the merge pipeline asks it rather than
 * spelling a branch of its own.
 */
export { WORK_BRANCH_PATTERN };

/** The repository's own gate — the command the work prompt names. */
export const GATE_SCRIPT = "./check.sh";

/**
 * How many gates the merge pipeline runs: one.
 *
 * The work pipeline runs no gate unless it is told to, but the merge door
 * always runs the repository's own gate, and the budget it gets is a gate's
 * share.
 */
const MERGE_GATE_COUNT = 1;

/** A marker a resolved conflict must not leave behind. */
const CONFLICT_MARKER = "^<<<<<<< ";

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
  "2. Leave the tree with no conflict markers. Do not commit,",
  "   do not push: the pipeline commits and pushes so the push stays under its",
  "   control.",
  "",
  "   **The resolution stays in the tree while this turn runs.** The pipeline",
  "   keeps the tree and commits it, so the resolution you make belongs in the",
  "   tree. A stash is not part of what the pipeline commits: it lives in the",
  "   repository's own stash, where nothing says which entry is whose, and the",
  "   pipeline does not read it. Stash the resolution to get a clean tree for a",
  "   gate and the pipeline commits an empty tree. A stash of your own, for your",
  "   own reasons, is yours to keep — the resolution is not in it.",
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
  /**
   * The wall-clock the whole sweep may spend.
   *
   * It is one budget, divided as a work run's is: the resolution, the gate and
   * the review take shares of what is left when their turn comes, and a
   * candidate that would start with nothing left is left for the next run.
   */
  readonly deadlineMs: number;
  /** Whether the target repository's pre-push hook may gate the push. */
  readonly verifyPushes?: boolean;
  /** Whether somebody has stopped the run. */
  readonly stopped?: () => boolean;
  readonly onStep?: (record: StepRecord) => void;
  readonly onStepStart?: (step: string) => void;
  /** What the model pool did during the run — the record says it. */
  readonly poolEvents?: readonly string[];
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
  // The sweep has one wall-clock, the same rule a work run follows: the
  // sessions, the gate and the review take what is left when their turn comes,
  // so a sweep can no longer outlive its budget by a gate-hour per pull request.
  const startedAt = Date.now();
  const remainingMs = (): number =>
    Math.max(0, options.deadlineMs - (Date.now() - startedAt));

  /**
   * The journal of the sweep: the lines the sweep writes, beside the
   * per-pull-request journals.
   *
   * Each pull request the sweep starts has a journal of its own, and a sweep
   * that is killed between two pull requests leaves only those behind: nothing
   * says which pull requests it considered, which it left alone, or where it
   * stopped. This file is the sweep's own account, and it is there before the
   * candidates are read, so a sweep that dies leaves behind what it was doing
   * when it died.
   *
   * The sessions the sweep opens write to it too — the factory is wrapped
   * once, the way the per-pull-request merge wraps it — so the file has the
   * shape the other journals have.
   */
  const directory = sweepJournalDirectory(options.checkout);
  const journalFile = journalPath(directory, runId);
  await mkdir(directory, { recursive: true });
  await writeFile(journalFile, `${sweepJournalHeader(runId)}\n`, "utf8");
  const write = journalWriter(journalFile);
  const sweepOptions: MergeOptions = {
    ...options,
    session: journalFactory(options.session, journalFile),
  };

  const candidates = await readOpenPullRequests(
    options.repo,
    options.baseBranch,
    options.gh,
  );

  const merged: number[] = [];
  const skipped: { pullRequest: number; reason: string }[] = [];
  const failed: { pullRequest: number; step: string; message: string }[] = [];
  /**
   * The pull requests the sweep left alone, counted for the sweep's own
   * summary.
   *
   * A pull request whose branch is not ours is left alone too, and it is not
   * a candidate the result names — so the count the summary says is the count
   * of the lines the journal holds, not the length of the result's list.
   */
  let leftAlone = 0;
  const leaveAlone = (pullRequest: number, reason: string): void => {
    leftAlone += 1;
    write(`left #${pullRequest} alone — ${reason}`);
  };

  for (const candidate of candidates) {
    if (options.stopped?.() === true) {
      write("the sweep was stopped");
      break;
    }
    const issueNumber = issueNumberFromBranch(candidate.headRefName);
    if (issueNumber === null) {
      // Another author's pull request. The pipeline lands only its own, and the
      // journal says so: the sweep read it, and a reader has to see that it was
      // left alone on purpose.
      leaveAlone(candidate.number, "its branch is not ours");
      continue;
    }
    if (remainingMs() <= 0) {
      // Asking what a pull request would need is a `gh` call of its own, and a
      // run whose clock is gone must not spend it. The candidate is left whole
      // for the next run, and the reason says whose clock it was.
      skipped.push({
        pullRequest: candidate.number,
        reason: "the run's deadline left no budget",
      });
      leaveAlone(candidate.number, "the run's deadline left no budget");
      continue;
    }
    const reason = await skipReason(options, candidate);
    if (reason !== null) {
      skipped.push({ pullRequest: candidate.number, reason });
      leaveAlone(candidate.number, reason);
      continue;
    }

    // The line before the work: a sweep that is killed while it works on a
    // pull request has to say which one it was working on.
    write(`#${candidate.number} is a candidate — the merge starts`);
    options.onSubject?.({ pullRequest: candidate.number, title: candidate.title });
    try {
      const outcome = await mergeOne(sweepOptions, candidate, issueNumber, runId, remainingMs);
      if (outcome.merged) {
        merged.push(candidate.number);
        write(`#${candidate.number} landed`);
      } else {
        skipped.push({ pullRequest: candidate.number, reason: outcome.reason });
        leaveAlone(candidate.number, outcome.reason);
      }
    } catch (failure) {
      const step = failure instanceof RunFailed ? failure.step : "merge";
      const message = errorMessage(failure);
      failed.push({
        pullRequest: candidate.number,
        step,
        message,
      });
      write(`#${candidate.number} stopped at the ${step} step — ${message}`);
    }
  }

  write(
    `the sweep ended — ${merged.length} landed, ${leftAlone} left alone, ${failed.length} stopped`,
  );

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
 *
 * Every step that spends time takes its share of what the run has left, so the
 * sweep's clock bounds all of them.
 */
async function mergeOne(
  options: MergeOptions,
  candidate: OpenPullRequest,
  issueNumber: number,
  runId: string,
  remainingMs: () => number,
): Promise<{ readonly merged: true } | { readonly merged: false; readonly reason: string }> {
  const worktreePath = join(options.worktreeRoot, `pull-request-${candidate.number}`);
  const branch = candidate.headRefName;
  const state = { before: "", after: "", changed: false };

  /**
   * The journal of the merge: the session's lines, written while it works.
   *
   * The record is written when the merge ends — and a merge that is killed
   * writes no record at all. The journal is the file beside it: it is there
   * before the first session opens and grows as the lines come, so a merge
   * that dies leaves behind what it was doing when it died.
   */
  const subject = pullRequestSubject(candidate.number);
  const directory = diagnosticsDirectory(options.checkout, subject);
  const journalFile = journalPath(directory, runId);
  await mkdir(directory, { recursive: true });
  await writeFile(journalFile, `${journalHeader(runId, subject)}\n`, "utf8");
  const factory = journalFactory(options.session, journalFile);

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
          // A merge can fail without a conflict: unrelated histories, a locked
          // index, a base commit that is not there. The agent is for a
          // conflict, and the agent's commit step stages whatever the tree
          // holds — so an agent run against a broken tree commits the
          // breakage. The index is the test: unmerged entries mean a conflict
          // is waiting to be resolved, and a check that cannot be made is not
          // a conflict either.
          const conflicted = await hasUnmergedEntries(options.git, worktreePath).catch(
            () => false,
          );
          if (!conflicted) {
            // Nothing to resolve: the merge's own error is the reason, and it
            // is the reason the step fails with.
            throw failure;
          }
          await resolveWithAgent(
            options,
            factory,
            worktreePath,
            budgetShares(remainingMs(), MERGE_GATE_COUNT).sessionMs,
          );
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
        return await verifyGate(
          options,
          factory,
          worktreePath,
          gatesLogPath(directory, runId),
          remainingMs,
        );
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
          factory,
          gh: options.gh,
          run: options.run,
          git: options.git,
          deadlineMs: budgetShares(remainingMs(), MERGE_GATE_COUNT).reviewMs,
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

  let stoppedAt: string | null = null;
  let record = "";
  try {
    const outcome = await runSteps({
      issue: candidate.number,
      runId,
      root: options.checkout,
      steps,
      directory,
      heading: `# Merge pull request ${candidate.number}`,
      subject,
      ...(options.poolEvents === undefined ? {} : { pool: options.poolEvents }),
      ...(options.onStep === undefined ? {} : { onStep: options.onStep }),
      ...(options.onStepStart === undefined ? {} : { onStepStart: options.onStepStart }),
      // The merge's steps ask the flag the work pipeline's ask: a stop that
      // arrives between two of them ends the merge at the next boundary, and
      // the step that would have run does not.
      ...(options.stopped === undefined ? {} : { stopped: options.stopped }),
      release: async () => {
        await removeWorktree(options.git, options.checkout, worktreePath);
      },
    });
    const stopped = outcome.steps.find((entry) => entry.outcome === "stopped");
    stoppedAt = stopped?.step ?? null;
    record = outcome.record;
  } finally {
    // Scratch, on both paths: the branch holds the work.
    await removeWorktree(options.git, options.checkout, worktreePath).catch(() => {
      // A worktree that could not be removed is cleaned up by the next attempt.
    });
  }

  if (stoppedAt !== null) {
    // The merge stopped before this step ran, so nothing was landed: the pull
    // request stays open, and the step it stopped at is what a reader starts
    // from.
    throw new RunFailed({
      step: stoppedAt,
      message: "the merge was stopped before this step",
      cause: new Error("stopped"),
      record,
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
 * step is recorded as failed, and the pull request stays open. The gate takes
 * the gates' share of what the run has left, and the fix takes the session's —
 * one wall-clock, the same rule a work run follows.
 */
async function verifyGate(
  options: MergeOptions,
  factory: SessionFactory,
  worktreePath: string,
  outputFile: string,
  remainingMs: () => number,
): Promise<string> {
  const startedAt = Date.now();
  const budgetMs = budgetShares(remainingMs(), MERGE_GATE_COUNT).gatesMs;
  const left = (): number => Math.max(0, budgetMs - (Date.now() - startedAt));
  const invocation = gateInvocation(GATE_SCRIPT);
  const run = async (): Promise<void> => {
    const remaining = left();
    if (remaining <= 0) {
      throw new Error("the run's deadline left no budget for the gate");
    }
    await mkdir(dirname(outputFile), { recursive: true }).catch(() => {});
    await options.run({
      command: invocation.command,
      args: [...invocation.args],
      cwd: worktreePath,
      timeoutMs: Math.min(options.gateTimeoutMs ?? GATE_TIMEOUT_MS, remaining),
      maxOutputBytes: GATE_OUTPUT_LIMIT_BYTES,
      killGroup: true,
      outputFile,
    }).catch(async (failure) => {
      const failed = await gateFailure(GATE_SCRIPT, invocation, failure, outputFile);
      if (failed.outputFile === undefined) {
        await rm(outputFile, { force: true }).catch(() => {});
      }
      throw failed;
    });
  };
  try {
    await run();
    await rm(outputFile, { force: true }).catch(() => {});
    return "passed";
  } catch (failure) {
    if (left() <= 0) {
      throw failure;
    }
    const output =
      failure instanceof CommandFailed
        ? [failure.stdout, failure.stderr].filter((part) => part.trim() !== "").join("\n")
        : String(failure);
    const prompt = [
      "A pull request branch was brought up to date with its base, and the",
      "repository's gate failed on the resulting tree. Fix it.",
      "",
      "The gate run failed with this output:",
      "",
      "```",
      output,
      "```",
      "",
      "1. Fix what the gate reports. Do not run the gate yourself.",
      "",
      "2. Leave the tree with no conflict markers. Do not commit, do not push:",
      "   the pipeline commits and pushes so the push stays under its control.",
      "",
      "   **The fix stays in the tree while this turn runs.** The pipeline keeps",
      "   the tree and commits it. A stash is not part of what the pipeline",
      "   commits.",
    ].join("\n");
    await resolveWithAgent(
      options,
      factory,
      worktreePath,
      budgetShares(remainingMs(), MERGE_GATE_COUNT).sessionMs,
      prompt,
    );
    const remaining = left();
    if (remaining <= 0) {
      throw new Error("the run's deadline left no budget for the gate");
    }
    try {
      await options.run({
        command: invocation.command,
        args: [...invocation.args],
        cwd: worktreePath,
        timeoutMs: Math.min(options.gateTimeoutMs ?? GATE_TIMEOUT_MS, remaining),
        maxOutputBytes: GATE_OUTPUT_LIMIT_BYTES,
        killGroup: true,
        outputFile,
      });
      await rm(outputFile, { force: true }).catch(() => {});
      return "passed after the agent's fix";
    } catch (failure2) {
      const failed = await gateFailure(GATE_SCRIPT, invocation, failure2, outputFile);
      if (failed.outputFile === undefined) {
        await rm(outputFile, { force: true }).catch(() => {});
      }
      throw failed;
    }
  }
}

/**
 * Let the merge agent resolve the worktree, and refuse to go on with markers.
 *
 * The agent is told not to commit; the runner commits, so the identity and the
 * push stay its own. A marker left behind is a resolution that is not one. The
 * budget it is given is the session's share of what the run has left.
 */
async function resolveWithAgent(
  options: MergeOptions,
  factory: SessionFactory,
  worktreePath: string,
  deadlineMs: number,
  prompt: string = MERGE_PROMPT,
): Promise<void> {
  const session = await factory({
    cwd: worktreePath,
    systemPromptSections: { [UNTRUSTED_INPUT_SECTION]: UNTRUSTED_INPUT_RULE },
  });
  const result = await runPromptArray({
    session,
    prompts: [prompt],
    // The resolution is one state: the conflict, resolved in one turn.
    states: [{ name: "resolve", phase: "Resolve" }],
    deadlineMs,
    ...(options.stopped === undefined ? {} : { stopped: options.stopped }),
  });
  if (result.aborted) {
    // The deadline and a human's stop are both a cut session; the record has to
    // say which one it was, the same way the work session's record does.
    throw new Error(
      cutOffMessage({
        what: "the merge session",
        deadlineMs,
        reason: result.cutReason,
        progress: { completed: result.completed, total: result.total },
      }),
    );
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
    throw new Error(`conflict marker "<<<<<<<" remains in ${marked.trim().split("\n")[0] ?? "the tree"}`);
  }

  // The resolution is the work; what the session left that the resolution
  // did not need — a note, a scratch file, a copy — is not. Only those go.
  await options.git(["clean", "-fd"], { cwd: worktreePath });
  await commitAll(options.git, worktreePath, "merge: bring the branch up to date");
}
