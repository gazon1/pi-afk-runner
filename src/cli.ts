#!/usr/bin/env node

/**
 * The unattended runner.
 *
 * One invocation: take the lock, work one issue — or, with `--all`, every
 * eligible issue one after another — write the record, give the lock back.
 * The exit code says which step the run reached, because a scheduler has
 * nothing else to read — a systemd unit sees a number, and a number that says
 * "the session" is worth a great deal more than a number that says "1".
 *
 * | Code | What it says |
 * |---|---|
 * | 0 | the run finished, or the queue was empty |
 * | 10..80 | the step the run stopped at — see `STEP_EXIT_CODES` |
 * | 75 | another runner holds the lock |
 * | 76 | the lock could not be taken |
 * | 2 | the command line was wrong |
 *
 * The work pipeline never merges. A pull request it opens stays open, and a
 * human closes it. `--merge` is the explicit exception: a separate, opt-in
 * mode that lands the reviewed, green pull requests the work pipeline opened.
 */

import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { EnvHttpProxyAgent, fetch as undiciFetch, setGlobalDispatcher } from "undici";

import { DEFAULT_DEADLINE_MS } from "./budget.js";
import { readClaimed, readQueue, runGh, type GhRunner } from "./gh.js";
import { runCommand, runGit, type CommandRunner, type GitRunner } from "./git.js";
import { LockHeld, LockUnusable, lockNameFor, takeLock, workLockName } from "./lock.js";
import {
  mergeReviewedPullRequests,
  type MergeOptions,
  type MergeResult,
} from "./merge.js";
import {
  RunFailed,
  emptyQueueSentence,
  runOnce,
  type RunOptions,
  type RunResult,
} from "./runner.js";
import {
  addUsage,
  type AgentSession,
  type RunUsage,
  type SessionFactory,
} from "./session.js";

/** The run finished, or the queue was empty. */
export const EXIT_OK = 0;

/** The command line was wrong. */
export const EXIT_USAGE = 2;

/** Another runner holds the lock. */
export const EXIT_LOCKED = 75;

/** The lock could not be taken. */
export const EXIT_NO_LOCK = 76;

/**
 * The exit code for each step — the code says which step the run reached.
 *
 * The numbers are spaced so that a reader can tell them apart at a glance in
 * a journal, and so that a step can be added without renumbering the rest.
 */
export const STEP_EXIT_CODES: Readonly<Record<string, number>> = {
  select: 10,
  claim: 20,
  worktree: 30,
  session: 40,
  gates: 45,
  push: 50,
  "pull request": 60,
  review: 70,
  "re-count": 80,
};

/** A week — how long a claim may sit before another run may take it over. */
export const DEFAULT_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The wall-clock ceiling on the run.
 *
 * The budget is shared by the work session, the gates and the review session:
 * each keeps a share of it, and none of them may exceed its share. The shares
 * and the default that adds them up live in `src/budget.ts`.
 */
export { DEFAULT_DEADLINE_MS };

/** What the command line says. */
export interface CliOptions {
  /**
   * The repository the issue lives in — `owner/name`.
   *
   * Optional: a run started in the repository it works asks the checkout's
   * `origin` instead. See {@link resolveRepo}.
   */
  readonly repo?: string;
  /** The issue to work. The queue's first eligible one when it is absent. */
  readonly issue?: number;
  /** Work every eligible issue, one after another. Not with `--issue`. */
  readonly all?: boolean;
  /** Land the reviewed, green pull requests the work pipeline opened. */
  readonly merge?: boolean;
  /** The checkout the worktree is made from. */
  readonly checkout: string;
  /** The remote the base comes from. */
  readonly remote: string;
  /** The branch the base is read from. */
  readonly baseBranch: string;
  /** Where the lock lives. */
  readonly lockDirectory: string;
  /** Where the worktrees are created. */
  readonly worktreeRoot: string;
  /** The model the agent runs on — `provider/id`. */
  readonly model?: string;
  /** Whether the target repository's pre-push hook may gate the pushes. */
  readonly verifyPushes?: boolean;
  /** Whether to look for related issues and work them in one batch. */
  readonly batchRelated?: boolean;
  /** The wall-clock ceiling on one turn of the agent. */
  readonly deadlineMs: number;
  /** How long a claim may sit before another run may take it over. */
  readonly staleAfterMs: number;
}

