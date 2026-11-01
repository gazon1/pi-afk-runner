/**
 * Every GitHub read the runner does, in one place.
 *
 * Why one place
 * --------------
 * The labels and the search forms are a contract with a repository the runner does
 * not own: `ready-for-agent` is what a human applies to say "this issue is
 * specified", `agent-in-progress` is the runner's own claim, and
 * `agent-reviewed` is what re-counts the review gate. A query that names one of
 * them wrongly does not fail — it returns the wrong issues, or none, and the
 * runner carries on.
 *
 * So the arguments are written down here, once, and the tests check them
 * against what `gh` actually does.
 *
 * Two things about `gh` that are measured, not assumed:
 *
 * - **The default page size is 30.** The queue is larger than that, so
 *   `--limit` is not optional: without it the runner sees the first thirty
 *   issues and believes it has seen them all.
 * - **The exclusion is the minus form.** `--search '-label:agent-in-progress'`
 *   excludes; `--search 'no:label:agent-in-progress'` returns nothing at all,
 *   because there is no such thing as an issue with no labels.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { COMMAND_TIMEOUT_MS } from "./git.js";

const execFileAsync = promisify(execFile);

/** The label a human applies to say "this issue is specified and may be taken". */
export const QUEUE_LABEL = "ready-for-agent";

/** The marker a brief comment has to open with. */
export const BRIEF_MARKER = "## Agent Brief";

/** The runner's claim on an issue. */
export const CLAIM_LABEL = "agent-in-progress";

/** The label that re-counts the review gate on a pull request. */
export const RECOUNT_LABEL = "agent-reviewed";

/** The marker a review comment has to open with. */
export const REVIEW_MARKER = "<!-- agent-review -->";

/** `gh`'s own default page size. */
export const GH_DEFAULT_PAGE_SIZE = 30;

/**
 * The page size the runner asks for.
 *
 * The runner's issue reads are larger than `gh`'s default, and the default
 * silently truncates them: the queue, the claimed set, and the open issues a
 * duplicate check reads. Five hundred is far above any of them, and the cost
 * of asking for more than you need is one request.
 */
export const ISSUE_PAGE_SIZE = 500;

/** An issue, as far as the runner cares. */
export interface IssueSummary {
  readonly number: number;
  readonly title: string;
  /** When the issue last changed — the claim's staleness clock. */
  readonly updatedAt: string;
  readonly labels: readonly string[];
}

/** A pull request, as far as the runner cares. */
export interface PullRequestSummary {
  readonly number: number;
  /** The branch the pull request comes from. */
  readonly headRefName: string;
  readonly labels: readonly string[];
  readonly comments: readonly string[];
  /**
   * When the pull request was opened — which one of a branch's is the newest.
   *
   * Absent when the read did not ask for it: the per-branch read does not need
   * to tell two pull requests of one branch apart.
   */
  readonly createdAt?: string;
}

/**
 * The arguments that read the queue: the issues a human said are specified, and
 * that nobody has claimed.
 */
export function queueArgs(repo: string): string[] {
  return [
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--label",
    QUEUE_LABEL,
    "--search",
    `-label:${CLAIM_LABEL}`,
    "--limit",
    String(ISSUE_PAGE_SIZE),
    "--json",
    "number,title,updatedAt,labels",
  ];
}

/**
 * The arguments that read the claimed issues.
 *
 * This is a **separate read** from the queue, and it has to be: the queue
 * excludes the claimed issues by construction, so a claim left behind by a run
 * that died would be invisible to every later run — and to the person trying
 * to work out what happened. Two `--label` flags mean both, not either.
 */
export function claimedArgs(repo: string): string[] {
  return [
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--label",
    QUEUE_LABEL,
    "--label",
    CLAIM_LABEL,
    "--limit",
    String(ISSUE_PAGE_SIZE),
    "--json",
    "number,title,updatedAt,labels",
  ];
}

