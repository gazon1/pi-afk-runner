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
 * | `R` | `workBranch` | does the remote branch `agent/issue-<N>` carry commits the base does not? |
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

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { claimIssue, reclaimClaim, releaseClaim } from "./claim.js";
import { errorMessage } from "./cli.js";
import { GUARD_POLICY } from "./guard.js";
import {
  UNTRUSTED_INPUT_RULE,
  UNTRUSTED_INPUT_SECTION,
  createVerdictTool,
  runPromptArray,
  startAgent,
  type ReviewVerdict,
  type Scheduler,
  type SessionFactory,
} from "./session.js";
import {
  CommandFailed,
  addWorktree,
  fetchRef,
  headRef,
  pushWorkBranch,
  readRemoteSha,
  remoteBranchAheadOfBase,
  removeWorktree,
  runCommand,
  workBranch,
  type CommandRunner,
  type GitRunner,
} from "./git.js";
import {
  CLAIM_LABEL,
  addPullRequestLabelArgs,
  createPullRequest,
  postCommentArgs,
  pullRequestBody,
  readClaimed,
  readIssue,
  readPullRequest,
  readQueue,
  reviewCommentBody,
  RECOUNT_LABEL,
  REVIEW_MARKER,
  type GhRunner,
  type IssueDetail,
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

/** The script the repository uses to prepare a worktree. */
export const SETUP_SCRIPT = "scripts/setup-worktree.sh";

export interface WorktreeOptions {
  /** The checkout the worktree is created from. */
  readonly repo: string;
  /** The remote the base comes from. */
  readonly remote: string;
  /** The branch the base is read from — `origin/main` in practice. */
  readonly baseBranch: string;
  /** The commit the claim was taken against. */
  readonly baseSha: string;
  /** The issue being worked. */
  readonly issueNumber: number;
  /** Where the worktree is created. */
  readonly worktreePath: string;
  /** The directory the git commands run in. */
  readonly cwd: string;
  readonly git: GitRunner;
  /** How the repository's own setup script is run. */
  readonly run?: CommandRunner;
}

/**
 * Create the worktree and prepare it.
 *
 * The worktree is created from the base the claim recorded — the same commit
 * the claim was taken against — on the branch the work goes on.
 *
 * Then the repository's **own** setup script runs, inside the worktree, before
 * anything else happens there. It is the repository's script and not a
 * substitute for it, because it does what a generic worktree tool cannot: the
 * `core.bare` repair, the per-worktree `core.hooksPath`, the `.env` copy and
 * the private Gradle home. The runner does not re-derive any of that; it asks
 * the repository, through `config/git-layout.sh`, which is what the setup
 * script does when it runs.
 *
 * The script is run **from the worktree's own copy**. The script works on the
 * checkout it lives in — it changes into that checkout and repairs it — so the
 * canonical checkout's copy would repair the canonical checkout, and the
 * worktree would be left unprepared.
 */
export async function prepareWorktree(
  options: WorktreeOptions,
): Promise<{ readonly path: string; readonly branch: string }> {
  const branch = workBranch(options.issueNumber);
  const run = options.run ?? runCommand;

  // The base's objects have to be here before a worktree can be made of them.
  await fetchRef(options.git, options.cwd, {
    remote: options.remote,
    ref: options.baseBranch,
  });

  // The repository's own recipe, checked **before** anything is created. A
  // repository without it cannot be worked, and discovering that afterwards
  // leaves a half-made worktree and a claim to release for nothing.
  const prepared = await options
    .git(["cat-file", "-e", `${options.baseSha}:${SETUP_SCRIPT}`], { cwd: options.cwd })
    .then(
      () => true,
      () => false,
    );
  if (!prepared) {
    throw new Error(
      `the target repository has no ${SETUP_SCRIPT} at ${options.baseSha.slice(0, 8)} — ` +
        `a worktree cannot be prepared without it`,
    );
  }

  // A worktree left behind by a run that was killed would make the next `worktree
  // add` fail on its own leftover. It is scratch: the branch holds the work.
  await removeWorktree(options.git, options.cwd, options.worktreePath);

  await addWorktree(options.git, options.cwd, {
    path: options.worktreePath,
    branch,
    baseSha: options.baseSha,
  });

  await run({
    command: "bash",
    args: [SETUP_SCRIPT],
    cwd: options.worktreePath,
  });

  return { path: options.worktreePath, branch };
}

/** The tool that computes a change's contract digest — the repository's own. */
export const DIGEST_TOOL = "scripts/check-review-verdicts.py";

/** The tool that creates a change's registry entry — the repository's own. */
export const REGISTRY_TOOL = "scripts/openspec-import-all.py";

/**
 * The digest of a change's contract documents.
 *
 * It is computed by the repository's own tool, not here: the gate recomputes
 * it with the same implementation, and two implementations of a digest would
 * drift apart in a way nobody notices until a verdict stops matching.
 */
export async function computeDocumentsDigest(
  run: CommandRunner,
  cwd: string,
  slug: string,
): Promise<string> {
  const output = await run({
    command: "python3",
    args: [DIGEST_TOOL, "--digest", slug],
    cwd,
  });
  const digest = output.trim();
  if (!digest.startsWith("sha256:")) {
    throw new Error(`the digest tool did not return a digest: ${digest}`);
  }
  return digest;
}

/**
 * Create the registry entry of a change, with the repository's own importer.
 *
 * The importer creates the records that are missing and leaves the ones that
 * exist alone, so running it is how a change gets its entry.
 */
export async function ensureRegistryEntry(
  run: CommandRunner,
  cwd: string,
): Promise<void> {
  await run({ command: "python3", args: [REGISTRY_TOOL], cwd });
}

/**
 * The verdict file of a change.
 *
 * A verdict file that exists says a review happened. It names the change, the
 * pull request whose review it records, the commit that was reviewed, and the
 * digest of the contract documents the review was made against — so a verdict
 * cannot silently go on speaking for a contract that has since changed.
 */
export function verdictFile(options: {
  readonly slug: string;
  readonly verdict: "pass" | "fail";
  readonly date: string;
  readonly pullRequest: number;
  readonly reviewed: string;
  readonly documents: string;
  readonly body?: string;
}): string {
  const frontmatter = [
    "---",
    `change: ${options.slug}`,
    `verdict: ${options.verdict}`,
    `date: ${options.date}`,
    `pr: ${options.pullRequest}`,
    `reviewed: ${options.reviewed}`,
    `documents: ${options.documents}`,
    "---",
    "",
    "",
  ].join("\n");
  const body =
    options.body ??
    [
      "## What was reviewed",
      "",
      `The change \`${options.slug}\` — its contract documents, as the digest above records them.`,
      "",
    ].join("\n");
  return `${frontmatter}${body}`;
}

/**
 * Open the pull request, or find the one that is already open.
 *
 * A pull request that already exists for the branch is **found**, not
 * duplicated: two pull requests for one issue split the review between them
 * and neither carries the other's history.
 */
export async function openPullRequest(options: {
  readonly repo: string;
  readonly branch: string;
  readonly title: string;
  readonly body: string;
  readonly base?: string;
  readonly gh: GhRunner;
  readonly run: CommandRunner;
}): Promise<{ readonly number: number; readonly created: boolean }> {
  const existing = await readPullRequest(options.repo, options.branch, options.gh);
  if (existing !== null) {
    return { number: existing.number, created: false };
  }
  const number = await createPullRequest(
    {
      repo: options.repo,
      branch: options.branch,
      title: options.title,
      body: options.body,
      ...(options.base === undefined ? {} : { base: options.base }),
    },
    options.gh,
  );
  return { number, created: true };
}

/** The tool that reads a commit's CI verdict — the repository's own. */
export const CI_VERDICT_TOOL = "scripts/ci-verdict.py";

/**
 * The CI line out of the tool's own JSON, or null.
 *
 * The tool prints `{"workflow":…, "verdict":…, "exit":…}` on every path that
 * reached a verdict, and a plain sentence on the one path that could not read
 * the runs at all. So the JSON either parses or it does not — there is no third
 * shape to guess at.
 */
export function parseCiVerdict(json: string): string | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const verdict = (parsed as Record<string, unknown>).verdict;
    if (typeof verdict !== "string") {
      return null;
    }
    const line = verdict.trim();
    return line === "" ? null : line;
  } catch {
    return null;
  }
}