/** The usage the command prints when it is asked or when it is wrong. */
export const USAGE = [
  "pi-afk-runner — work one issue from the queue and open a reviewed pull request",
  "",
  "  pi-afk-runner [options]",
  "",
  "  --repo <owner/name>    the repository the issue lives in (default: the checkout's origin)",
  "  --issue <number>        the issue to work (default: the queue's first eligible one)",
  "  --all                   work every eligible issue, one after another",
  "  --merge                 land the reviewed, green pull requests the runner opened",
  "  --checkout <path>       the checkout the worktree is made from (default: the cwd)",
  "  --remote <name>         the remote the base comes from (default: origin)",
  "  --base <branch>         the branch the base is read from (default: main)",
  "  --lock-dir <path>       where the lock lives (default: <checkout>/build/afk-runner)",
  "  --worktree-root <path>  where the worktrees are created (default: <checkout>/../afk-worktrees)",
  "  --model <provider/id>   the model the agent runs on (default: the provider's first)",
  "  --no-verify             skip the target repository's pre-push hook when pushing",
  "  --batch-related         look for related ready-for-agent issues and work them in one batch",
  `  --deadline-ms <n>       the ceiling on the run (default: ${DEFAULT_DEADLINE_MS})`,
  "  --stale-after-ms <n>    how long a claim may sit (default: 604800000 — a week)",
  "  --help                  this text",
].join("\n");

/** The message of a failure, whatever it was thrown as. */
export function errorMessage(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/**
 * Read the command line.
 *
 * The options are read the way a scheduler sets them: long names, one value
 * each. There is no short form and no bundling, because a systemd unit is
 * read by a person at three in the morning.
 */
export function parseArgs(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  let repo: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (!argument.startsWith("--")) {
      throw new Error(`unexpected argument: ${argument}`);
    }
    const name = argument.slice(2);
    if (name === "help") {
      throw new Error("help");
    }
    if (name === "no-verify" || name === "all" || name === "merge" || name === "batch-related") {
      // A flag, not an option with a value.
      values.set(name, "true");
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`the option --${name} needs a value`);
    }
    values.set(name, value);
    index += 1;
  }

  repo = values.get("repo");
  if (repo !== undefined && !repo.includes("/")) {
    throw new Error("--repo must name a repository, as owner/name");
  }

  const issue = values.get("issue");
  const all = values.has("all");
  const merge = values.has("merge");
  if (all && issue !== undefined) {
    throw new Error("--all works every issue, so it cannot be combined with --issue");
  }
  if (merge && (all || issue !== undefined)) {
    throw new Error("--merge is its own mode; it cannot be combined with --all or --issue");
  }
  const checkout = resolve(values.get("checkout") ?? process.cwd());
  const remote = values.get("remote") ?? "origin";
  const baseBranch = values.get("base") ?? "main";
  const lockDirectory =
    values.get("lock-dir") ?? join(checkout, "build", "afk-runner");
  const worktreeRoot =
    values.get("worktree-root") ?? join(dirname(checkout), "afk-worktrees");
  const model = values.get("model");
  const noVerify = values.has("no-verify");
  const batchRelated = values.has("batch-related");
  const deadlineMs = number(values.get("deadline-ms"), DEFAULT_DEADLINE_MS, "--deadline-ms");
  const staleAfterMs = number(values.get("stale-after-ms"), DEFAULT_STALE_AFTER_MS, "--stale-after-ms");

  return {
    ...(repo === undefined ? {} : { repo }),
    ...(issue === undefined ? {} : { issue: positiveNumber(issue, "--issue") }),
    ...(all ? { all: true } : {}),
    ...(merge ? { merge: true } : {}),
    checkout,
    remote,
    baseBranch,
    lockDirectory,
    worktreeRoot,
    ...(model === undefined ? {} : { model }),
    ...(noVerify ? { verifyPushes: false } : {}),
    ...(batchRelated ? { batchRelated: true } : {}),
    deadlineMs,
    staleAfterMs,
  };
}