/**
 * The arguments that read the open issues — every one of them, whatever labels it carries.
 *
 * The queue read asks for the issues a human judged specified; this one asks for
 * everything that is open, and it is the read a duplicate check needs: an issue that
 * another run is already working is not in the queue — the queue excludes the
 * claimed issues — and filing a second copy of it would be filing it twice.
 */
export function openIssuesArgs(repo: string): string[] {
  return [
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--limit",
    String(ISSUE_PAGE_SIZE),
    "--json",
    "number,title,updatedAt,labels",
  ];
}

/**
 * The arguments that read the pull request of a branch.
 *
 * `pr list`, not `pr view`: `pr view` exits 1 when the branch has no pull
 * request, and "no pull request" is the common case — the runner looks
 * before it opens one. `pr list` answers the same question with an empty
 * list and an exit code of 0.
 */
export function pullRequestArgs(repo: string, branch: string): string[] {
  return [
    "pr",
    "list",
    "--repo",
    repo,
    "--head",
    branch,
    // Open only. A pull request somebody closed or that was merged is not the
    // work's home any more: a run that found it would review a closed pull
    // request and report success, and the issue would never be worked again.
    "--state",
    "open",
    "--limit",
    "1",
    "--json",
    "number,headRefName,labels,comments",
  ];
}

/**
 * The arguments that read the merged pull request of a branch.
 *
 * The question is whether the work **landed**, and a merged pull request is
 * the answer. The state filter asks the server for it, so a branch that never
 * had a pull request, or whose pull request was closed unmerged, answers with
 * an empty list and an exit code of 0 — the same shape as "no pull request".
 *
 * The branch is the runner's own work branch, `agent/issue-<N>` (see
 * `workBranch`). The pull request keeps its head branch after the branch is
 * deleted, so a merged pull request is still found after the merge mode
 * deleted the branch.
 */
export function mergedPullRequestArgs(repo: string, issueNumber: number): string[] {
  return [
    "issue",
    "view",
    String(issueNumber),
    "--repo",
    repo,
    "--json",
    "closedByPullRequestsReferences",
  ];
}

/** Runs `gh` and returns its standard output. */
export type GhRunner = (args: readonly string[]) => Promise<string>;

/**
 * The bound a `gh` call gets.
 *
 * The same bound the git runner gives its commands: a `gh` that hangs on a
 * black-holed network must not leave the run in `select` with the host's lock
 * held. The child is killed at the bound, and the run stops waiting there
 * whether the child obeys the kill or not.
 */
export const GH_TIMEOUT_MS = COMMAND_TIMEOUT_MS;

/** A `gh` command that failed, with the reason gh gave in the message. */
export class GhCommandFailed extends Error {
  readonly exitCode: number;
  readonly stderr: string;

