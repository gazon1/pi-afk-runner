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
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { claimIssue, reclaimClaim, releaseClaim } from "./claim.js";
import { errorMessage } from "./cli.js";
import { budgetShares } from "./budget.js";
import { GUARD_POLICY } from "./guard.js";
import { GateFailed, runGates } from "./gates.js";
import {
  UNTRUSTED_INPUT_RULE,
  UNTRUSTED_INPUT_SECTION,
  briefFence,
  createVerdictTool,
  cutOffMessage,
  runPromptArray,
  startAgent,
  type ReviewVerdict,
  type Scheduler,
  type SessionFactory,
} from "./session.js";
import {
  CommandFailed,
  addWorktree,
  branchesWithWork,
  fetchCommit,
  fetchRef,
  headRef,
  issueWorktreePath,
  pushWorkBranch,
  readRemoteSha,
  removeWorktree,
  runCommand,
  workBranch,
  type CommandRunner,
  type GitRunner,
} from "./git.js";
import {
  CLAIM_LABEL,
  addPullRequestLabelArgs,
  commentIssue,
  createPullRequest,
  dependencyNumbers,
  postCommentArgs,
  pullRequestBody,
  readAllOpenPullRequests,
  readClaimed,
  readIssue,
  readMergedPullRequest,
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
import { FixChangedNothing, ReviewStatedNoVerdict, cutOffError, runReviewGate } from "./workflow.js";
import type { Lock } from "./lock.js";

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
  /** What the reviewer found. Empty when it passed. */
  readonly findings: readonly string[];
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
  /**
   * The issue whose brief the review judges the change against.
   *
   * The reviewer is a new session: it has not seen the issue, and a diff alone
   * cannot say whether the change meets the acceptance criteria. The brief
   * travels with the prompt, fenced as untrusted data.
   */
  readonly issue?: IssueDetail;
}): Promise<ReviewOutcome> {
  const holder: { value?: ReviewVerdict } = {};
  const session = await options.factory({
    cwd: options.cwd,
    systemPromptSections: {
      [UNTRUSTED_INPUT_SECTION]: UNTRUSTED_INPUT_RULE,
    },
    tools: [createVerdictTool(holder)],
  });

  const fence = options.issue === undefined ? "" : briefFence(options.issue);
  const prompt =
    fence === ""
      ? REVIEW_PROMPT
      : [
          REVIEW_PROMPT,
          "",
          "## The brief this change is judged against",
          "",
          fence,
        ].join("\n");

  // The session belongs to `runPromptArray` once it is given one: it disposes
  // of it when the run is over. A second owner would make the session's life
  // the business of two places that do not agree on who is responsible.
  const result = await runPromptArray({
    session,
    prompts: [prompt],
    // The review is one state: the verdict, in one turn.
    states: [{ name: "review", phase: "Review" }],
    deadlineMs: options.deadlineMs,
    ...(options.stopped === undefined ? {} : { stopped: options.stopped }),
    ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
  });
  if (result.aborted) {
    // The same cut the work session reports; a review that did not finish is
    // not a review that stated no verdict.
    //
    // The cut is the engine's own abort error, not a plain failure: the
    // engine treats an unknown failure as recoverable and carries on to the
    // next state, and a review that was cut off would then be reviewed again
    // — the same diff, a second verdict, for a review that never happened.
    throw cutOffError(
      cutOffMessage({
        what: "the review's session",
        deadlineMs: options.deadlineMs,
        reason: result.cutReason,
        progress: { completed: result.completed, total: result.total },
      }),
    );
  }

  const verdict = holder.value;
  if (verdict === undefined) {
    // The reviewer did not reach a verdict. That is not a pass: a review that
    // says nothing decides nothing.
    throw new ReviewStatedNoVerdict(
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
    findings: verdict.findings,
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
 * The prompt a fix turn is given.
 *
 * It is the reviewer's findings, verbatim: the fix is about what the review
 * found, and a summary of them is a second reading of the diff by somebody who
 * did not review it. The gates are the same the implementing turn ran.
 */
export function fixPrompt(findings: readonly string[], issue?: IssueDetail): string {
  const fence = issue === undefined ? "" : briefFence(issue);
  return [
    "The reviewer of this pull request did not pass it. Fix what it found.",
    "",
    "## Findings",
    "",
    ...(findings.length === 0
      ? ["- The review said fail without naming a finding. Read the review comment on the pull request."]
      : findings.map((finding) => `- ${finding}`)),
    ...(fence === ""
      ? []
      : [
          "",
          "## The brief this change must still satisfy",
          "",
          fence,
        ]),
    "",
    "1. Address every finding. Where a finding is wrong, make the code say why it is wrong.",
    "",
    "2. Run the repository's gates, in this order:",
    "",
    "   ```bash",
    "   ./check.sh",
    "   just tcheck-evals",
    "   just docs-audit",
    "   ```",
    "",
    "   A small change — a few lines in one module — needs `./check.sh` only.",
    "",
    "3. Do not commit or push. The runner commits and pushes so the push stays",
    "   under its control.",
  ].join("\n");
}

/**
 * Run one fix turn in the worktree.
 *
 * It is a **new session**: the fix's context is the findings and the code, not
 * the work session's whole conversation. The worktree is the one the pull
 * request is on, and the runner commits and pushes after it.
 */
export async function fixWorktree(options: {
  readonly cwd: string;
  readonly factory: SessionFactory;
  readonly findings: readonly string[];
  readonly deadlineMs: number;
  readonly stopped?: () => boolean;
  readonly schedule?: Scheduler;
  /** The issue whose brief the fix must not break. */
  readonly issue?: IssueDetail;
}): Promise<void> {
  const session = await options.factory({
    cwd: options.cwd,
    systemPromptSections: { [UNTRUSTED_INPUT_SECTION]: UNTRUSTED_INPUT_RULE },
  });
  const result = await runPromptArray({
    session,
    prompts: [fixPrompt(options.findings, options.issue)],
    // The fix is one state: the findings, addressed in one turn.
    states: [{ name: "fix", phase: "Fix" }],
    deadlineMs: options.deadlineMs,
    ...(options.stopped === undefined ? {} : { stopped: options.stopped }),
    ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
  });
  if (result.aborted) {
    // The cut is the engine's own abort error, not a plain failure: the
    // engine treats an unknown failure as recoverable and carries on to the
    // next state, and a fix that was cut off would then be reviewed again —
    // the same diff, a second verdict, for a fix that never happened.
    throw cutOffError(
      cutOffMessage({
        what: "the fix's session",
        deadlineMs: options.deadlineMs,
        reason: result.cutReason,
        progress: { completed: result.completed, total: result.total },
      }),
    );
  }
}

/** The comment a run leaves on an issue whose review never passed. */
export function continuationComment(options: {
  readonly pullRequest: number;
  readonly findings: readonly string[];
  readonly reviews: number;
  readonly exhausted: boolean;
  /** Whether the loop stopped because the fix changed nothing. */
  readonly noChange: boolean;
  /** Whether the loop stopped because a review stated no verdict. */
  readonly noVerdict?: boolean;
}): string {
  const lines = [
    `The review of pull request #${options.pullRequest} did not pass after ${options.reviews} review(s).`,
  ];
  if (options.exhausted) {
    lines.push("The run's time budget ran out before a passing review.");
  }
  if (options.noChange) {
    lines.push(
      "The fix that followed the review changed nothing — the branch's head did not move, so there was nothing to push and nothing to review again.",
    );
  }
  if (options.noVerdict) {
    lines.push(
      "The review stated no verdict — the reviewer answered, but never called the verdict tool.",
    );
  }
  lines.push(
    "",
    "**What the review found:**",
    ...(options.findings.length === 0
      ? ["- the review named no finding"]
      : options.findings.map((finding) => `- ${finding}`)),
    "",
    "The branch and the pull request are kept. The next run picks this issue up and fixes what the review found.",
  );
  return lines.join("\n");
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
 * What is behind it is read by the caller, and read once for all the issues:
 * the pull requests are read in one `gh` call and matched by their branch, and
 * the branches are read from the remote in one `git` call. The observation
 * itself is a derivation over what was read, and it asks nothing of the
 * network.
 *
 * The staleness comes from the issue's last update — which any comment moves.
 */
export function observeIssue(options: {
  readonly issue: IssueSummary;
  /** The pull request behind the issue's branch, when there is one. */
  readonly pullRequest: PullRequestSummary | null;
  /** Whether the issue's branch carries work the base does not have. */
  readonly workBranch: boolean;
  readonly now: Date;
  readonly staleAfterMs: number;
}): IssueObservation {
  const observed = observePullRequest(options.pullRequest);
  return {
    issue: options.issue,
    pullRequest: options.pullRequest,
    state: deriveState({
      claimLabel: options.issue.labels.includes(CLAIM_LABEL),
      pullRequest: options.pullRequest !== null,
      reviewComment: observed.reviewComment,
      recountLabel: observed.recountLabel,
      workBranch: options.workBranch,
      stale: isStale(options.issue.updatedAt, options.now, options.staleAfterMs),
    }),
  };
}

/**
 * The open pull requests, by the branch they come from.
 *
 * The branch is the runner's own name for the work — `agent/issue-<N>` — so it
 * is what an issue's pull request is found by. A branch can have more than one
 * open pull request — one against another base — and the newest is the one the
 * runner's own work belongs to.
 */
export function pullRequestsByBranch(
  pullRequests: readonly PullRequestSummary[],
): Map<string, PullRequestSummary> {
  const byBranch = new Map<string, PullRequestSummary>();
  for (const pullRequest of pullRequests) {
    const known = byBranch.get(pullRequest.headRefName);
    if (known === undefined || (pullRequest.createdAt ?? "") > (known.createdAt ?? "")) {
      byBranch.set(pullRequest.headRefName, pullRequest);
    }
  }
  return byBranch;
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
  /**
   * What the step's command printed, when it failed and said something.
   *
   * The detail names the failure; this is the evidence behind it. Only the
   * gates step carries it: a gate says why it refused the change, and a
   * record that says only "a gate failed" says nothing a reader can act on.
   *
   * It is bounded: what is quoted here is the tail of what the command
   * printed, and never more than `RECORD_OUTPUT_LIMIT_BYTES` of it. The whole
   * of it is in the file `outputFile` names.
   */
  readonly output?: string;
  /**
   * Where the step's whole output is, when it was written to a file.
   *
   * The record quotes the tail; this is where the rest of it is, for whoever
   * wants the whole build log.
   */
  readonly outputFile?: string;
  /** Whether what is quoted is only the tail of what the step printed. */
  readonly outputTruncated?: boolean;
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
 * How much of a failed step's output the record quotes.
 *
 * Sixteen kilobytes: the end of a build log is where the failure is, and a
 * reader who has to scroll past a thousand lines of it is not reading a
 * document. The whole output is not lost — the record names the file it is
 * in.
 */
export const RECORD_OUTPUT_LIMIT_BYTES = 16 * 1024;

/**
 * The end of what a step printed.
 *
 * The tail is the part a reader needs, and the bound keeps the record a
 * document: the record is one markdown file, and it is meant to be read.
 */
function tail(text: string, limit: number): { readonly text: string; readonly truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) {
    return { text, truncated: false };
  }
  const cut = bytes.subarray(bytes.length - limit).toString("utf8");
  // The cut lands in the middle of a line: the line it lands in is dropped,
  // and what is quoted starts at a line of its own.
  const newline = cut.indexOf("\n");
  return { text: newline === -1 ? cut : cut.slice(newline + 1), truncated: true };
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

/**
 * The runner's own build, as the record names it.
 *
 * It is the package's version and the commit the build came from. The version
 * sits beside this module whether the runner runs from `src/` or `dist/`; the
 * commit is written next to the built module, so a run from `src/` — the tests —
 * has none, and says so by leaving it out.
 */
const RUNNER_STAMP = ((): string => {
  let version = "unknown";
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { readonly version?: string };
    version = pkg.version ?? version;
  } catch {
    // A record must not fail over what it says about itself.
  }
  let sha: string | null = null;
  try {
    const built = JSON.parse(
      readFileSync(new URL("./build-info.json", import.meta.url), "utf8"),
    ) as { readonly sha?: string | null };
    sha = built.sha ?? null;
  } catch {
    // No build stamp: the module is running from `src/`.
  }
  return sha === null ? version : `${version} ${sha}`;
})();

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
    `- runner: ${RUNNER_STAMP}`,
    `- outcome: ${options.outcome}`,
    "",
    "## Steps",
    "",
  ];
  for (const step of options.steps) {
    const detail = step.detail === "" ? "" : ` — ${step.detail}`;
    lines.push(`- ${step.step} — ${step.outcome}${detail}`);
    // Where the whole output went, when it went somewhere: the record quotes
    // the tail of it, and the file is where the rest of it is.
    if (step.outputFile !== undefined) {
      const quoted =
        step.outputTruncated === true
          ? ` — only its last ${RECORD_OUTPUT_LIMIT_BYTES / 1024} KiB are quoted here`
          : "";
      lines.push(`  the whole output is at ${step.outputFile}${quoted}`);
    }
    // What the command printed, indented under the step it belongs to.
    for (const line of (step.output ?? "").split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      lines.push(`  ${line}`);
    }
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
  readonly release?: () => Promise<string | void>;
  /** Told about every step, as it finishes. */
  readonly onStep?: (record: StepRecord) => void;
  /** Told about a step as it starts. */
  readonly onStepStart?: (step: string) => void;
}): Promise<RunOutcome> {
  const steps: StepRecord[] = [];
  let failure: { readonly step: string; readonly error: Error } | null = null;

  for (const step of options.steps) {
    let record: StepRecord;
    try {
      options.onStepStart?.(step.name);
      const output = await step.run();
      record = { step: step.name, outcome: "ok", detail: redact(firstLine(output)) };
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      // Only the gates step carries its output into the record. A gate says
      // why it refused the change; the other steps say what they said in
      // their detail, and a record of every failed command's output would be
      // a record of megabytes.
      const output = cause instanceof GateFailed ? cause.output : "";
      // The record quotes the tail of it: the end of a build log is where the
      // failure is, and the record is a document a person reads.
      const quoted = tail(output, RECORD_OUTPUT_LIMIT_BYTES);
      record = {
        step: step.name,
        outcome: "failed",
        detail: redact(firstLine(cause.message)),
        ...(quoted.text === "" ? {} : { output: redact(quoted.text) }),
        ...(quoted.truncated ? { outputTruncated: true } : {}),
        ...(cause instanceof GateFailed && cause.outputFile !== undefined
          ? { outputFile: cause.outputFile }
          : {}),
      };
      steps.push(record);
      options.onStep?.(record);
      // A gate that failed belongs to the gates step, wherever it happened:
      // the review's fix path runs the gates too, and a failure there is the
      // gates' failure, not the review's.
      failure = {
        step: cause instanceof GateFailed ? "gates" : step.name,
        error: cause,
      };
      break;
    }
    steps.push(record);
    options.onStep?.(record);
  }

  // The claim goes, even though the run failed: a claim nobody is working is
  // an issue nobody can take.
  if (failure !== null && options.release !== undefined) {
    try {
      const detail = await options.release();
      steps.push({ step: "release", outcome: "ok", detail: detail ?? "" });
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
   * Asked before every turn of the agent. An abort cuts the turn that is running;
   * this is what keeps the array from sending the next one — a stop that only cut
   * a turn would let the run carry on to its push.
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
  /**
   * Take the issue's host lock, once the run knows which issue it works.
   *
   * A run that named its issue took the lock before it read anything; a run
   * that let the queue choose did not know the issue until the choice was
   * made, so the lock has to be taken here — before the first step that
   * writes anything. It is given back when the run ends, however it ends.
   */
  readonly lockIssue?: (issue: number) => Promise<Lock>;
  readonly now?: Date;
  readonly nonce?: string;
  readonly runId?: string;
}

/** What a run did. */
export interface RunResult {
  /** The issue the run worked, or null when it worked none. */
  readonly issue: number | null;
  /**
   * What the run did with the issue.
   *
   * `skipped` and `split` are finished runs: the triage or the scope turn
   * decided the issue is not one run's work, the run closed it, and the queue
   * moves on. Neither is a failure.
   */
  readonly outcome: "completed" | "empty" | "unworkable" | "skipped" | "split";
  readonly steps: readonly StepRecord[];
  /** Where the record was written. */
  readonly record: string;
  /** The derived state that made a named issue unworkable. */
  readonly derivedState?: DerivedState;
  /** Why the issue was skipped or split, when it was. */
  readonly reason?: string;
  /** The parent issues that are still open, when that is why the issue waits. */
  readonly blockedBy?: readonly number[];
}

/**
 * Why an issue could not be worked, in the words the front doors say.
 *
 * One mapping, so the CLI and the live door say the same thing about the
 * same derived state.
 */
export function unworkableReason(derivedState: DerivedState | undefined): string {
  switch (derivedState) {
    case "Claimed":
      return "it is held by another runner";
    case "Reviewed":
      return "already reviewed";
    case "Counted":
      return "already counted";
    default:
      return "check whether it is claimed by another runner, already reviewed, or already counted";
  }
}

/**
 * Why an issue is waiting for its parent, in the words the front doors say.
 *
 * A dependency is the issue's own text — `**Depends on:** #N` — and it is
 * satisfied by the parent's work landing: its pull request is merged. A parent
 * that was closed without a merge is not merged yet, and the child waits.
 */
export function blockedReason(
  blockedBy: readonly number[] | undefined,
): string | null {
  if (blockedBy === undefined || blockedBy.length === 0) {
    return null;
  }
  return `it waits for ${blockedBy.map((number) => `#${number}`).join(", ")} — a parent issue is not merged yet`;
}

/** The commit the worktree is at. */
export async function headSha(git: GitRunner, cwd: string): Promise<string> {
  return (await git(["rev-parse", "HEAD"], { cwd })).trim();
}

/**
 * A change at or below this many files is small.
 *
 * The long checks — the repository's pre-push hook, whose detekt verdict over
 * one module takes minutes — earn their cost on a change that reaches them. A
 * handful of files in one module does not, and the run's own gate (the
 * review) still reads it.
 */
export const SMALL_CHANGE_MAX_FILES = 3;

/**
 * A change at or below this many changed lines is small.
 *
 * It is the second half of the size rule: a one-file change that rewrites
 * three hundred lines is not small, whatever its file count says.
 */
export const SMALL_CHANGE_MAX_LINES = 60;

/** How many times the review may fail and be fixed in one run. */
export const MAX_FIX_ITERATIONS = 3;

/** How big a change is. */
export interface ChangeSize {
  /** The files the diff touches. */
  readonly files: number;
  /** The lines it adds and removes. Binary files count as zero lines. */
  readonly lines: number;
}

/**
 * The size of the diff between two commits.
 *
 * `--numstat` is the form git writes for machines: one line per file, the
 * additions, the deletions and the path. `-` in either count is a binary file,
 * which has no line count; it still counts as a file.
 */
export async function changedSize(
  git: GitRunner,
  cwd: string,
  options: { readonly base: string; readonly head: string },
): Promise<ChangeSize> {
  const output = await git(
    ["diff", "--numstat", `${options.base}...${options.head}`],
    { cwd },
  );
  let files = 0;
  let lines = 0;
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (line === "") {
      continue;
    }
    const [added, removed] = line.split("\t");
    if (added === undefined || removed === undefined) {
      continue;
    }
    files += 1;
    const additions = Number(added);
    const deletions = Number(removed);
    if (Number.isFinite(additions)) {
      lines += additions;
    }
    if (Number.isFinite(deletions)) {
      lines += deletions;
    }
  }
  return { files, lines };
}

/** Whether a change is small enough to skip the long pre-push checks. */
export function isSmallChange(size: ChangeSize): boolean {
  return (
    size.files > 0 &&
    size.files <= SMALL_CHANGE_MAX_FILES &&
    size.lines <= SMALL_CHANGE_MAX_LINES
  );
}

/**
 * Whether a push may skip the repository's pre-push hook.
 *
 * An explicit request wins; otherwise a small change skips the hook and a
 * larger one does not. The hook is the repository's rule, and the skip is a
 * decision about the repository's state, so the default is the cautious one
 * everywhere except where the size makes the hook's cost larger than its
 * value.
 */
export function verifyPush(options: {
  readonly verifyPushes?: boolean | undefined;
  readonly size: ChangeSize;
}): boolean {
  return options.verifyPushes ?? !isSmallChange(options.size);
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
 * Run the gates on the worktree, and put the worktree back afterwards.
 *
 * The gates build in the worktree, and the runner's own commits are made with
 * `git add -A`: the artifacts would go to the remote with the work. The tree
 * the gates judged is the tree that is pushed, so the worktree goes back to it
 * — whether the gates passed or not.
 *
 * A worktree that could not be put back is a run that stops: a tree with a
 * gate's build in it is not a tree to push. The gate's own failure is the one
 * the record carries, though: a failed gate is what the reader needs to see.
 */
async function gateTheTree(options: {
  readonly git: GitRunner;
  readonly run: CommandRunner;
  readonly cwd: string;
  readonly budgetMs: number;
  /** Where the gates' whole output goes while they run. */
  readonly outputFile?: string;
}): Promise<string> {
  const outcome = await runGates({
    run: options.run,
    cwd: options.cwd,
    budgetMs: options.budgetMs,
    ...(options.outputFile === undefined ? {} : { outputFile: options.outputFile }),
  }).then(
    (summary) => ({ summary, failure: undefined as unknown }),
    (error: unknown) => ({ summary: "", failure: error }),
  );
  try {
    await restoreWorktree(options.git, options.cwd);
  } catch (restoreError) {
    if (outcome.failure === undefined) {
      throw restoreError;
    }
  }
  if (outcome.failure !== undefined) {
    throw outcome.failure;
  }
  return outcome.summary;
}

/**
 * Put the worktree back to the tree the gates judged.
 *
 * A gate that builds leaves its build in the worktree, and the runner's own
 * commits are made with `git add -A`: the artifacts would go to the remote
 * with the work. The tree the gates judged is the tree that is pushed, so the
 * worktree goes back to it — the files the gates changed and the files they
 * left behind.
 *
 * The ignored files stay: the worktree's own Gradle home, its `.env` copy
 * and its build outputs are the repository's, not the runner's to delete.
 */
export async function restoreWorktree(git: GitRunner, cwd: string): Promise<void> {
  await git(["reset", "--hard"], { cwd });
  await git(["clean", "-fd"], { cwd });
}

/**
 * Keep the work a run that did not finish left behind.
 *
 * The worktree goes when the run ends, and what was only in the worktree goes
 * with it. The agent's own commits are on the branch; the files it had not
 * committed yet are not. They are committed here, on the branch the next run
 * continues, so the next run starts from the work rather than from the base.
 *
 * The commit is local. The branch is not pushed, so the issue does not derive
 * as "pushed" and the next run works the issue rather than planning a pull
 * request for work nobody has reviewed.
 */
export async function preserveUnfinishedWork(options: {
  readonly git: GitRunner;
  readonly cwd: string;
  /** The branch the work is kept on. */
  readonly branch: string;
}): Promise<string | null> {
  const status = await options.git(["status", "--porcelain"], { cwd: options.cwd });
  if (status.trim() === "") {
    return null;
  }
  await commitAll(
    options.git,
    options.cwd,
    "wip: the work a run that did not finish left behind",
  );
  return `the unfinished work is on ${options.branch}`;
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
      };
    }
    return { issue: null, outcome: "empty", steps: [], record: "" };
  }
  if ("unworkable" in planOrUnworkable) {
    return {
      issue: options.issueNumber ?? null,
      outcome: "unworkable",
      steps: [],
      record: "",
      derivedState: planOrUnworkable.derivedState,
      ...(planOrUnworkable.blockedBy === undefined
        ? {}
        : { blockedBy: planOrUnworkable.blockedBy }),
    };
  }
  const lock = await options.lockIssue?.(planOrUnworkable.issue.number);
  try {
    return await runPlan(options, planOrUnworkable, now, runId);
  } finally {
    await lock?.release();
  }
}

/**
 * The parent issues an issue waits for, of which at least one has not landed.
 *
 * An issue's dependency is written in its own text, as `**Depends on:** #N`,
 * and it is settled when the parent's work has **landed** — its pull request
 * is merged. Nothing else settles it: not a parent that was closed as
 * won't-fix, not a parent whose pull request is open or closed unmerged, and
 * not a parent whose pull request could not be read. The rule is recorded in
 * `docs/decisions/2026-11-03-a-dependency-is-settled-by-a-merge.md`.
 *
 * The child's own text is read best-effort: an issue whose text cannot be
 * read has no dependency the runner can see, and the run cannot go on without
 * the brief either — it stops there, where the brief is read.
 */
export async function openDependencies(
  options: { readonly repo: string; readonly gh: GhRunner },
  issue: IssueSummary,
  detail?: IssueDetail,
): Promise<number[]> {
  let read: IssueDetail;
  try {
    read = detail ?? (await readIssue(options.repo, issue.number, options.gh));
  } catch {
    return [];
  }
  const open: number[] = [];
  for (const dependency of dependencyNumbers([read.body, ...read.comments])) {
    if (dependency === issue.number) {
      continue;
    }
    if (!(await hasLanded(options.repo, dependency, options.gh))) {
      open.push(dependency);
    }
  }
  return open;
}

/**
 * Whether the parent's work has landed — its pull request is merged.
 *
 * The observable is the runner's own work branch, `agent/issue-<N>`: a parent
 * whose work landed on another branch keeps the child waiting.
 *
 * A read that fails is not a landing: the parent keeps the child waiting, and
 * the next run reads it again. The queue is read once per run, so a read that
 * fails holds an issue out for one run, not for ever.
 */
async function hasLanded(
  repo: string,
  parent: number,
  gh: GhRunner,
): Promise<boolean> {
  try {
    return (await readMergedPullRequest(repo, workBranch(parent), gh)) !== null;
  } catch {
    return false;
  }
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
): Promise<
  | Plan
  | {
      readonly unworkable: true;
      readonly derivedState: DerivedState;
      readonly blockedBy?: readonly number[];
    }
  | null
> {
  /** The failure of the selection, in the words the front doors show. */
  const selectFailed = (failure: unknown): RunFailed => {
    const reason = failure instanceof Error ? failure.message : String(failure);
    return new RunFailed({
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
  };

  let namedDetail: IssueDetail | undefined;
  let candidates: IssueSummary[];
  let pullRequests: readonly PullRequestSummary[];
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
    // Every open pull request, in one read. The claimed issues are matched
    // against it by their branch, so the cost of the selection does not grow
    // with the number of issues the runner has ever worked: the claim stays on
    // an issue until the issue closes, and one call per claimed issue made
    // every run pay for the whole history. A run with nothing claimed reads
    // nothing: there is no issue to match a pull request against.
    pullRequests =
      candidates.length === 0
        ? []
        : await readAllOpenPullRequests(options.repo, options.gh);
  } catch (failure) {
    throw selectFailed(failure);
  }

  const byBranch = pullRequestsByBranch(pullRequests);
  // The branches that carry work, read for all the candidates at once. An
  // issue with a pull request does not need it: the pull request is the work,
  // and the derivation stops at the pull request.
  let work: ReadonlySet<string>;
  try {
    work = await branchesWithWork(options.git, options.checkout, {
      remote: options.remote,
      base: options.baseBranch,
      branches: candidates
        .filter((candidate) => !byBranch.has(workBranch(candidate.number)))
        .map((candidate) => workBranch(candidate.number)),
    });
  } catch (failure) {
    throw selectFailed(failure);
  }

  let namedUnworkableState: DerivedState | undefined;
  let namedBlockedBy: readonly number[] | undefined;
  for (const candidate of candidates) {
    const branch = workBranch(candidate.number);
    const observation = observeIssue({
      issue: candidate,
      pullRequest: byBranch.get(branch) ?? null,
      workBranch: work.has(branch),
      now,
      staleAfterMs: options.staleAfterMs,
    });
    const plan = planFor(observation);
    // An issue that has not been started waits for its parents' work to land;
    // one that is already pushed, opened or reviewed is past the waiting,
    // whatever its text says.
    if (plan.kind === "work") {
      const blockedBy = await openDependencies(
        { repo: options.repo, gh: options.gh },
        candidate,
        options.issueNumber !== undefined ? namedDetail : undefined,
      );
      if (blockedBy.length > 0) {
        if (options.issueNumber !== undefined) {
          namedBlockedBy = blockedBy;
        }
        continue;
      }
    }
    if (plan.kind !== "none") {
      return namedDetail === undefined ? plan : { ...plan, issueDetail: namedDetail };
    }
    if (options.issueNumber !== undefined) {
      namedUnworkableState = observation.state;
    }
  }

  if (options.issueNumber !== undefined) {
    if (namedBlockedBy !== undefined) {
      return {
        unworkable: true,
        derivedState: namedUnworkableState ?? "Queue",
        blockedBy: namedBlockedBy,
      };
    }
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
    throw selectFailed(failure);
  }
  // The queue is worked in order, and an issue whose parent's work has not
  // landed is passed over — not worked, and not removed: it is the next run's
  // turn once the parent's pull request is merged.
  for (const candidate of queue) {
    if (candidate.labels.includes(CLAIM_LABEL)) {
      continue;
    }
    const blockedBy = await openDependencies(
      { repo: options.repo, gh: options.gh },
      candidate,
    );
    if (blockedBy.length > 0) {
      continue;
    }
    return { kind: "work", issue: candidate, pullRequest: null };
  }
  return null;
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
  // Read the branch's commit from a ref this run fetched for itself: the
  // branch can move between a fetch and the read, and `FETCH_HEAD` is shared
  // with every other run of the checkout.
  const exists = await readRemoteSha(options.git, options.checkout, {
    remote: options.remote,
    ref: headRef(options.branch),
  });
  if (exists === null) {
    throw new Error(`the branch ${options.branch} is not on ${options.remote}`);
  }
  const sha = await fetchCommit(options.git, options.checkout, {
    remote: options.remote,
    ref: headRef(options.branch),
  });
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
    /** The issue, once the work session read it; a resume reads it itself. */
    issue: plan.issueDetail ?? (null as IssueDetail | null),
    /** What the work session decided to do with the issue. */
    decision: "work" as "work" | "skip" | "split",
    /** Why it decided that. */
    reason: "",
    /** What the last review found, when it found something. */
    findings: [] as readonly string[],
    /** How many reviews the run took. */
    reviewCount: 0,
  };

  const works = plan.kind === "work" || plan.kind === "reclaim";
  let reviews = works || plan.kind === "pull request" || plan.kind === "review";
  let workSessionStartedAt: number | undefined;

  // The run's budget is one wall-clock for everything it does: the session,
  // the gates and the review. Each keeps a share of it, and the share is
  // reserved: a session that may spend the whole budget must not leave the
  // gates nothing to run with.
  const shares = budgetShares(options.deadlineMs);
  const sessionBudgetMs = shares.sessionMs;
  const runStartedAt = Date.now();
  /**
   * What is left of the run's budget.
   *
   * One clock for the whole run: the session, the gates and the review share
   * it, and each of them asks what is left when its turn comes.
   */
  const remaining = (): number =>
    options.deadlineMs - (Date.now() - (workSessionStartedAt ?? runStartedAt));
  /** What the gates have spent of their share. */
  let gatesSpentMs = 0;
  /**
   * The gates' whole output goes to a file beside the record.
   *
   * The record quotes the tail of what a gate printed and names the file; the
   * file is where the rest of it is. A record is a document a person reads,
   * and a document that carries a whole build log is not read.
   */
  const gatesLog = join(
    recordDirectory(options.checkout, issue.number),
    `${runId}-gates.log`,
  );
  /**
   * The gates run on the tree the agent left, and again on the tree a
   * review's fix left. Both sets come out of the one share, so a fix loop
   * that runs the suite on every iteration cannot spend the run's whole
   * budget on gates.
   */
  const runTheGates = async (): Promise<string> => {
    const startedAt = Date.now();
    try {
      return await gateTheTree({
        git: options.git,
        run: options.run,
        cwd: state.worktreePath,
        budgetMs: Math.max(0, shares.gatesMs - gatesSpentMs),
        outputFile: gatesLog,
      });
    } finally {
      gatesSpentMs += Date.now() - startedAt;
    }
  };

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
        state.worktreePath = issueWorktreePath(options.worktreeRoot, issue.number);
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
        // The commits the branch already carries, read here rather than left to
        // the agent: the triage judges whether the issue is still needed, and
        // work an earlier run left on this branch must not read as work that
        // has landed. `git log` and not a two-dot diff: the branch may have
        // started from a base older than the one this run claimed, and a diff
        // would show the base's own changes as the branch's.
        const carried = (
          await options.git(["log", "--oneline", `${state.base}..HEAD`], {
            cwd: state.worktreePath,
          })
        )
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "");
        const result = await startAgent({
          factory: options.session,
          cwd: state.worktreePath,
          repo: options.repo,
          issueNumber: issue.number,
          ...(plan.issueDetail === undefined ? {} : { issue: plan.issueDetail }),
          worktree: {
            branch: workBranch(issue.number),
            baseBranch: options.baseBranch,
            baseSha: state.base,
            commits: carried,
          },
          gh: options.gh,
          // The session does not get the whole budget: the gates run after
          // it, and a session that may spend everything leaves them nothing
          // to run with.
          deadlineMs: sessionBudgetMs,
          ...(options.stopped === undefined ? {} : { stopped: options.stopped }),
        });
        const workElapsedMs = workSessionStartedAt === undefined ? 0 : Date.now() - workSessionStartedAt;
        if (workElapsedMs >= sessionBudgetMs) {
          reviews = false;
        }
        if (result.aborted) {
          // The deadline is one reason a turn is cut; a human stopping the run is
          // another. The runner can tell them apart, and the record has to say
          // which one it was: a record that cannot is not a record.
          throw new Error(
            cutOffMessage({
              what: "the agent's session",
              deadlineMs: sessionBudgetMs,
              reason: result.cutReason,
              progress: { completed: result.completed, total: result.total },
            }),
          );
        }
        state.decision = result.decision;
        state.reason = result.reason;
        state.issue = result.issue;
        if (result.decision !== "work") {
          // The branch closed the issue (skip) or replaced it with smaller ones
          // (split). There is no work to commit, push or review: the run ends
          // where the graph ended, and the sweep moves to the next issue.
          if (result.decision === "split") {
            return "split into smaller issues";
          }
          // A skip discards whatever the branch carried. The record says how
          // much that was, so a human can see it without the transcript.
          const carriedNote =
            carried.length === 0
              ? ""
              : ` — the branch carried ${carried.length} commit(s) the base does not have`;
          return `closed: the issue does not need work${carriedNote}`;
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
        // The work is committed, and the gates run on it: the tree they judge
        // is the tree that is pushed.
        //
        // A change the work landed needs its registry entry, and the entry
        // belongs to the pull request. It is created here and not in the push
        // step, because the gates run between the two: a gate that judged the
        // tree without the entry would judge a tree the pull request never
        // carries.
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
        return `${result.completed} turns`;
      },
    });
    steps.push({
      name: "gates",
      run: async () => {
        if (state.decision !== "work") {
          return "skipped — the issue was not worked";
        }
        // The repository's own gates, in the worktree, on the tree the agent
        // left. The agent was told to run them too — it has to, to fix what
        // they report — but the runner runs them because an agent that
        // skipped them is not a gate, and a broken diff that reaches the
        // review costs a whole review cycle.
        //
        // A gate that does not pass ends the run here: the claim is released
        // and nothing is pushed.
        return await runTheGates();
      },
    });
    steps.push({
      name: "push",
      run: async () => {
        if (state.decision !== "work") {
          return "skipped — the issue was not worked";
        }
        const sha = await headSha(options.git, state.worktreePath);
        const size = await changedSize(options.git, state.worktreePath, {
          base: state.base,
          head: sha,
        });
        const small = isSmallChange(size);
        await pushWorkBranch(options.git, state.worktreePath, {
          remote: options.remote,
          issueNumber: issue.number,
          sha,
          verify: verifyPush({ verifyPushes: options.verifyPushes, size }),
        });
        return small
          ? `${sha.slice(0, 8)} (small change — the long checks are skipped)`
          : sha.slice(0, 8);
      },
    });
  } else {
    // The work is already pushed. The worktree is where that work is read —
    // the reviewer needs the code, and the branch is not pushed again.
    state.worktreePath = issueWorktreePath(options.worktreeRoot, issue.number);
    await prepareExistingWorktree(options, state.worktreePath, issue.number);
    // A resume has no claim to record the base, and the size of a fix's diff
    // is read from the base the pull request is against.
    state.base = await fetchCommit(options.git, options.checkout, {
      remote: options.remote,
      ref: headRef(options.baseBranch),
    });
  }

  if (works || plan.kind === "pull request") {
    steps.push({
      name: "pull request",
      run: async () => {
        if (state.decision !== "work") {
          return "skipped — the issue was not worked";
        }
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
        if (state.decision !== "work" || !reviews) {
          return "skipped";
        }
        // The work session handed back the issue it read. A resume has no work
        // session, so the review reads it once; the fix and every re-review see
        // the same brief.
        const detail =
          state.issue ?? (await readIssue(options.repo, issue.number, options.gh));
        state.issue = detail;
        let exhausted = false;

        // `gate` is the engine's retry-until-pass block: review, and when the
        // verdict failed, fix what it found and review the fixed diff again.
        //
        // The review keeps its own share of the budget: the gates have theirs,
        // and a review that is given what the gates left is a review that
        // never gets to answer.
        const reviewBudget = (): number => Math.min(shares.reviewMs, remaining());
        const outcome = await runReviewGate({
          attempts: MAX_FIX_ITERATIONS + 1,
          review: async () => {
            const budget = reviewBudget();
            if (budget <= 0) {
              exhausted = true;
              return "fail";
            }
            state.reviewedSha = await headSha(options.git, state.worktreePath);
            const reviewed = await reviewPullRequest({
              repo: options.repo,
              pullRequest: state.pullRequest,
              cwd: state.worktreePath,
              factory: options.session,
              gh: options.gh,
              run: options.run,
              deadlineMs: budget,
              ...(options.stopped === undefined ? {} : { stopped: options.stopped }),
              issue: detail,
            });
            state.verdict = reviewed.verdict;
            state.findings = reviewed.findings;
            state.reviewCount += 1;
            return reviewed.verdict;
          },
          fix: async () => {
            const budget = reviewBudget();
            if (budget <= 0) {
              exhausted = true;
              return;
            }
            // The head before the fix: a fix that leaves it where it was
            // changed nothing.
            const before = await headSha(options.git, state.worktreePath);
            // A fresh session per fix: the fix's context is the findings and
            // the code, not the work session's whole conversation.
            await fixWorktree({
              cwd: state.worktreePath,
              factory: options.session,
              findings: state.findings,
              deadlineMs: budget,
              ...(options.stopped === undefined ? {} : { stopped: options.stopped }),
              issue: detail,
            });
            await commitAll(
              options.git,
              state.worktreePath,
              "fix: the review's findings",
            );
            const after = await headSha(options.git, state.worktreePath);
            if (after === before) {
              // The fix changed nothing: there is nothing to push and nothing
              // to review again. The loop stops here, and the run fails with
              // the reason — the same way an exhausted loop does.
              throw new FixChangedNothing();
            }
            // The fix changed the tree, so the tree the gates judged is not
            // the tree that would be pushed: the gates run again, and a fix
            // that does not pass them is not pushed. The tree on the remote
            // is the tree the gates judged.
            //
            // The commit comes first, because the restore puts the worktree
            // back to the tree the gates judged — and that tree is the
            // commit. The build the gates leave is what the restore takes
            // away, and the next commit is what it keeps out of.
            await runTheGates();
            const sha = await headSha(options.git, state.worktreePath);
            const size = await changedSize(options.git, state.worktreePath, {
              base: state.base,
              head: sha,
            });
            await pushWorkBranch(options.git, state.worktreePath, {
              remote: options.remote,
              issueNumber: issue.number,
              sha,
              verify: verifyPush({ verifyPushes: options.verifyPushes, size }),
            });
          },
        }).catch((error: unknown) => {
          // A gate that refused the fix is under the workflow's error: the
          // engine stops on it, and the failure itself is what the record
          // and the exit code must name.
          const cause = (error as { readonly details?: unknown }).details;
          throw cause instanceof Error ? cause : error;
        });

        if (outcome.passed) {
          return `${state.reviewCount} review(s) — pass`;
        }

        // The run was cut off — the review's session, or the fix's. There is
        // no verdict to answer: nothing to fix, and nothing to review again.
        // The run says what was cut off and what cut it off, and it does not
        // say the review failed: a review that was cut off is not a review
        // that said `fail`.
        if (outcome.cutOff !== null) {
          throw new Error(outcome.cutOff);
        }

        // The review never passed. The finding goes on the issue — where the
        // next run reads it as intake — and the run fails, which releases the
        // claim and leaves the branch and the pull request for that run.
        await commentIssue(
          {
            repo: options.repo,
            issueNumber: issue.number,
            body: continuationComment({
              pullRequest: state.pullRequest,
              findings: state.findings,
              reviews: state.reviewCount,
              exhausted,
              noChange: outcome.noChange,
              noVerdict: outcome.statedNoVerdict,
            }),
          },
          options.gh,
        );
        // The reason the loop stopped is in the message: the finding, and —
        // when the fix changed nothing — that the fix did not answer it.
        throw new Error(
          outcome.statedNoVerdict
            ? `the review of pull request ${state.pullRequest} stated no verdict`
            : `the review did not pass after ${state.reviewCount} review(s)` +
                (state.findings.length === 0
                  ? ""
                  : `: ${state.findings.join("; ")}`) +
                (outcome.noChange ? " — the fix changed nothing" : ""),
        );
      },
    });
  }

  steps.push({
    name: "re-count",
    run: async () => {
      if (state.decision !== "work") {
        return "skipped — the issue was not worked";
      }
      // The label is what makes the gate count the review. The review step
      // applies it when it posts; here it is the only thing left to do — and
      // only when there is a review to count. A run whose deadline left no
      // room for the review must not mark the pull request as reviewed.
      const reviewed = state.reviewCount > 0 || plan.kind === "re-count";
      if (!reviews && reviewed && state.pullRequest !== 0) {
        await addRecountLabel({
          repo: options.repo,
          pullRequest: state.pullRequest,
          gh: options.gh,
        });
      }
      // A run whose deadline left no room for a review has no verdict to
      // write. A pass file without a review is a lie the next reader would
      // believe, so the step says what happened instead.
      if (state.reviewCount === 0) {
        return "no review to count";
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
      const size = await changedSize(options.git, state.worktreePath, {
        base: state.base,
        head: sha,
      });
      await pushWorkBranch(options.git, state.worktreePath, {
        remote: options.remote,
        issueNumber: issue.number,
        sha,
        verify: verifyPush({ verifyPushes: options.verifyPushes, size }),
      });
      return state.slug;
    },
  });

  const runOutcome = await runSteps({
    issue: issue.number,
    runId,
    root: options.checkout,
    steps,
    ...(options.onStep === undefined ? {} : { onStep: options.onStep }),
    ...(options.onStepStart === undefined ? {} : { onStepStart: options.onStepStart }),
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
      // The work a failed run did is durable: what the agent left in the
      // worktree is committed to the branch before the worktree goes, so the
      // next run continues it instead of starting again.
      const kept =
        state.worktreePath === ""
          ? null
          : await preserveUnfinishedWork({
              git: options.git,
              cwd: state.worktreePath,
              branch: workBranch(issue.number),
            }).catch(() => null);
      await releaseRun({
        repo: options.repo,
        remote: options.remote,
        cwd: options.checkout,
        issueNumber: issue.number,
        ...(state.worktreePath === "" ? {} : { worktreePath: state.worktreePath }),
        git: options.git,
        gh: options.gh,
      });
      return kept ?? "";
    },
  });

  // A run that closed or split its issue leaves no claim behind: the claim is
  // what points the next run at a pull request, and this issue has none. The
  // release also removes the worktree, which is scratch on every path.
  if (state.decision !== "work" && state.claimed) {
    await releaseRun({
      repo: options.repo,
      remote: options.remote,
      cwd: options.checkout,
      issueNumber: issue.number,
      ...(state.worktreePath === "" ? {} : { worktreePath: state.worktreePath }),
      git: options.git,
      gh: options.gh,
    });
  }

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
    outcome:
      state.decision === "skip"
        ? "skipped"
        : state.decision === "split"
          ? "split"
          : "completed",
    steps: runOutcome.steps,
    record: runOutcome.record,
    ...(state.reason === "" ? {} : { reason: state.reason }),
  };
}