/** What the CI tool concluded, and whether it was a success. */
export interface CiOutcome {
  /** The workflow, run and conclusion, as the tool states them. */
  readonly verdict: string;
  /** Whether the tool's own exit code was zero. */
  readonly success: boolean;
}

/**
 * The tool's conclusion and its exit code, out of its JSON.
 *
 * The verdict line alone cannot say whether CI succeeded — a failure and a
 * success are both lines — so the merge gate needs the exit the tool states.
 * The tool writes `exit` on every path that reached a verdict.
 */
export function parseCiOutcome(json: string): CiOutcome | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const verdict = record.verdict;
    const exit = record.exit;
    if (typeof verdict !== "string" || typeof exit !== "number") {
      return null;
    }
    const line = verdict.trim();
    return line === "" ? null : { verdict: line, success: exit === 0 };
  } catch {
    return null;
  }
}

/**
 * The CI outcome of a commit, as the repository's own tool states it.
 *
 * The same read as {@link readCiVerdict}, but the answer keeps the exit code,
 * because the merge gate has to tell a green CI from a red one.
 */
export async function readCiOutcome(
  run: CommandRunner,
  cwd: string,
  options: { readonly ref: string; readonly repo: string },
): Promise<CiOutcome | null> {
  const spec = {
    command: "python3",
    args: [CI_VERDICT_TOOL, options.ref, "--repo", options.repo, "--json"],
    cwd,
  };
  try {
    return parseCiOutcome(await run(spec));
  } catch (failure) {
    if (failure instanceof CommandFailed) {
      // The verdict it printed before it exited is on the error.
      return parseCiOutcome(failure.stdout);
    }
    return null;
  }
}

/**
 * The CI verdict of a commit, as the repository's own tool states it.
 *
 * A claim about CI that names a run id and nothing else is not evidence: a
 * repository has several workflows, and the one that says "success" may be the
 * cache cleanup. So the claim is a whole line — the workflow, the run, the
 * conclusion — and it comes from the tool that already knows how to judge it.
 *
 * **The tool's exit code is its verdict**: 0 when the CI succeeded, 1 when it
 * did not, 2 when there is no run, 3 when the runs could not be read. It
 * prints the line and *then* exits with that conclusion — so a red CI is a
 * non-zero exit, and the output that carries the answer travels on the error.
 * Reading only the success path would report a red CI as no CI at all, which
 * is the one case a reader is looking for.
 *
 * `null` when the tool could not read it. A missing run is not a pass.
 */
export async function readCiVerdict(
  run: CommandRunner,
  cwd: string,
  options: { readonly ref: string; readonly repo: string },
): Promise<string | null> {
  const spec = {
    command: "python3",
    args: [CI_VERDICT_TOOL, options.ref, "--repo", options.repo, "--json"],
    cwd,
  };
  try {
    return parseCiVerdict(await run(spec));
  } catch (failure) {
    if (failure instanceof CommandFailed) {
      // The verdict it printed before it exited is on the error.
      return parseCiVerdict(failure.stdout);
    }
    // The tool could not be run at all; the runner says nothing rather than
    // something it cannot stand behind.
    return null;
  }
}

/** How the CI line says which run it is. */
const CI_BEFORE_RECOUNT = "the CI before the re-count";

/** What a review of a pull request did. */
export interface ReviewOutcome {
  readonly verdict: "pass" | "fail";
  readonly comment: string;
  /** The CI line, when the runner read one. */
  readonly ciVerdict: string | null;
}

/**
 * Review a pull request, post the review, and have the gate count it again.
 *
 * The order matters and is asserted by the test: the comment goes first, and
 * then the label. A label applied before the comment re-counts a run that
 * finds no review — the gate would look, find nothing, and fail for a reason
 * that has nothing to do with the review.
 *
 * The CI is read **before** the label, because the label starts a new run on
 * the same commit, and the line the runner reports has to be the run that
 * judged the commit — not the one the re-count has just started. The line says
 * so, so that a reader who compares it with the pull request's current run
 * does not conclude that the runner is wrong.
 *
 * A `fail` verdict is not a retry. The pull request stays red, no second
 * comment is posted, and no other issue is taken: the findings have to be
 * dealt with, and a later review has to say `pass` again.
 */