  constructor(exitCode: number, args: readonly string[], stderr: string) {
    const detail = stderr.trim();
    super(
      detail.length > 0
        ? `gh ${args.join(" ")} failed (${exitCode}): ${detail}`
        : `gh ${args.join(" ")} failed (${exitCode}) and said nothing`,
    );
    this.name = "GhCommandFailed";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/**
 * A `gh` command that was killed for taking too long.
 *
 * The command is named, and so is the bound: a run that stops in `select` has
 * to say which call hung, because the person looking at it has to know what to
 * look at.
 */
export class GhCommandTimedOut extends Error {
  readonly args: readonly string[];
  readonly timeoutMs: number;

  constructor(args: readonly string[], timeoutMs: number) {
    super(`gh ${args.join(" ")} timed out after ${timeoutMs}ms`);
    this.name = "GhCommandTimedOut";
    this.args = args;
    this.timeoutMs = timeoutMs;
  }
}

/** Runs the real `gh`, with the bound every command gets. */
export const runGh: GhRunner = (args) => runGhWithTimeout(args, GH_TIMEOUT_MS);

/**
 * The grace a killed `gh` gets before the run stops waiting for it.
 *
 * The child is asked to stop at the bound, and a child that obeys is gone
 * within a moment. A child that ignores the request would keep the call open
 * for as long as it likes — and a call that never settles is the wedge the
 * bound exists to prevent.
 */
export const GH_KILL_GRACE_MS = 5_000;

/**
 * The failure a `gh` call raises.
 *
 * A child that was killed is a timeout — the bound is the only thing here that
 * kills it — and a command that failed on its own terms says so in its exit
 * code and its stderr.
 */
function ghFailure(
  failure: unknown,
  args: readonly string[],
  timeoutMs: number,
): Error {
  const error = failure as { code?: number; stderr?: string; killed?: boolean };
  if (error.killed === true) {
    return new GhCommandTimedOut(args, timeoutMs);
  }
  return new GhCommandFailed(
    typeof error.code === "number" ? error.code : 1,
    args,
    error.stderr ?? "",
  );
}

/**
 * Runs the real `gh`, and kills it when it takes too long.
 *
 * The output cap stays at 32 MiB: a read that answers with more than that is
 * a read that went wrong, and a runner that died of it would say nothing.
 */
export async function runGhWithTimeout(
  args: readonly string[],
  timeoutMs: number,
  killGraceMs: number = GH_KILL_GRACE_MS,
): Promise<string> {
  const call = execFileAsync("gh", [...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeoutMs,
  })
    .then((result) => result.stdout)
    .catch((failure: unknown) => {
      throw ghFailure(failure, args, timeoutMs);
    });
  // The bound is ours as well as the child's: `execFile` asks the child to
  // stop and waits for it, and a child that ignores the request would keep
  // the call open — and the run waiting on it — for as long as it likes. The
  // run stops waiting whether the child does or not.
  let hardStop: NodeJS.Timeout | undefined;
  const stop = new Promise<never>((_resolve, reject) => {
    hardStop = setTimeout(
      () => reject(new GhCommandTimedOut(args, timeoutMs)),
      timeoutMs + killGraceMs,
    );
    hardStop.unref();
  });
  try {
    return await Promise.race([call, stop]);
  } finally {
    if (hardStop !== undefined) {
      clearTimeout(hardStop);
    }
  }
}

function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((label) => {
    if (typeof label === "string") {
      return label;
    }
    if (typeof label === "object" && label !== null && "name" in label) {
      const name = (label as { name: unknown }).name;
      return typeof name === "string" ? name : "";
    }
    return "";
  }).filter((name) => name.length > 0);
}

function commentBodies(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((comment) => {
    if (typeof comment === "string") {
      return comment;
    }
    if (typeof comment === "object" && comment !== null && "body" in comment) {
      const body = (comment as { body: unknown }).body;
      return typeof body === "string" ? body : "";
    }
    return "";
  });
}

/** Parse the JSON `gh issue list --json` produces. */
export function parseIssues(json: string): IssueSummary[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.map((issue) => {
    const record = issue as Record<string, unknown>;
    return {
      number: typeof record.number === "number" ? record.number : 0,
      title: typeof record.title === "string" ? record.title : "",
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
      labels: labelNames(record.labels),
    };
  });
}

/** Parse the JSON `gh pr view --json` produces. */
export function parsePullRequest(json: string): PullRequestSummary | null {
  return toPullRequestSummary(JSON.parse(json));
}

/** The runner's own shape of one pull request, or null when it is not one. */
function toPullRequestSummary(value: unknown): PullRequestSummary | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return {
    number: typeof record.number === "number" ? record.number : 0,
    headRefName: typeof record.headRefName === "string" ? record.headRefName : "",
    labels: labelNames(record.labels),
    comments: commentBodies(record.comments),
    ...(typeof record.createdAt === "string" ? { createdAt: record.createdAt } : {}),
  };
}