/**
 * `owner/name` from a remote URL, or null.
 *
 * The forms git writes into `.git/config`: `git@github.com:owner/name.git`,
 * `ssh://git@github.com/owner/name`, and `https://github.com/owner/name.git`.
 */
export function repoFromRemoteUrl(url: string): string | null {
  const match =
    /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?[^/:]+[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(
      url.trim(),
    );
  return match?.[1] !== undefined && match[2] !== undefined
    ? `${match[1]}/${match[2]}`
    : null;
}

/**
 * The repository the issue lives in.
 *
 * `--repo` wins. Without it the checkout's `origin` is asked, because a run
 * started in the repository it works should not have to name it twice.
 */
export async function resolveRepo(
  options: CliOptions,
  git: GitRunner = runGit,
): Promise<CliOptions & { readonly repo: string }> {
  if (options.repo !== undefined) {
    return { ...options, repo: options.repo };
  }
  const remote = (await git(["remote", "get-url", options.remote], { cwd: options.checkout })).trim();
  const repo = repoFromRemoteUrl(remote);
  if (repo === null) {
    throw new Error(
      `--repo was not given, and the checkout's ${options.remote} (${remote === "" ? "no remote" : remote}) ` +
        `does not name a repository as owner/name`,
    );
  }
  return { ...options, repo };
}

/** Read a whole number, or say that it is not one. */
function positiveNumber(raw: string, name: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a number`);
  }
  return parsed;
}

/** Read a number, or say that the number is not one. */
function number(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a number of milliseconds`);
  }
  return parsed;
}

/**
 * Route the session's HTTP through the proxy, when there is one.
 *
 * The SDK installs its own dispatcher, and that one does not read the
 * environment: a provider that is only reachable through a proxy — which is
 * the usual case for a self-hosted or regional API — is simply unreachable,
 * and the request dies at the SDK's timeout with nothing in the log to say
 * why. So the runner installs a dispatcher that reads `HTTPS_PROXY` and
 * friends, and the fetch that goes with it.
 *
 * Nothing happens when no proxy is configured: a host that reaches its
 * provider directly keeps the SDK's own dispatcher.
 */
export function useProxyFromEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  const proxy = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy;
  if (proxy === undefined || proxy === "") {
    return false;
  }
  setGlobalDispatcher(new EnvHttpProxyAgent());
  globalThis.fetch = undiciFetch as typeof globalThis.fetch;
  return true;
}

/**
 * The run the command gives the runner.
 *
 * Everything here comes from the command line or from the injected dependencies;
 * the callbacks — how a run reports itself — are added by the caller. One map,
 * because two maps of thirteen fields drift the first time a flag is added.
 */
export function runOptionsFrom(
  options: CliOptions & { readonly repo: string },
  session: SessionFactory,
  dependencies: CliDependencies = {},
): RunOptions {
  return {
    repo: options.repo,
    ...(options.issue === undefined ? {} : { issueNumber: options.issue }),
    checkout: options.checkout,
    remote: options.remote,
    baseBranch: options.baseBranch,
    worktreeRoot: options.worktreeRoot,
    git: dependencies.git ?? runGit,
    gh: dependencies.gh ?? runGh,
    run: dependencies.run ?? runCommand,
    session,
    deadlineMs: options.deadlineMs,
    staleAfterMs: options.staleAfterMs,
    ...(options.verifyPushes === undefined ? {} : { verifyPushes: options.verifyPushes }),
    ...(options.batchRelated === undefined ? {} : { batchRelated: options.batchRelated }),
    // A named issue took its lock before the run read anything. A run that lets
    // the queue choose does not know the issue until it has chosen it, so the
    // lock is taken inside the run — one issue at a time, even in a sweep.
    ...(options.issue === undefined
      ? { lockIssue: (issue: number) => takeLock(options.lockDirectory, workLockName(issue)) }
      : {}),
  };
}

