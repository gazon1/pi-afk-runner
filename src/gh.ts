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

/** The arguments that read one pull request, with its labels and its comments. */
export function pullRequestArgs(repo: string, branch: string): string[] {
  return [
    "pr",
    "view",
    branch,
    "--repo",
    repo,
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
  const json = await gh(pullRequestArgs(repo, branch));
  return parsePullRequest(json);
}