/**
 * The arguments that read every open pull request in the repository.
 *
 * One read for the whole repository, and the caller matches them by head
 * branch. `gh pr list --head <branch>` answers the same question for one
 * branch — and the runner asked it about every issue it had ever worked, so
 * the calls grew with the queue's history rather than with the work in front
 * of it.
 */
export function allOpenPullRequestsArgs(repo: string): string[] {
  return [
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--limit",
    String(ISSUE_PAGE_SIZE),
    "--json",
    "number,headRefName,labels,comments,createdAt",
  ];
}

/** Parse the JSON `gh pr list --json` produces. */
export function parsePullRequests(json: string): PullRequestSummary[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    return [];
  }
  const pullRequests: PullRequestSummary[] = [];
  for (const entry of parsed) {
    const summary = toPullRequestSummary(entry);
    if (summary !== null) {
      pullRequests.push(summary);
    }
  }
  return pullRequests;
}

/** Read every open pull request in the repository. */
export async function readAllOpenPullRequests(
  repo: string,
  gh: GhRunner = runGh,
): Promise<PullRequestSummary[]> {
  return parsePullRequests(await gh(allOpenPullRequestsArgs(repo)));
}

/** Read the issues nobody has claimed. */
export async function readQueue(repo: string, gh: GhRunner = runGh): Promise<IssueSummary[]> {
  return parseIssues(await gh(queueArgs(repo)));
}

/** Read the open issues — the duplicate check's read. */
export async function readOpenIssues(
  repo: string,
  gh: GhRunner = runGh,
): Promise<IssueSummary[]> {
  return parseIssues(await gh(openIssuesArgs(repo)));
}

/** Read the issues somebody has claimed — including a run that died holding one. */
export async function readClaimed(
  repo: string,
  gh: GhRunner = runGh,
): Promise<IssueSummary[]> {
  return parseIssues(await gh(claimedArgs(repo)));
}

/** Read one pull request, or null when the branch has none. */
export async function readPullRequest(
  repo: string,
  branch: string,
  gh: GhRunner = runGh,
): Promise<PullRequestSummary | null> {
  const parsed: unknown = JSON.parse(await gh(pullRequestArgs(repo, branch)));
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return null;
  }
  return parsePullRequest(JSON.stringify(parsed[0]));
}

/**
 * The merged pull request of a branch, or null when the work has not landed.
 *
 * A read that cannot be parsed is not a landing: the caller decides what an
 * unknown answer means, and this one raises.
 */
export async function readMergedPullRequest(
  repo: string,
  issueNumber: number,
  gh: GhRunner = runGh,
): Promise<number | null> {
  const parsed = JSON.parse(await gh(mergedPullRequestArgs(repo, issueNumber))) as {
    closedByPullRequestsReferences?: Array<{ number?: unknown }>;
  };
  const refs = parsed.closedByPullRequestsReferences;
  if (!Array.isArray(refs) || refs.length === 0) {
    return null;
  }
  const first = refs[0];
  return typeof first?.number === "number" ? first.number : null;
}

/** An open pull request, as far as the merge pipeline cares. */
export interface OpenPullRequest {
  readonly number: number;
  readonly title: string;
  /** The branch the pull request comes from. */
  readonly headRefName: string;
  readonly isDraft: boolean;
  readonly labels: readonly string[];
  readonly comments: readonly string[];
}

/**
 * The arguments that read the open pull requests against a base.
 *
 * The merge pipeline reads them all and filters by the branch prefix itself:
 * `gh` cannot be asked for a head pattern, and the branch name is where the
 * pipeline's own work is recognised.
 */
export function openPullRequestsArgs(repo: string, base: string): string[] {
  return [
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--base",
    base,
    "--limit",
    String(ISSUE_PAGE_SIZE),
    "--json",
    "number,title,headRefName,isDraft,labels,comments",
  ];
}