/** What the command runs against — the parts a test replaces. */
export interface CliDependencies {
  readonly git?: GitRunner;
  readonly gh?: GhRunner;
  readonly run?: CommandRunner;
  readonly session?: SessionFactory;
  readonly lock?: (directory: string, name: string) => Promise<Awaited<ReturnType<typeof takeLock>>>;
}

/**
 * Prepare one run: parse the command, resolve the repository, take the lock.
 *
 * The one place the three steps live. The CLI and the live door call it and
 * keep their own way of reporting a failure.
 */
export async function prepareRun(
  argv: readonly string[],
  dependencies: CliDependencies = {},
): Promise<
  | { readonly ok: true; readonly options: CliOptions & { readonly repo: string }; readonly lock: Awaited<ReturnType<typeof takeLock>> }
  | { readonly ok: false; readonly failure: unknown }
> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (failure) {
    return { ok: false, failure };
  }

  let resolved: CliOptions & { readonly repo: string };
  try {
    resolved = await resolveRepo(options, dependencies.git ?? runGit);
  } catch (failure) {
    return { ok: false, failure };
  }

  const take = dependencies.lock ?? takeLock;
  try {
    const lock = await take(resolved.lockDirectory, lockNameFor(resolved));
    return { ok: true, options: resolved, lock };
  } catch (failure) {
    return { ok: false, failure };
  }
}

/**
 * A duration, as a reader reads it.
 *
 * The seconds are always there: a duration without them is a duration a
 * reader has to guess at. The larger units come when they are worth saying —
 * a run that took hours is a run that says so.
 */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${rest}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${rest}s`;
  }
  return `${rest}s`;
}

/**
 * A cost, as money.
 *
 * A cost under a cent keeps its digits: rounded to two decimals it would
 * read as zero, and zero is a number a reader would trust.
 */
export function formatCost(cost: number): string {
  if (Math.abs(cost) < 0.01) {
    return `$${cost.toFixed(6)}`;
  }
  return `$${cost.toFixed(2)}`;
}

/**
 * The lines that say what a run did.
 *
 * **One fact per line.** A journal reads lines, and a table wraps: a summary
 * a terminal folds is a summary a pipe cannot be read out of. So there is no
 * table here — the lines are the facts, and a pipe gets the same lines a
 * terminal does.
 *
 * The tokens and the cost are **absent** when the provider reported none: a
 * zero is a number, and a number a reader would trust.
 */
export function runSummary(result: RunResult): string[] {
  const lines: string[] = [];
  const title = result.title ?? "";
  lines.push(title === "" ? `issue ${result.issue}` : `issue ${result.issue} — ${title}`);
  if (result.pullRequest !== undefined) {
    lines.push(`pull request: #${result.pullRequest}`);
  }
  lines.push(`review: ${result.verdict ?? "none"}`);
  if (result.durationMs !== undefined) {
    lines.push(`duration: ${formatDuration(result.durationMs)}`);
  }
  if (result.usage !== undefined) {
    lines.push(`tokens: ${result.usage.totalTokens}`);
    if (result.usage.cost !== undefined) {
      lines.push(`cost: ${formatCost(result.usage.cost)}`);
    }
  }
  if (result.record !== "") {
    lines.push(`record: ${result.record}`);
  }
  return lines;
}

/**
 * The one line a sweep says about an issue.
 *
 * A sweep is a journal: one line per issue, in the order the issues were
 * worked. The facts are the run's own, separated so that a reader — or a
 * pipe — can take them one at a time.
 */
