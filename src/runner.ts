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
  UNTRUSTED_INPUT_RULE,
  UNTRUSTED_INPUT_SECTION,
  createVerdictTool,
  runPromptArray,
  type ReviewVerdict,
  type Scheduler,
  type SessionFactory,
} from "./session.js";
import {
  addWorktree,
  fetchRef,
  pushWorkBranch,
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
  readPullRequest,
  reviewCommentBody,
  RECOUNT_LABEL,
  REVIEW_MARKER,
  type GhRunner,
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

/**
 * Push the work, and open the pull request for it.
 */
export async function publishWork(options: {
  readonly repo: string;
  readonly remote: string;
  readonly branch: string;
  readonly sha: string;
  readonly issueNumber: number;
  readonly title: string;
  readonly body: string;
  readonly cwd: string;
  readonly git: GitRunner;
  readonly gh: GhRunner;
  readonly run: CommandRunner;
}): Promise<{ readonly number: number; readonly created: boolean }> {
  await pushWorkBranch(options.git, options.cwd, {
    remote: options.remote,
    issueNumber: options.issueNumber,
    sha: options.sha,
  });
  return openPullRequest({
    repo: options.repo,
    branch: options.branch,
    title: options.title,
    body: options.body,
    gh: options.gh,
    run: options.run,
  });
}

/** The tool that reads a commit's CI verdict — the repository's own. */
export const CI_VERDICT_TOOL = "scripts/ci-verdict.py";

/**
 * The CI verdict of a commit, as the repository's own tool states it.
 *
 * A claim about CI that names a run id and nothing else is not evidence: a
 * repository has several workflows, and the one that says "success" may be the
 * cache cleanup. So the claim is a whole line — the workflow, the run, the
 * conclusion — and it comes from the tool that already knows how to judge it.
 *
 * `null` when the tool could not read it. A missing run is not a pass.
 */
export async function readCiVerdict(
  run: CommandRunner,
  cwd: string,
  options: { readonly ref: string; readonly repo: string },
): Promise<string | null> {
  try {
    const output = await run({
      command: "python3",
      args: [CI_VERDICT_TOOL, options.ref, "--repo", options.repo],
      cwd,
    });
    const line = output.trim();
    return line === "" ? null : line;
  } catch {
    // The tool says what it could not read; the runner says nothing rather
    // than something it cannot stand behind.
    return null;
  }
}

/** What a review of a pull request did. */
export interface ReviewOutcome {
  readonly verdict: "pass" | "fail";
  readonly comment: string;
  /** Whether the comment was posted — it is posted once, and only once. */
  readonly posted: boolean;
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

  try {
    await runPromptArray({
      session,
      prompts: [REVIEW_PROMPT],
      deadlineMs: options.deadlineMs,
      ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
    });
  } finally {
    session.dispose();
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
  const posted = await postReviewComment(options, comment);
  await addRecountLabel(options);

  return {
    verdict: verdict.verdict,
    comment,
    posted,
    ciVerdict: await readCiVerdict(options.run, options.cwd, {
      ref: String(options.pullRequest),
      repo: options.repo,
    }),
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
): Promise<boolean> {
  await options.gh(postCommentArgs(options.repo, options.pullRequest, comment));
  return true;
}

/** Apply the label that makes the gate count the review again. */
export async function addRecountLabel(options: {
  readonly repo: string;
  readonly pullRequest: number;
  readonly gh: GhRunner;
}): Promise<void> {
  await options.gh(
    addPullRequestLabelArgs(options.repo, options.pullRequest, RECOUNT_LABEL),
  );
}