/** Parse the JSON `gh pr list --json` produces. */
export function parseOpenPullRequests(json: string): OpenPullRequest[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.map((entry) => {
    const record = entry as Record<string, unknown>;
    return {
      number: typeof record.number === "number" ? record.number : 0,
      title: typeof record.title === "string" ? record.title : "",
      headRefName: typeof record.headRefName === "string" ? record.headRefName : "",
      isDraft: record.isDraft === true,
      labels: labelNames(record.labels),
      comments: commentBodies(record.comments),
    };
  });
}

/** Read the open pull requests against a base. */
export async function readOpenPullRequests(
  repo: string,
  base: string,
  gh: GhRunner = runGh,
): Promise<OpenPullRequest[]> {
  return parseOpenPullRequests(await gh(openPullRequestsArgs(repo, base)));
}

/**
 * The verdict of the newest marked review comment, or null.
 *
 * The gate's own rule: the **newest** comment that opens with the marker
 * decides, a comment that states two verdicts decides nothing, and a newest
 * comment with no verdict decides nothing rather than falling back to an older
 * `pass`. A merge gate that guessed would land a change a review had blocked.
 */
export function newestReviewVerdict(
  comments: readonly string[],
): "pass" | "fail" | null {
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const body = (comments[index] ?? "").trimStart();
    if (!body.startsWith(REVIEW_MARKER)) {
      continue;
    }
    const stated = [
      ...body.matchAll(
        /^\s*\**\s*verdict\s*\**\s*:\s*\**\s*(pass|fail)\s*\**\s*\.?\s*$/gim,
      ),
    ];
    return stated.length === 1 ? (stated[0]?.[1] as "pass" | "fail") : null;
  }
  return null;
}

/**
 * The arguments that land a pull request: squash it, and remove its branch.
 *
 * `head` is the commit the run checked. With it, GitHub refuses the merge if
 * the branch moved in between — a work run pushing the same branch is not
 * excluded by any lock, so the check and the landing have to be one step.
 */
export function mergePullRequestArgs(repo: string, number: number, head?: string): string[] {
  return [
    "pr",
    "merge",
    String(number),
    "--repo",
    repo,
    "--squash",
    "--delete-branch",
    ...(head === undefined ? [] : ["--match-head-commit", head]),
  ];
}

/** Land a pull request, if its head is still the commit the run checked. */
export async function mergePullRequest(
  repo: string,
  number: number,
  head?: string,
  gh: GhRunner = runGh,
): Promise<void> {
  await gh(mergePullRequestArgs(repo, number, head));
}

/** The arguments that read one issue's body and its comments. */
export function issueArgs(repo: string, issueNumber: number): string[] {
  return [
    "issue",
    "view",
    String(issueNumber),
    "--repo",
    repo,
    "--json",
    "body,comments,title,labels,updatedAt,state",
  ];
}

/** One issue's body and its comments — where the brief lives. */
export interface IssueDetail {
  readonly title: string;
  readonly body: string;
  readonly comments: readonly string[];
  /** The issue's labels — the claim marker is one of them. */
  readonly labels: readonly string[];
  /** When the issue was last touched — the staleness signal. */
  readonly updatedAt: string;
  /** The issue's state — `OPEN` or `CLOSED`. */
  readonly state: string;
}

/**
 * Read one issue's body and its comments.
 *
 * The brief is a **comment** — the contract is the comment that opens with
 * `## Agent Brief` — so the comments matter as much as the body. Neither is
 * in the queue read, which asks only for the fields the queue needs.
 *
 * When no comment carries the marker, the brief is the **body**: the runner
 * reads it from there, because a queue that was labelled before the marker
 * was agreed carries its briefs in the bodies, and a runner that found no
 * brief would take an issue with no contract at all. See `findBrief`.
 */
export async function readIssue(
  repo: string,
  issueNumber: number,
  gh: GhRunner = runGh,
): Promise<IssueDetail> {
  const parsed: unknown = JSON.parse(await gh(issueArgs(repo, issueNumber)));
  if (typeof parsed !== "object" || parsed === null) {
    return { title: "", body: "", comments: [], labels: [], updatedAt: "", state: "" };
  }
  const record = parsed as Record<string, unknown>;
  return {
    title: typeof record.title === "string" ? record.title : "",
    body: typeof record.body === "string" ? record.body : "",
    comments: commentBodies(record.comments),
    labels: labelNames(record.labels),
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
    state: typeof record.state === "string" ? record.state : "",
  };
}