export function sweepIssueLine(result: RunResult): string {
  const parts: string[] = [`issue ${result.issue}`];
  const title = result.title ?? "";
  if (title !== "") {
    parts.push(title);
  }
  if (result.pullRequest !== undefined) {
    parts.push(`pr #${result.pullRequest}`);
  }
  parts.push(`review ${result.verdict ?? "none"}`);
  if (result.durationMs !== undefined) {
    parts.push(formatDuration(result.durationMs));
  }
  if (result.usage !== undefined) {
    parts.push(`${result.usage.totalTokens} tokens`);
    if (result.usage.cost !== undefined) {
      parts.push(formatCost(result.usage.cost));
    }
  }
  if (result.record !== "") {
    parts.push(`record ${result.record}`);
  }
  return parts.join(" — ");
}

/**
 * The line that says what a sweep did in all.
 *
 * The tokens and the cost are the sweep's own — the sum of what the issues
 * cost — and they are absent when none of them reported any.
 */
export function sweepTotal(
  results: readonly RunResult[],
  issues: number,
): string {
  const parts = [`total: ${results.length} of ${issues} issues worked`];
  const duration = results.reduce((sum, result) => sum + (result.durationMs ?? 0), 0);
  parts.push(formatDuration(duration));
  const usage = results.reduce<RunUsage | undefined>(
    (sum, result) => addUsage(sum, result.usage),
    undefined,
  );
  if (usage !== undefined) {
    parts.push(`${usage.totalTokens} tokens`);
    if (usage.cost !== undefined) {
      parts.push(formatCost(usage.cost));
    }
  }
  return parts.join(" — ");
}

/**
 * Run once, and say what happened through the exit code.
 *
 * One issue, or the whole queue with `--all`. The lock is taken for the whole
 * invocation and given back whatever happens — a runner that died holding it
 * would keep the next one out for ever, and a runner that gave it back too
 * early would let two of them work at once. Work on a named issue takes the
 * issue's own lock, so two issues can be worked on one host at once; a merge
 * takes its own and never waits for a work run.
 */