export async function reviewPullRequest(options: {
  readonly repo: string;
  readonly pullRequest: number;
  /** The directory the reviewer works in — the worktree, read-only by convention. */
  readonly cwd: string;
  /** The reviewer's session. */
  readonly factory: SessionFactory;
  readonly gh: GhRunner;
  readonly run: CommandRunner;
  readonly deadlineMs: number;
  /** Whether somebody has stopped the run. */
  readonly stopped?: () => boolean;
  readonly schedule?: Scheduler;
}): Promise<ReviewOutcome> {
  const holder: { value?: ReviewVerdict } = {};
  const session = await options.factory({
    cwd: options.cwd,
    systemPromptSections: {
      [UNTRUSTED_INPUT_SECTION]: UNTRUSTED_INPUT_RULE,
    },
    tools: [createVerdictTool(holder)],
  });

  // The session belongs to `runPromptArray` once it is given one: it disposes
  // of it when the run is over. A second owner would make the session's life
  // the business of two places that do not agree on who is responsible.
  const result = await runPromptArray({
    session,
    prompts: [REVIEW_PROMPT],
    deadlineMs: options.deadlineMs,
    ...(options.stopped === undefined ? {} : { stopped: options.stopped }),
    ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
  });
  if (result.aborted) {
    // The same cut the work session reports; a review that did not finish is
    // not a review that stated no verdict.
    throw new Error("the review's session was cut off before its last turn");
  }

  const verdict = holder.value;
  if (verdict === undefined) {
    // The reviewer did not reach a verdict. That is not a pass: a review that
    // says nothing decides nothing.
    throw new Error(
      `the review of pull request ${options.pullRequest} stated no verdict`,
    );
  }

  const comment = reviewCommentBody({
    verdict: verdict.verdict,
    findings: verdict.findings,
  });

  // Posted once. The gate decides on the newest marked comment, so a second
  // review of the same pull request would override this one — and a `pass`
  // after a `fail` would turn a red pull request green on a review of a
  // different diff.
  await postReviewComment(options, comment);

  // Read before the label: the label starts the re-count, and the run it
  // starts is not the run that judged this commit.
  const ciLine = await readCiVerdict(options.run, options.cwd, {
    ref: String(options.pullRequest),
    repo: options.repo,
  });

  await addRecountLabel(options);

  return {
    verdict: verdict.verdict,
    comment,
    ciVerdict: ciLine === null ? null : `${CI_BEFORE_RECOUNT}: ${ciLine}`,
  };
}

/** The prompt the reviewer is given. */
export const REVIEW_PROMPT = [
  "Review the pull request in this repository, as a reader who did not write it.",
  "",
  "Read the diff (`git diff origin/main...HEAD`), the code it touches, and the tests. Judge it",
  "the way the repository's own review skill does: is the logic right, is it safe, does it hold",
  "under load, is the risky code tested, is it fast enough, and is every line needed.",
  "",
  "Report defects with a location, not a summary. Say what you did not reach.",
  "",
  "Then end with the verdict tool. It is your last action.",
].join("\n");

/** Post the review comment. */
export async function postReviewComment(
  options: {
    readonly repo: string;
    readonly pullRequest: number;
    readonly gh: GhRunner;
  },
  comment: string,
): Promise<void> {
  await options.gh(postCommentArgs(options.repo, options.pullRequest, comment));
}

/**
 * Apply the label that makes the gate count the review again. */
export async function addRecountLabel(options: {
  readonly repo: string;
  readonly pullRequest: number;
  readonly gh: GhRunner;
}): Promise<void> {
  await options.gh(
    addPullRequestLabelArgs(options.repo, options.pullRequest, RECOUNT_LABEL),
  );
}

/**
 * What the runner can see about one issue.
 *
 * The state is derived, not remembered: the six observables come from GitHub
 * and from git, so a run that starts on a machine where a previous run died
 * sees the same world that run saw.
 */
export interface IssueObservation {
  readonly issue: IssueSummary;
  /** The state the issue is in. */
  readonly state: DerivedState;
  /** The pull request behind it, when there is one. */
  readonly pullRequest: PullRequestSummary | null;
}

/**
 * Observe one issue: what state is it in, and what is behind it.
 *
 * The pull request is read from GitHub, the work the branch carries from the
 * remote (a branch that points at the base carries none), and the staleness from
 * the issue's last update — which any comment moves.
 */
export async function observeIssue(options: {
  readonly issue: IssueSummary;
  readonly repo: string;
  readonly remote: string;
  readonly baseBranch: string;
  readonly cwd: string;
  readonly git: GitRunner;
  readonly gh: GhRunner;
  readonly now: Date;
  readonly staleAfterMs: number;
}): Promise<IssueObservation> {
  const branch = workBranch(options.issue.number);
  const pullRequest = await readPullRequest(options.repo, branch, options.gh);
  const ahead = await remoteBranchAheadOfBase(options.git, options.cwd, {
    remote: options.remote,
    branch,
    base: options.baseBranch,
  });
  const observed = observePullRequest(pullRequest);
  return {
    issue: options.issue,
    pullRequest,
    state: deriveState({
      claimLabel: options.issue.labels.includes(CLAIM_LABEL),
      pullRequest: pullRequest !== null,
      reviewComment: observed.reviewComment,
      recountLabel: observed.recountLabel,
      workBranch: ahead !== null && ahead > 0,
      stale: isStale(options.issue.updatedAt, options.now, options.staleAfterMs),
    }),
  };
}

/** What a run has to do about an issue. */
export type PlanKind =
  /** Claim it, work it, open a pull request, review it. */
  | "work"
  /** A dead run's claim: take it over and do the work again. */
  | "reclaim"
  /** The work is pushed; open the pull request. */
  | "pull request"
  /** The pull request is open; review it. */
  | "review"
  /** The review is posted; count it. */
  | "re-count"
  /** Somebody else's work, or nothing to do. */
  | "none";