/** The arguments that create an issue. */
export function createIssueArgs(options: {
  readonly repo: string;
  readonly title: string;
  readonly body: string;
  readonly labels?: readonly string[];
}): string[] {
  const args = [
    "issue",
    "create",
    "--repo",
    options.repo,
    "--title",
    options.title,
    "--body",
    options.body,
  ];
  for (const label of options.labels ?? []) {
    args.push("--label", label);
  }
  return args;
}

/**
 * The number of an issue, from the URL `gh issue create` prints.
 */
export function issueNumberFromUrl(url: string): number | null {
  const match = /\/issues\/(\d+)/.exec(url.trim());
  return match === null ? null : Number(match[1]);
}

/** Create an issue and return its number. */
export async function createIssue(
  options: {
    readonly repo: string;
    readonly title: string;
    readonly body: string;
    readonly labels?: readonly string[];
  },
  gh: GhRunner = runGh,
): Promise<number> {
  const output = await gh(createIssueArgs(options));
  const number = issueNumberFromUrl(output.trim());
  if (number === null) {
    throw new Error(`gh did not say which issue it opened: ${output.trim()}`);
  }
  return number;
}

/** The arguments that post a comment on an issue. */
export function commentIssueArgs(
  repo: string,
  issueNumber: number,
  body: string,
): string[] {
  return ["issue", "comment", String(issueNumber), "--repo", repo, "--body", body];
}

/** Post a comment on an issue. */
export async function commentIssue(
  options: {
    readonly repo: string;
    readonly issueNumber: number;
    readonly body: string;
  },
  gh: GhRunner = runGh,
): Promise<void> {
  await gh(commentIssueArgs(options.repo, options.issueNumber, options.body));
}

/** The arguments that close an issue, with an optional comment. */
export function closeIssueArgs(
  repo: string,
  issueNumber: number,
  body?: string,
): string[] {
  return [
    "issue",
    "close",
    String(issueNumber),
    "--repo",
    repo,
    ...(body === undefined || body.trim() === "" ? [] : ["--comment", body]),
  ];
}

/** Close an issue, saying why when there is a why. */
export async function closeIssue(
  options: {
    readonly repo: string;
    readonly issueNumber: number;
    readonly body?: string;
  },
  gh: GhRunner = runGh,
): Promise<void> {
  await gh(closeIssueArgs(options.repo, options.issueNumber, options.body));
}

/**
 * The marker a line that names a dependency opens with.
 *
 * A dependency is a line the brief or the body writes as `**Depends on:** #N`
 * (or `Blocked by:` / `Parent:`). It is the runner's own convention: the
 * queue is a set of issues, and an issue that waits for another one says so in
 * the text every run already reads. A line has to start with the marker, so
 * prose that happens to mention a parent does not block the issue.
 */
export const DEPENDENCY_MARKER =
  /^(?:\*\*)?(?:depends on|blocked by|parent)(?:\*\*)?\s*:/i;

/**
 * The issue numbers a text says it waits for.
 *
 * The whole text is read — the body and every comment — because a brief may be
 * the body or a comment, and a dependency may be recorded in either.
 */
export function dependencyNumbers(texts: readonly string[]): number[] {
  const found = new Set<number>();
  for (const text of texts) {
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!DEPENDENCY_MARKER.test(line)) {
        continue;
      }
      for (const match of line.matchAll(/#(\d+)/g)) {
        const number = Number(match[1]);
        if (Number.isInteger(number) && number > 0) {
          found.add(number);
        }
      }
    }
  }
  return [...found];
}