export async function main(
  argv: readonly string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const prepared = await prepareRun(argv, dependencies);
  if (!prepared.ok) {
    const failure = prepared.failure;
    const message = errorMessage(failure);
    if (message === "help") {
      process.stdout.write(`${USAGE}\n`);
      return EXIT_OK;
    }
    // parseArgs errors are usage errors
    if (failure instanceof LockHeld) {
      process.stderr.write(`${failure.message}\n`);
      return EXIT_LOCKED;
    }
    if (failure instanceof LockUnusable) {
      process.stderr.write(`${failure.message}\n`);
      return EXIT_NO_LOCK;
    }
    // distinguish: if from parseArgs, message+usage; else just message
    // We can't easily know; check if message matches? Keep simple: usage-style for parse errors.
    // Heuristic: LockHeld/Unusable handled; resolve errors print message only.
    // For parse errors, print usage. Detect by trying parseArgs again.
    let isUsage = false;
    try { parseArgs(argv); } catch { isUsage = true; }
    if (isUsage) {
      process.stderr.write(`${message}\n\n${USAGE}\n`);
      return EXIT_USAGE;
    }
    process.stderr.write(`${message}\n`);
    // Could be resolveRepo failure -> usage per original
    // Original treated resolveRepo as EXIT_USAGE. Keep:
    // But we already returned? Need mark. We'll handle below by checking if resolved? 
    return EXIT_USAGE;
  }
  const resolved = prepared.options;
  const lock = prepared.lock;

  // A killed process cannot run the release step, and a claim nobody is working
  // is an issue nobody can take. The signal becomes the stop the deadline already
  // uses: the session is aborted, its step fails, and the failure path releases.
  let stopped = false;
  let active: AgentSession | null = null;
  const interrupt = (): void => {
    if (stopped) {
      // A second signal is somebody insisting; the release is best effort.
      process.exit(130);
    }
    stopped = true;
    void active?.abort().catch(() => {});
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);

  const say = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };

  // The provider is reached through the proxy when there is one — the SDK's own
  // dispatcher does not read the environment.
  useProxyFromEnvironment();

  // The engine is Mastra, and its module is loaded only when a session is
  // asked for, so a run that never starts one does not pay for it.
  let mastra: SessionFactory | undefined;
  const base: SessionFactory =
    dependencies.session ??
    (async (options) => {
      if (mastra === undefined) {
        const { mastraSessionFactory } = await import("./mastra/session.js");
        mastra = mastraSessionFactory({
          ...(resolved.model === undefined ? {} : { model: resolved.model }),
          onEvent: say,
        });
      }
      return mastra(options);
    });
  const session: SessionFactory = async (options) => {
    const created = await base(options);
    active = created;
    return created;
  };

  const run: RunOptions = {
    ...runOptionsFrom(resolved, session, dependencies),
    onStep: (record) => {
      const detail = record.detail === "" ? "" : ` — ${record.detail}`;
      process.stdout.write(`[${record.step}] ${record.outcome}${detail}\n`);
    },
    stopped: () => stopped,
  };

  try {
    if (resolved.merge === true) {
      return await mergeAll({
        repo: resolved.repo,
        checkout: resolved.checkout,
        remote: resolved.remote,
        baseBranch: resolved.baseBranch,
        worktreeRoot: resolved.worktreeRoot,
        git: dependencies.git ?? runGit,
        gh: dependencies.gh ?? runGh,
        run: dependencies.run ?? runCommand,
        session,
        deadlineMs: resolved.deadlineMs,
        ...(resolved.verifyPushes === undefined
          ? {}
          : { verifyPushes: resolved.verifyPushes }),
        stopped: () => stopped,
        onStepStart: (step) => {
          process.stdout.write(`[${step}] start\n`);
        },
        onStep: (record) => {
          const detail = record.detail === "" ? "" : ` — ${record.detail}`;
          process.stdout.write(`[${record.step}] ${record.outcome}${detail}\n`);
        },
        onSubject: (subject) => {
          process.stdout.write(
            `pull request #${subject.pullRequest} · ${subject.title}\n`,
          );
        },
      });
    }
    if (resolved.all === true) {
      return await sweep(run, resolved.repo);
    }
    const outcome = await work(run, resolved.issue);
    if (outcome.result !== undefined) {
      process.stdout.write(`${runSummary(outcome.result).join("\n")}\n`);
    }
    return outcome.code;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    await lock.release();
  }
}

/**
 * Work every eligible issue, one after another.
 *
 * The list is read once and worked **by number**, so an issue that fails
 * cannot put itself back at the front of the queue and end the sweep in a
 * spin. The claimed issues are read as well: a claim a killed sweep left
 * behind is not in the queue, and taking it over is the only thing that will
 * ever free it. Duplicates are dropped, so no issue is worked twice.
 *
 * The lock belongs to the caller and is held for the whole sweep. An issue
 * that is not worked counts against the sweep, so the code never says the
 * queue was drained while an issue was left in it.
 */
async function sweep(runOptions: RunOptions, repo: string): Promise<number> {
  let issues: readonly { readonly number: number }[];
  try {
    issues = [
      ...(await readClaimed(repo, runOptions.gh)),
      ...(await readQueue(repo, runOptions.gh)),
    ];
  } catch (failure) {
    process.stderr.write(`${errorMessage(failure)}\n`);
    return STEP_EXIT_CODES.select ?? 1;
  }

  const numbers = [...new Set(issues.map((issue) => issue.number))];
  if (numbers.length === 0) {
    process.stdout.write(`${emptyQueueSentence()}\n`);
    return EXIT_OK;
  }

  let firstFailure = 0;
  let stoppedEarly = false;
  const results: RunResult[] = [];
  for (const issueNumber of numbers) {
    // A human who stopped the run stopped the sweep, not one issue of it.
    if (runOptions.stopped?.() === true) {
      stoppedEarly = true;
      break;
    }
    const outcome = await work({ ...runOptions, issueNumber }, issueNumber);
    if (outcome.result !== undefined) {
      // One line per issue: a sweep is a journal.
      results.push(outcome.result);
      process.stdout.write(`${sweepIssueLine(outcome.result)}\n`);
    }
    if (outcome.code !== EXIT_OK && firstFailure === 0) {
      firstFailure = outcome.code;
    }
  }
  process.stdout.write(`${sweepTotal(results, numbers.length)}\n`);
  // Issues were left in the queue, so this is not the success the zero would
  // claim; a stop that did not fail a step reports the code a cut session has.
  if (stoppedEarly && firstFailure === 0) {
    return STEP_EXIT_CODES.session ?? 1;
  }
  return firstFailure;
}