/** What a run has to do about one issue. */
export interface Plan {
  readonly kind: PlanKind;
  readonly issue: IssueSummary;
  /** The full issue, when it was already read (named issue). */
  readonly issueDetail?: IssueDetail;
  /** The pull request behind it, when there is one. */
  readonly pullRequest: PullRequestSummary | null;
}

/**
 * What the run has to do, given what the runner can see.
 *
 * A claim that is still fresh is somebody else's work — the runner that took
 * it may be working right now — and it is left alone. A claim that is stale
 * and has nothing behind it is a dead run's, and it is taken over. A claim
 * with a pull request behind it is finished where it stopped: the pull request
 * is opened, reviewed or counted, and never worked a second time.
 */
export function planFor(observation: IssueObservation): Plan {
  const kind: PlanKind =
    observation.state === "Queue"
      ? "work"
      : observation.state === "Orphaned"
        ? "reclaim"
        : observation.state === "Pushed"
          ? "pull request"
          : observation.state === "Opened"
            ? "review"
            : observation.state === "Reviewed"
              ? "re-count"
              : "none";
  return {
    kind,
    issue: observation.issue,
    pullRequest: observation.pullRequest,
  };
}

/** What one step of a run did. */
export interface StepRecord {
  readonly step: string;
  readonly outcome: "ok" | "failed";
  /** The first line the step printed — enough to tell two failures apart. */
  readonly detail: string;
}

/** One step of a run. */
export interface Step {
  readonly name: string;
  readonly run: () => Promise<string>;
}

/** What a run did. */
export interface RunOutcome {
  readonly issue: number;
  readonly runId: string;
  readonly outcome: "completed" | "failed";
  readonly steps: readonly StepRecord[];
  /** Where the record was written. */
  readonly record: string;
}

/** The first line of what a step printed. */
function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    if (line.trim() !== "") {
      return line.trim();
    }
  }
  return "";
}

/**
 * Take the credentials out of what goes into the record.
 *
 * The record holds what the steps printed, and a step that failed may have
 * printed a command line with a token in it. The record is read by a human and
 * is not a secret store, so a token-shaped string is replaced rather than
 * written down.
 */
function redact(text: string): string {
  return text
    .replace(/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}\b/g, "gh_…")
    .replace(/\b(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN)=(\S+)/g, "$1=…");
}

/**
 * The identifier that tells two runs of the same issue apart.
 *
 * The issue number alone is not enough: the same issue can be reclaimed and
 * worked twice, and the two runs are two records.
 */