/**
 * The body of the pull request.
 *
 * It closes the issue: `Fixes #N` is what makes GitHub close it when the
 * pull request lands, and nothing else does.
 */
export function pullRequestBody(options: {
  readonly issueNumber: number;
  readonly title: string;
  readonly summary?: string;
}): string {
  const lines: string[] = [];
  if (options.summary !== undefined && options.summary.trim() !== "") {
    lines.push(options.summary.trim(), "");
  }
  lines.push(`Fixes #${options.issueNumber}`);
  return lines.join("\n");
}

/** The arguments that open a pull request. */
export function createPullRequestArgs(options: {
  readonly repo: string;
  readonly branch: string;
  readonly title: string;
  readonly body: string;
  readonly base?: string;
}): string[] {
  return [
    "pr",
    "create",
    "--repo",
    options.repo,
    "--head",
    options.branch,
    "--base",
    options.base ?? "main",
    "--title",
    options.title,
    "--body",
    options.body,
  ];
}

/**
 * The number of a pull request, from the URL `gh pr create` prints.
 */
export function pullRequestNumberFromUrl(url: string): number | null {
  const match = /\/pull\/(\d+)/.exec(url);
  if (match === null) {
    return null;
  }
  return Number(match[1]);
}

/** Open a pull request and return its number. */
export async function createPullRequest(
  options: {
    readonly repo: string;
    readonly branch: string;
    readonly title: string;
    readonly body: string;
    readonly base?: string;
  },
  gh: GhRunner = runGh,
): Promise<number> {
  const output = await gh(createPullRequestArgs(options));
  const number = pullRequestNumberFromUrl(output.trim());
  if (number === null) {
    throw new Error(`gh did not say which pull request it opened: ${output.trim()}`);
  }
  return number;
}

/**
 * A finding that mentions a verdict is quoted, whatever shape it has.
 *
 * The gate counts the verdict lines of a comment, and a comment that states two
 * verdicts decides nothing. So the runner quotes anything that mentions a
 * verdict — **wider** than the gate's own rule on purpose. The gate's rule may
 * be widened later (`**Verdict** — pass`, a second spelling of the word), and
 * a runner that copied the rule would then fail to quote a finding that looks
 * like a verdict: the comment would state two, and the gate would say the
 * comment decides nothing. The pull request would then be red with no review
 * on it, and nothing would say why.
 */
function mentionsAVerdict(line: string): boolean {
  return line.toLowerCase().includes("verdict");
}

/**
 * The body of a review comment.
 *
 * It opens with the marker — the check wants the marker to be the first thing
 * the comment says, so a comment that quotes the format is not a review — and
 * it ends with exactly one verdict line.
 *
 * A finding that mentions a verdict is quoted, so that the comment states one
 * verdict and not two. A comment that states two decides nothing, and the
 * check says so rather than picking one.
 */
export function reviewCommentBody(options: {
  readonly verdict: "pass" | "fail";
  readonly findings?: readonly string[];
}): string {
  const findings = (options.findings ?? []).map((finding) =>
    finding
      .split("\n")
      .map((line) => (mentionsAVerdict(line) ? `> ${line}` : line))
      .join("\n"),
  );
  const lines: string[] = [REVIEW_MARKER, "## Agent review", ""];
  if (findings.length > 0) {
    lines.push(...findings, "");
  }
  lines.push(`**Verdict:** ${options.verdict}`);
  return lines.join("\n");
}

/** The arguments that post a comment on a pull request. */
export function postCommentArgs(
  repo: string,
  pullRequest: number,
  body: string,
): string[] {
  return [
    "pr",
    "comment",
    String(pullRequest),
    "--repo",
    repo,
    "--body",
    body,
  ];
}

/** The arguments that add a label to a pull request. */
export function addPullRequestLabelArgs(
  repo: string,
  pullRequest: number,
  label: string,
): string[] {
  return ["pr", "edit", String(pullRequest), "--repo", repo, "--add-label", label];
}