/** What one issue's run did, and what it says about it. */
interface WorkOutcome {
  /** The exit code the run reached. */
  readonly code: number;
  /** The result of a run that finished, when there was one. */
  readonly result?: RunResult;
}

/** Work one issue, and say what happened through the exit code. */
async function work(
  runOptions: RunOptions,
  namedIssue: number | undefined,
): Promise<WorkOutcome> {
  try {
    const result = await runOnce(runOptions);
    if (result.outcome === "empty") {
      process.stdout.write(`${emptyQueueSentence()}\n`);
      return { code: EXIT_OK };
    }
    if (result.outcome === "unworkable") {
      const issueNum = result.issue ?? namedIssue;
      process.stderr.write(
        `issue ${issueNum} could not be worked — ${result.reason}\n`,
      );
      return { code: 1 };
    }
    if (result.outcome === "skipped" || result.outcome === "split") {
      const what =
        result.outcome === "skipped"
          ? "closed as not needed"
          : "split into smaller issues";
      const why = result.reason === "" ? "" : ` — ${result.reason}`;
      process.stdout.write(`issue ${result.issue} was ${what}${why}\n`);
      return { code: EXIT_OK };
    }
    // The run finished: the caller says what it did.
    return { code: EXIT_OK, result };
  } catch (failure) {
    if (failure instanceof LockHeld) {
      process.stderr.write(`${failure.message}\n`);
      return { code: EXIT_LOCKED };
    }
    if (failure instanceof LockUnusable) {
      process.stderr.write(`${failure.message}\n`);
      return { code: EXIT_NO_LOCK };
    }
    if (failure instanceof RunFailed) {
      process.stderr.write(`${failure.message}\n`);
      return { code: STEP_EXIT_CODES[failure.step] ?? 1 };
    }
    process.stderr.write(`${errorMessage(failure)}\n`);
    return { code: 1 };
  }
}

/**
 * Land the reviewed pull requests, and say what happened.
 *
 * A skipped pull request is not a failure: it is one the review or the CI has
 * not cleared yet, and the next run reads it again. A step that stopped is a
 * failure, and the name of the step is where a reader starts.
 */
async function mergeAll(options: MergeOptions): Promise<number> {
  let result: MergeResult;
  try {
    result = await mergeReviewedPullRequests(options);
  } catch (failure) {
    process.stderr.write(`the merge could not start: ${errorMessage(failure)}\n`);
    return 1;
  }

  for (const number of result.merged) {
    process.stdout.write(`merged #${number}\n`);
  }
  for (const entry of result.skipped) {
    process.stdout.write(`left #${entry.pullRequest} alone — ${entry.reason}\n`);
  }
  for (const entry of result.failed) {
    process.stderr.write(
      `pull request ${entry.pullRequest} stopped at the ${entry.step} step: ${entry.message}\n`,
    );
  }
  return result.failed.length === 0 ? EXIT_OK : 1;
}

/** Run the command, when this file is the program that was started. */
const startedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (startedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (failure: unknown) => {
      process.stderr.write(`${errorMessage(failure)}\n`);
      process.exitCode = 1;
    },
  );
}