export function newRunId(now: Date = new Date()): string {
  return `${now.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

/**
 * Where the record of a run lives.
 *
 * `build/diagnostics/issue-<N>/` — the repository's own convention for "here is
 * what happened", with the issue's number in the directory's name.
 */
export function recordDirectory(root: string, issue: number): string {
  return join(root, "build", "diagnostics", `issue-${issue}`);
}

/** The record's own text. */
function renderRecord(options: {
  readonly issue: number;
  readonly runId: string;
  readonly outcome: "completed" | "failed";
  readonly steps: readonly StepRecord[];
  /** The record's first line, when it is not an issue's. */
  readonly heading?: string;
  /** What the number names — `issue` by default, `pull request` for a merge. */
  readonly subject?: string;
}): string {
  const lines = [
    options.heading ?? `# Run issue-${options.issue}`,
    "",
    `- ${options.subject ?? "issue"}: ${options.issue}`,
    `- run: ${options.runId}`,
    `- outcome: ${options.outcome}`,
    "",
    "## Steps",
    "",
  ];
  for (const step of options.steps) {
    const detail = step.detail === "" ? "" : ` — ${step.detail}`;
    lines.push(`- ${step.step} — ${step.outcome}${detail}`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Write the record of a run.
 *
 * The record names the issue, the steps the run took and what came of each, so
 * a reader can reconstruct the run's timeline without the runner's process.
 */
export async function writeRunRecord(options: {
  readonly root: string;
  readonly issue: number;
  readonly runId: string;
  readonly outcome: "completed" | "failed";
  readonly steps: readonly StepRecord[];
  /** Where the record goes, when it is not under the issue's own directory. */
  readonly directory?: string;
  readonly heading?: string;
  readonly subject?: string;
}): Promise<string> {
  const directory = options.directory ?? recordDirectory(options.root, options.issue);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${options.runId}.md`);
  await writeFile(
    path,
    renderRecord({
      issue: options.issue,
      runId: options.runId,
      outcome: options.outcome,
      steps: options.steps,
      ...(options.heading === undefined ? {} : { heading: options.heading }),
      ...(options.subject === undefined ? {} : { subject: options.subject }),
    }),
    "utf8",
  );
  return path;
}

/**
 * Release everything the run took.
 *
 * The worktree goes first: it is the one that can fail, and a release that
 * stops half-way leaves the issue claimed — which the next run finds and takes
 * over. The other order leaves the issue looking free while the work is still
 * on the machine.
 *
 * The branch is not the worktree: removing the worktree leaves the branch and
 * its commits alone, so the work a failed run did is durable.
 */
export async function releaseRun(options: {
  readonly repo: string;
  readonly remote: string;
  readonly cwd: string;
  readonly issueNumber: number;
  /** The worktree, when the run created one. */
  readonly worktreePath?: string;
  readonly git: GitRunner;
  readonly gh: GhRunner;
}): Promise<void> {
  if (options.worktreePath !== undefined) {
    await removeWorktree(options.git, options.cwd, options.worktreePath);
  }
  await releaseClaim({
    repo: options.repo,
    remote: options.remote,
    cwd: options.cwd,
    issueNumber: options.issueNumber,
    git: options.git,
    gh: options.gh,
  });
}

/**
 * Run the steps in order, and release the claim when one of them fails.
 *
 * The record is written **whatever** happens: a run that died is exactly the
 * run a human has to read about, and a record written only on success is
 * missing precisely when it is needed.
 *
 * A failure is thrown rather than returned. A caller that ignored a returned
 * failure would exit zero having done nothing, and "looked healthy while
 * selecting nothing" is the one outcome this runner must never have.
 *
 * A stopped run ends at the **step boundary**: the flag is asked before every
 * step, and the step that would have run does not. The stop is a failure like
 * any other, so the claim is released and the record is written.
 */
export async function runSteps(options: {
  readonly issue: number;
  readonly runId: string;
  /** The checkout the record goes under. */
  readonly root: string;
  readonly steps: readonly Step[];
  /** Where the record goes, when it is not under the issue's own directory. */
  readonly directory?: string;
  readonly heading?: string;
  readonly subject?: string;
  /** What a failure releases: the claim, the worktree, the ref. */
  readonly release?: () => Promise<void>;
  /** Told about every step, as it finishes. */
  readonly onStep?: (record: StepRecord) => void;
  /** Told about a step as it starts. */
  readonly onStepStart?: (step: string) => void;
  /**
   * Whether somebody has stopped the run.
   *
   * Asked before every step. A stop that only reached the agent would let the
   * run carry on to its push and its pull request; this is what ends it at the
   * next boundary.
   */
  readonly stopped?: () => boolean;
}): Promise<RunOutcome> {
  const steps: StepRecord[] = [];
  let failure: { readonly step: string; readonly error: Error } | null = null;

  for (const step of options.steps) {
    if (options.stopped?.() === true) {
      // The human stopped the run between two steps: it ends here, and the
      // release below does what a failed run's does.
      const halted: StepRecord = {
        step: step.name,
        outcome: "failed",
        detail: "the run was stopped before this step",
      };
      steps.push(halted);
      options.onStep?.(halted);
      failure = { step: step.name, error: new Error("the run was stopped") };
      break;
    }
    let record: StepRecord;
    try {
      options.onStepStart?.(step.name);
      const output = await step.run();
      record = { step: step.name, outcome: "ok", detail: redact(firstLine(output)) };
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      record = {
        step: step.name,
        outcome: "failed",
        detail: redact(firstLine(cause.message)),
      };
      steps.push(record);
      options.onStep?.(record);
      failure = { step: step.name, error: cause };
      break;
    }
    steps.push(record);
    options.onStep?.(record);
  }

  // The claim goes, even though the run failed: a claim nobody is working is
  // an issue nobody can take.
  if (failure !== null && options.release !== undefined) {
    try {
      await options.release();
      steps.push({ step: "release", outcome: "ok", detail: "" });
    } catch (releaseError) {
      steps.push({
        step: "release",
        outcome: "failed",
        detail: redact(firstLine(errorMessage(releaseError))),
      });
    }
  }

  const outcome = failure === null ? "completed" : "failed";
  let record: string;
  try {
    record = await writeRunRecord({
      root: options.root,
      issue: options.issue,
      runId: options.runId,
      outcome,
      steps,
      ...(options.directory === undefined ? {} : { directory: options.directory }),
      ...(options.heading === undefined ? {} : { heading: options.heading }),
      ...(options.subject === undefined ? {} : { subject: options.subject }),
    });
  } catch (recordError) {
    if (failure === null) {
      throw recordError;
    }
    throw new Error(
      `the run stopped at the ${failure.step} step: ${failure.error.message} — ` +
        `and the record could not be written: ${errorMessage(recordError)}`,
      { cause: failure.error },
    );
  }

  if (failure === null) {
    return {
      issue: options.issue,
      runId: options.runId,
      outcome,
      steps,
      record,
    };
  }

  throw new RunFailed({
    step: failure.step,
    message:
      `the run stopped at the ${failure.step} step: ${failure.error.message} — ` +
      `the record is at ${record}`,
    cause: failure.error,
    record,
  });
}

/** A run that stopped at a step. */
export class RunFailed extends Error {
  /** The step the run stopped at. */
  readonly step: string;
  /** Where the record of the run was written. */
  readonly record: string;

  constructor(options: {
    readonly step: string;
    readonly message: string;
    readonly cause: unknown;
    readonly record: string;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "RunFailed";
    this.step = options.step;
    this.record = options.record;
  }
}

/** What a run needs to know to do its work. */
export interface RunOptions {
  /** The repository the issue lives in — `owner/name`. */
  readonly repo: string;
  /** The issue to work. The queue's first eligible one when it is absent. */
  readonly issueNumber?: number;
  /** The checkout the worktree is made from. */
  readonly checkout: string;
  /** The remote the base comes from. */
  readonly remote: string;
  /** The branch the base is read from. */
  readonly baseBranch: string;
  /** Where the worktrees are created. */
  readonly worktreeRoot: string;
  readonly git: GitRunner;
  readonly gh: GhRunner;
  readonly run: CommandRunner;
  /** The session the agent works in. */
  readonly session: SessionFactory;
  /** The wall-clock ceiling on one turn of the agent. */
  readonly deadlineMs: number;
  /**
   * How long a claim may sit before another run may take it over.
   *
   * A week, in practice: long enough that a slow run keeps its issue, short
   * enough that a killed run does not hold it for ever.
   */
  readonly staleAfterMs: number;
  /**
   * Whether the target repository's pre-push hook may gate the pushes.
   *
   * The hook is the repository's rule. Skipping it is a decision about the
   * repository's state — its gate is red for a reason that has nothing to do
   * with this change — and it is therefore explicit.
   */
  readonly verifyPushes?: boolean;
  /** Told about every step, as it finishes. */
  readonly onStep?: (record: StepRecord) => void;
  /** Told about a step as it starts, so a watcher can name the stage it is watching. */
  readonly onStepStart?: (step: string) => void;
  /**
   * Whether a human has stopped the run.
   *
   * Asked before every turn of the agent and before every step of the run. An
   * abort cuts the turn that is running; this is what keeps the array from
   * sending the next one, and the run from taking the next step — a stop that
   * only cut a turn would let the run carry on to its push.
   */
  readonly stopped?: () => boolean;
  /**
   * Told which issue the run took, before its first step.
   *
   * The issue is chosen inside the run — from the queue, or by number — and a
   * watcher that has to look it up is a watcher that can be watching the wrong
   * issue.
   */
  readonly onIssue?: (issue: { readonly number: number; readonly title: string }) => void;
  readonly now?: Date;
  readonly nonce?: string;
  readonly runId?: string;
}

/** What a run did. */
export interface RunResult {
  /** The issue the run worked, or null when it worked none. */
  readonly issue: number | null;
  readonly outcome: "completed" | "empty" | "unworkable";
  readonly steps: readonly StepRecord[];
  /** Where the record was written. */
  readonly record: string;
  /** The derived state that made a named issue unworkable. */
  readonly derivedState?: DerivedState;
}

/** The commit the worktree is at. */
export async function headSha(git: GitRunner, cwd: string): Promise<string> {
  return (await git(["rev-parse", "HEAD"], { cwd })).trim();
}

/** Match a path against the guard's glob, where `*` matches anything. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** Whether a path is in the protected set (last matching entry wins). */
function isProtectedPath(path: string): boolean {
  const entries = Object.entries(GUARD_POLICY.path);
  let verdict: string | undefined;
  for (const [pattern, value] of entries) {
    if (globToRegExp(pattern).test(path)) {
      verdict = value;
    }
  }
  return verdict === "deny";
}

/**
 * Commit what the runner itself wrote.
 *
 * The identity is passed on the command line: the repository the runner works
 * in is not the runner's own, and a commit with no author is not a commit.
 */
export async function commitAll(
  git: GitRunner,
  cwd: string,
  message: string,
): Promise<void> {
  await git(["add", "-A"], { cwd });
  const staged = await git(["diff", "--cached", "--name-only"], { cwd });
  for (const raw of staged.split("\n")) {
    const path = raw.trim();
    if (path === "") continue;
    if (isProtectedPath(path)) {
      throw new Error(`refusing to commit protected file: ${path}`);
    }
  }
  const status = await git(["status", "--porcelain"], { cwd });
  if (status.trim() === "") {
    return;
  }
  await git(
    [
      "-c",
      "user.name=afk-runner",
      "-c",
      "user.email=afk-runner@localhost",
      "commit",
      "-q",
      "-m",
      message,
    ],
    { cwd },
  );
}

/**
 * The change the work landed, if it landed one.
 *
 * A change is a directory under `openspec/changes/`, and its name is the
 * change's slug — the same name its registry entry and its verdict file carry.
 */
export async function changedChangeSlug(
  git: GitRunner,
  cwd: string,
  options: { readonly base: string; readonly head: string },
): Promise<string | null> {
  const changed = await git(
    ["diff", "--name-only", `${options.base}...${options.head}`],
    { cwd },
  );
  for (const line of changed.split("\n")) {
    const match = /^openspec\/changes\/([^/]+)\//.exec(line.trim());
    if (match !== null) {
      return match[1] ?? null;
    }
  }
  return null;
}

/**
 * The run: the steps, in the order they happen.
 *
 * One invocation works **one** issue. The queue is read first, because the
 * record is written under the issue's number and the number is what the
 * selection yields — and because an empty queue is not a run: there is nothing
 * to record and nothing to release.
 *
 * The steps are: claim → worktree → session → push → pull request → review →
 * re-count. The re-count is the label that re-triggers the pull request's CI,
 * and it is applied by the review step, because the order between the comment
 * and the label is fixed there; the re-count step writes the change's verdict
 * file, which is the record that re-count is counted against.
 */
export async function runOnce(options: RunOptions): Promise<RunResult> {
  const now = options.now ?? new Date();
  const runId = options.runId ?? newRunId(now);

  // The claimed issues come first. A claim is a run that is either working or
  // dead, and a dead one holds its issue out of the queue for ever — so a
  // queue that is never empty would starve it.
  const planOrUnworkable = await chooseIssue(options, now);
  if (planOrUnworkable === null) {
    if (options.issueNumber !== undefined) {
      return {
        issue: options.issueNumber,
        outcome: "unworkable",
        steps: [],
        record: "",
      } as RunResult;
    }
    return { issue: null, outcome: "empty", steps: [], record: "" };
  }
  if ((planOrUnworkable as any).unworkable === true) {
    const unworkable = planOrUnworkable as { readonly unworkable: true; readonly derivedState: DerivedState };
    return {
      issue: options.issueNumber ?? null,
      outcome: "unworkable",
      steps: [],
      record: "",
      derivedState: unworkable.derivedState,
    };
  }
  const plan = planOrUnworkable as Plan;
  return await runPlan(options, plan, now, runId);
}

/**
 * The issue this run works, and what it has to do about it.
 *
 * The claimed issues are looked at before the queue, because a claim that is
 * stale is a dead run's and it is the only thing that will ever take that
 * issue over. A claim that is still fresh belongs to a run that may be
 * working right now, and it is left alone.
 */
async function chooseIssue(
  options: RunOptions,
  now: Date,
): Promise<Plan | { readonly unworkable: true; readonly derivedState: DerivedState } | null> {
  let namedDetail: IssueDetail | undefined;
  let candidates: IssueSummary[];
  try {
    if (options.issueNumber !== undefined) {
      // The operator named the issue. It is taken as given: the claim is what
      // excludes another runner, and a claim that fails fails loudly.
      const named = await readIssue(options.repo, options.issueNumber, options.gh);
      if (named.state !== "OPEN") {
        throw new Error(`it is ${named.state}, not OPEN`);
      }
      namedDetail = named;
      candidates = [
        {
          number: options.issueNumber,
          title: named.title,
          updatedAt: named.updatedAt,
          labels: named.labels,
        },
      ];
    } else {
      candidates = await readClaimed(options.repo, options.gh);
    }
  } catch (failure) {
    const reason = failure instanceof Error ? failure.message : String(failure);
    throw new RunFailed({
      step: "select",
      // A named issue is one of many a sweep works, so its failure names the
      // issue and not the step: a sweep that skipped three issues is not
      // three runs that stopped. The queue path has no issue to name.
      message:
        options.issueNumber !== undefined
          ? `issue ${options.issueNumber} could not be selected: ${reason}`
          : `the run stopped at the select step: ${reason}`,
      cause: failure,
      record: "",
    });
  }

  let namedUnworkableState: DerivedState | undefined;
  for (const candidate of candidates) {
    const observation = await observeIssue({
      issue: candidate,
      repo: options.repo,
      remote: options.remote,
      baseBranch: options.baseBranch,
      cwd: options.checkout,
      git: options.git,
      gh: options.gh,
      now,
      staleAfterMs: options.staleAfterMs,
    });
    const plan = planFor(observation);
    if (plan.kind !== "none") {
      return namedDetail === undefined ? plan : { ...plan, issueDetail: namedDetail };
    }
    if (options.issueNumber !== undefined) {
      namedUnworkableState = observation.state;
    }
  }

  if (options.issueNumber !== undefined) {
    if (namedUnworkableState !== undefined) {
      return { unworkable: true, derivedState: namedUnworkableState };
    }
    return null;
  }

  // Nothing to resume: the queue.
  let queue: readonly IssueSummary[];
  try {
    queue = await readQueue(options.repo, options.gh);
  } catch (failure) {
    throw new RunFailed({
      step: "select",
      message: `the run stopped at the select step: ${
        failure instanceof Error ? failure.message : String(failure)
      }`,
      cause: failure,
      record: "",
    });
  }
  const issue = selectIssue(queue);
  if (issue === undefined) {
    return null;
  }
  return { kind: "work", issue, pullRequest: null };
}

/**
 * Put a worktree on a branch that is already on the remote, and prepare it.
 *
 * Detached, at the pushed commit: the branch is checked out nowhere, and a
 * worktree that checked it out would leave it checked out — and the next run
 * could not check it out again. The repository's own setup script runs before
 * anything else does, the same as in a fresh worktree.
 *
 * The merge pipeline uses this too: it reads a pull request's branch the same
 * way the review does.
 */
export async function checkoutPullRequestBranch(options: {
  readonly checkout: string;
  readonly remote: string;
  readonly branch: string;
  readonly worktreePath: string;
  readonly git: GitRunner;
  readonly run: CommandRunner;
}): Promise<string> {
  await fetchRef(options.git, options.checkout, {
    remote: options.remote,
    ref: options.branch,
  });
  const sha = await readRemoteSha(options.git, options.checkout, {
    remote: options.remote,
    ref: headRef(options.branch),
  });
  if (sha === null) {
    throw new Error(`the branch ${options.branch} is not on ${options.remote}`);
  }
  await removeWorktree(options.git, options.checkout, options.worktreePath);
  await options.git(["worktree", "add", "--detach", options.worktreePath, sha], {
    cwd: options.checkout,
  });
  await options.run({
    command: "bash",
    args: [SETUP_SCRIPT],
    cwd: options.worktreePath,
  });
  return sha;
}

async function prepareExistingWorktree(
  options: RunOptions,
  worktreePath: string,
  issueNumber: number,
): Promise<void> {
  await checkoutPullRequestBranch({
    checkout: options.checkout,
    remote: options.remote,
    branch: workBranch(issueNumber),
    worktreePath,
    git: options.git,
    run: options.run,
  });
}

/** The steps of one run, and the work they do. */
async function runPlan(
  options: RunOptions,
  plan: Plan,
  now: Date,
  runId: string,
): Promise<RunResult> {
  const issue = plan.issue;
  options.onIssue?.(issue);
  const state = {
    claimed: false,
    base: "",
    worktreePath: "",
    pullRequest: plan.pullRequest?.number ?? 0,
    reviewedSha: "",
    slug: null as string | null,
    verdict: "pass" as "pass" | "fail",
  };

  const works = plan.kind === "work" || plan.kind === "reclaim";
  let reviews = works || plan.kind === "pull request" || plan.kind === "review";
  let workSessionStartedAt: number | undefined;

  const steps: Step[] = [];

  if (works) {
    steps.push({
      name: "claim",
      run: async () => {
        const claim = {
          issue,
          repo: options.repo,
          remote: options.remote,
          baseBranch: options.baseBranch,
          cwd: options.checkout,
          git: options.git,
          gh: options.gh,
          nonce: options.nonce ?? randomUUID(),
          now,
        };
        const outcome =
          plan.kind === "reclaim"
            ? await reclaimClaim({ ...claim, worktreeRoot: options.worktreeRoot })
            : await claimIssue(claim);
        if (!outcome.claimed) {
          throw new Error(outcome.reason);
        }
        state.claimed = true;
        state.base = outcome.base;
        return `claimed from ${outcome.base.slice(0, 8)}`;
      },
    });
    steps.push({
      name: "worktree",
      run: async () => {
        state.worktreePath = join(options.worktreeRoot, `issue-${issue.number}`);
        const prepared = await prepareWorktree({
          repo: options.checkout,
          remote: options.remote,
          baseBranch: options.baseBranch,
          baseSha: state.base,
          issueNumber: issue.number,
          worktreePath: state.worktreePath,
          cwd: options.checkout,
          git: options.git,
        });
        return prepared.path;
      },
    });
    steps.push({
      name: "session",
      run: async () => {
        workSessionStartedAt = Date.now();
        const result = await startAgent({
          factory: options.session,
          cwd: state.worktreePath,
          repo: options.repo,
          issueNumber: issue.number,
          ...(plan.issueDetail === undefined ? {} : { issue: plan.issueDetail }),
          gh: options.gh,
          deadlineMs: options.deadlineMs,
          ...(options.stopped === undefined ? {} : { stopped: options.stopped }),
        });
        const workElapsedMs = workSessionStartedAt === undefined ? 0 : Date.now() - workSessionStartedAt;
        if (workElapsedMs >= options.deadlineMs) {
          reviews = false;
        }
        if (result.aborted) {
          // The deadline is one reason a turn is cut; a human stopping the run is
          // another, and the message must not claim a clock it cannot see.
          throw new Error("the agent's session was cut off before its last turn");
        }
        // The prompt asks the agent to commit, and an agent does not always do it.
        // What it left in the worktree is still the work — and the worktree is
        // about to be removed — so the runner commits it on the agent's behalf.
        // A clean worktree makes this a no-op.
        await commitAll(options.git, state.worktreePath, "the agent's work");
        const count = (await options.git(["rev-list", "--count", `${state.base}..HEAD`], { cwd: state.worktreePath })).trim();
        if (count === "0") {
          throw new Error("the agent made no commits — no changes to push or open a pull request");
        }
        return `${result.completed} turns`;
      },
    });
    steps.push({
      name: "push",
      run: async () => {
        // A change the work landed needs its registry entry, and the entry
        // belongs to the pull request.
        state.slug = await changedChangeSlug(options.git, state.worktreePath, {
          base: state.base,
          head: await headSha(options.git, state.worktreePath),
        });
        if (state.slug !== null) {
          await ensureRegistryEntry(options.run, state.worktreePath);
          await commitAll(
            options.git,
            state.worktreePath,
            "chore: the change's registry entry",
          );
        }
        const sha = await headSha(options.git, state.worktreePath);
        await pushWorkBranch(options.git, state.worktreePath, {
          remote: options.remote,
          issueNumber: issue.number,
          sha,
          ...(options.verifyPushes === undefined ? {} : { verify: options.verifyPushes }),
        });
        return sha.slice(0, 8);
      },
    });
  } else {
    // The work is already pushed. The worktree is where that work is read —
    // the reviewer needs the code, and the branch is not pushed again.
    state.worktreePath = join(options.worktreeRoot, `issue-${issue.number}`);
    await prepareExistingWorktree(options, state.worktreePath, issue.number);
  }

  if (works || plan.kind === "pull request") {
    steps.push({
      name: "pull request",
      run: async () => {
        const opened = await openPullRequest({
          repo: options.repo,
          branch: workBranch(issue.number),
          title: issue.title,
          body: pullRequestBody({
            issueNumber: issue.number,
            title: issue.title,
          }),
          // The base the run worked from, not gh's default: the worktree, the
          // claim and the state observation all used this one, and a pull
          // request against another branch would be judged by a different
          // history than the one that was worked.
          base: options.baseBranch,
          gh: options.gh,
          run: options.run,
        });
        state.pullRequest = opened.number;
        return `#${opened.number}`;
      },
    });
  }

  if (reviews) {
    steps.push({
      name: "review",
      run: async () => {
        if (!reviews) {
          return "skipped";
        }
        let reviewDeadlineMs = options.deadlineMs;
        if (workSessionStartedAt !== undefined) {
          const elapsed = Date.now() - workSessionStartedAt;
          reviewDeadlineMs = options.deadlineMs - elapsed;
          if (reviewDeadlineMs <= 0) {
            reviews = false;
            return "skipped";
          }
        }
        state.reviewedSha = await headSha(options.git, state.worktreePath);
        const outcome = await reviewPullRequest({
          repo: options.repo,
          pullRequest: state.pullRequest,
          cwd: state.worktreePath,
          factory: options.session,
          gh: options.gh,
          run: options.run,
          deadlineMs: reviewDeadlineMs,
          ...(options.stopped === undefined ? {} : { stopped: options.stopped }),
        });
        state.verdict = outcome.verdict;
        return outcome.ciVerdict === null
          ? outcome.verdict
          : `${outcome.verdict} — ${outcome.ciVerdict}`;
      },
    });
  }

  steps.push({
    name: "re-count",
    run: async () => {
      // The label is what makes the gate count the review. The review step
      // applies it when it posts; here it is the only thing left to do.
      if (!reviews && state.pullRequest !== 0) {
        await addRecountLabel({
          repo: options.repo,
          pullRequest: state.pullRequest,
          gh: options.gh,
        });
      }
      if (state.slug === null) {
        return "no change to count";
      }
      const digest = await computeDocumentsDigest(
        options.run,
        state.worktreePath,
        state.slug,
      );
      const directory = join(state.worktreePath, ".specify", "reviews");
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, `${state.slug}.md`),
        verdictFile({
          slug: state.slug,
          verdict: state.verdict,
          date: now.toISOString().slice(0, 10),
          pullRequest: state.pullRequest,
          reviewed: state.reviewedSha,
          documents: digest,
        }),
        "utf8",
      );
      await commitAll(options.git, state.worktreePath, "chore: the change's verdict");
      const sha = await headSha(options.git, state.worktreePath);
      await pushWorkBranch(options.git, state.worktreePath, {
        remote: options.remote,
        issueNumber: issue.number,
        sha,
        ...(options.verifyPushes === undefined ? {} : { verify: options.verifyPushes }),
      });
      return state.slug;
    },
  });

  const outcome = await runSteps({
    issue: issue.number,
    runId,
    root: options.checkout,
    steps,
    ...(options.onStep === undefined ? {} : { onStep: options.onStep }),
    ...(options.onStepStart === undefined ? {} : { onStepStart: options.onStepStart }),
    ...(options.stopped === undefined ? {} : { stopped: options.stopped }),
    release: async () => {
      if (!state.claimed) {
        return;
      }
      // A stopped run that already pushed is not a dead run: the claim is what
      // points the next run at its pull request. Released, the issue has no
      // label, derives as `Queue`, and the next run works it a second time.
      if (options.stopped?.() === true && state.pullRequest !== 0) {
        if (state.worktreePath !== "") {
          await removeWorktree(options.git, options.checkout, state.worktreePath).catch(
            () => {
              // The next run removes a worktree it could not.
            },
          );
        }
        return;
      }
      await releaseRun({
        repo: options.repo,
        remote: options.remote,
        cwd: options.checkout,
        issueNumber: issue.number,
        ...(state.worktreePath === "" ? {} : { worktreePath: state.worktreePath }),
        git: options.git,
        gh: options.gh,
      });
    },
  });

  // The worktree is scratch, and the branch holds the work: the next run that
  // needs one makes one. Left behind, a worktree per issue fills the worktree
  // root — and the setup script it runs is not cheap.
  if (state.worktreePath !== "") {
    await removeWorktree(options.git, options.checkout, state.worktreePath).catch(() => {
      // A worktree that could not be removed is cleaned up by the next attempt.
    });
  }

  return {
    issue: issue.number,
    outcome: "completed",
    steps: outcome.steps,
    record: outcome.record,
  };
}
