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

const execFileAsync = promisify(execFile);

/** The label a human applies to say "this issue is specified and may be taken". */
export const QUEUE_LABEL = "ready-for-agent";

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
 * The queue is larger than `gh`'s default, so the default silently truncates
 * it. Five hundred is far above any queue this repository has, and the cost of
 * asking for more than you need is one request.
 */
export const QUEUE_PAGE_SIZE = 500;

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
    String(QUEUE_PAGE_SIZE),
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
    String(QUEUE_PAGE_SIZE),
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

/** Runs `gh` and returns its standard output. */
export type GhRunner = (args: readonly string[]) => Promise<string>;

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

/** Runs the real `gh`. */
export const runGh: GhRunner = async (args) => {
  try {
    const { stdout } = await execFileAsync("gh", [...args], { encoding: "utf8" });
    return stdout;
  } catch (failure) {
    const error = failure as { code?: number; stderr?: string };
    throw new GhCommandFailed(
      typeof error.code === "number" ? error.code : 1,
      args,
      error.stderr ?? "",
    );
  }
};

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
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  return {
    number: typeof record.number === "number" ? record.number : 0,
    headRefName: typeof record.headRefName === "string" ? record.headRefName : "",
    labels: labelNames(record.labels),
    comments: commentBodies(record.comments),
  };
}

/** Read the issues nobody has claimed. */
export async function readQueue(repo: string, gh: GhRunner = runGh): Promise<IssueSummary[]> {
  return parseIssues(await gh(queueArgs(repo)));
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

/** The arguments that read one issue's body and its comments. */
export function issueArgs(repo: string, issueNumber: number): string[] {
  return [
    "issue",
    "view",
    String(issueNumber),
    "--repo",
    repo,
    "--json",
    "body,comments,title,labels,updatedAt",
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
    return { title: "", body: "", comments: [], labels: [], updatedAt: "" };
  }
  const record = parsed as Record<string, unknown>;
  return {
    title: typeof record.title === "string" ? record.title : "",
    body: typeof record.body === "string" ? record.body : "",
    comments: commentBodies(record.comments),
    labels: labelNames(record.labels),
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
  };
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
