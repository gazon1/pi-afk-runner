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

import { AsyncLocalStorage } from "node:async_hooks";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { defineCommand, parseArgs as parseCittyArgs, renderUsage, type ArgsDef } from "citty";
import { EnvHttpProxyAgent, fetch as undiciFetch, setGlobalDispatcher } from "undici";

import { DEFAULT_DEADLINE_MS, defaultDeadlineMs } from "./budget.js";
import { readGateSettings, resolveGateSettings, type GateSettings } from "./gates.js";
import { readClaimed, readQueue, runGh, type GhRunner } from "./gh.js";
import { runCommand, runGit, type CommandRunner, type GitRunner } from "./git.js";
import { LockHeld, LockUnusable, lockNameFor, takeLock, workLockName } from "./lock.js";
import {
  NoModelAvailable,
  describePool,
  knownModel,
  newPoolState,
  pickPoolModel,
  poolFile,
  readPool,
  type Pool,
  type PoolState,
} from "./pool.js";
import { PoolSession, poolEventChannel, type PoolHost } from "./pool-session.js";
import { proxyFromEnvironment } from "./proxy.js";
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
  type TurnMessage,
} from "./session.js";

/** The run finished, or the queue was empty. */
export const EXIT_OK = 0;

/** The command line was wrong. */
export const EXIT_USAGE = 2;

/**
 * No model could be used.
 *
 * Every model in the pool is at its peak tariff, has run out of its limit, or
 * cannot be reached. The run stops there — the work is left in the queue for
 * the next run, and the sweep stops rather than failing every issue in it.
 */
export const EXIT_NO_MODEL = 3;

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
  /**
   * How many issues a sweep works at once.
   *
   * Absent when the command did not name it: a sweep then works one issue at a
   * time, the way it always has. The issues are still worked one by one — each
   * one to the end of its journey — but several of them are in flight at once.
   */
  readonly workers?: number;
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
  /** Where the host's own files live — the pool file is looked for there. */
  readonly agentDirectory: string;
  /** The model pool — the file the models and their conditions are read from. */
  readonly pool?: string;
  /** Whether to print what the pool file means now, and run nothing. */
  readonly showPool?: boolean;
  /** Whether the target repository's pre-push hook may gate the pushes. */
  readonly verifyPushes?: boolean;
  /** Whether to look for related issues and work them in one batch. */
  readonly batchRelated?: boolean;
  /**
   * The wall-clock ceiling on one turn of the agent.
   *
   * Absent when the command did not name one: the ceiling then follows the
   * gates the run runs, and a run with fewer gates does not carry the budget
   * of a run with more.
   */
  readonly deadlineMs?: number;
  /** How long a claim may sit before another run may take it over. */
  readonly staleAfterMs?: number;
  /**
   * The gates to run, when the command names them.
   *
   * The command's list replaces the repository's own, and a run that names
   * neither runs no gate at all: a run started by hand says what it runs.
   */
  readonly gates?: readonly string[];
  /** How long one gate may take, in milliseconds. */
  readonly gateTimeoutMs?: number;
}

/**
 * Where the host's own files live.
 *
 * The pool file is the host's, and it lives in the host's own directory —
 * beside the settings and the credentials it belongs to. `--agent-dir` names
 * another one, and `--pool` names the file itself.
 */
export function defaultAgentDirectory(): string {
  return join(homedir(), ".pi", "agent");
}

/** The message of a failure, whatever it was thrown as. */
export function errorMessage(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/**
 * The issue the line being written belongs to.
 *
 * A sweep that works several issues at once writes them all to one stream, and
 * a line that does not say which issue it is about is a line nobody can read.
 * The context travels with the run, so the line is written where it belongs.
 */
const issueContext = new AsyncLocalStorage<number>();

/**
 * The line as the reader sees it: it names the issue it belongs to.
 *
 * A sweep with one worker names nothing — the lines were never mixed, and the
 * journal looks the way it always has.
 */
function tagged(text: string): string {
  const issue = issueContext.getStore();
  return issue === undefined ? text : `issue ${issue} — ${text}`;
}

/**
 * The run of one issue, in the context that names it.
 *
 * One worker at a time needs no context: nothing else is writing to the
 * stream, so a line that does not name its issue is still a line a reader can
 * place.
 */
async function inIssue<T>(issue: number, workers: number, run: () => Promise<T>): Promise<T> {
  return workers > 1 ? issueContext.run(issue, run) : run();
}

/**
 * The options the command reads, as citty reads them.
 *
 * One list: the command line, the usage and the runner's own options are the
 * same list, and a flag that is written down twice is a flag whose two copies
 * drift.
 */
export const ARGS = {
  repo: { type: "string", description: "the repository the issue lives in (default: the checkout's origin)" },
  issue: { type: "string", description: "the issue to work (default: the queue's first eligible one)" },
  all: { type: "boolean", description: "work every eligible issue, one after another" },
  workers: { type: "string", description: "how many issues --all works at once (default: 1)" },
  merge: { type: "boolean", description: "land the reviewed, green pull requests the runner opened" },
  checkout: { type: "string", description: "the checkout the worktree is made from (default: the cwd)" },
  remote: { type: "string", description: "the remote the base comes from (default: origin)" },
  base: { type: "string", description: "the branch the base is read from (default: main)" },
  "lock-dir": { type: "string", description: "where the lock lives (default: <checkout>/build/afk-runner)" },
  "worktree-root": { type: "string", description: "where the worktrees are created (default: <checkout>/../afk-worktrees)" },
  model: { type: "string", description: "the model the agent runs on (default: the pool's best model)" },
  "agent-dir": { type: "string", description: "the host's own directory (default: ~/.pi/agent)" },
  pool: { type: "string", description: "the model pool file (default: <agent-dir>/models.yaml)" },
  "show-pool": { type: "boolean", description: "print what the pool file means now, and run nothing" },
  "no-verify": { type: "boolean", description: "skip the target repository's pre-push hook when pushing" },
  "batch-related": { type: "boolean", description: "look for related ready-for-agent issues and work them in one batch" },
  gate: { type: "string", description: "the gates to run, separated by commas — they replace the repository's own list" },
  "gate-timeout-ms": { type: "string", description: "how long one gate may take (default: 3600000)" },
  "deadline-ms": { type: "string", description: "the ceiling on the run (default: the three shares, added up)" },
  "stale-after-ms": { type: "string", description: "how long a claim may sit (default: 604800000 — a week)" },
} as const satisfies ArgsDef;

/**
 * The command, as citty holds it.
 *
 * The command has no `run`: the run belongs to {@link main}, which owns the
 * exit code — a scheduler reads a number, and a number a library invents is a
 * number nobody agreed on.
 */
export const command = defineCommand({
  meta: {
    name: "pi-afk-runner",
    description: "work one issue from the queue and open a reviewed pull request",
  },
  args: ARGS,
});

/** The usage the command prints when it is asked or when it is wrong. */
export async function usage(): Promise<string> {
  return renderUsage(command);
}

/**
 * The options the command reads.
 *
 * The options are read the way a scheduler sets them: long names, one value
 * each. There is no short form and no bundling, because a systemd unit is
 * read by a person at three in the morning.
 */
export function parseArgs(argv: readonly string[]): CliOptions {
  if (argv.includes("--help")) {
    throw new Error("help");
  }
  rejectUnknownOptions(argv);
  rejectRepeatedGate(argv);
  const parsed = parseCittyArgs([...argv], ARGS) as Record<string, unknown>;

  const repo = text(parsed["repo"]);
  if (repo !== undefined && !repo.includes("/")) {
    throw new Error("--repo must name a repository, as owner/name");
  }

  const issueText = text(parsed["issue"]);
  const issue = issueText === undefined ? undefined : positiveNumber(issueText, "--issue");
  const all = parsed["all"] === true;
  const merge = parsed["merge"] === true;
  if (all && issue !== undefined) {
    throw new Error("--all works every issue, so it cannot be combined with --issue");
  }
  if (merge && (all || issue !== undefined)) {
    throw new Error("--merge is its own mode; it cannot be combined with --all or --issue");
  }
  const workersText = text(parsed["workers"]);
  const workers = workersText === undefined ? undefined : positiveNumber(workersText, "--workers");
  if (workers !== undefined && !all) {
    throw new Error("--workers works the whole queue, so it needs --all");
  }
  const checkout = resolve(text(parsed["checkout"]) ?? process.cwd());
  const remote = text(parsed["remote"]) ?? "origin";
  const baseBranch = text(parsed["base"]) ?? "main";
  const lockDirectory = text(parsed["lock-dir"]) ?? join(checkout, "build", "afk-runner");
  const worktreeRoot =
    text(parsed["worktree-root"]) ?? join(dirname(checkout), "afk-worktrees");
  const model = text(parsed["model"]);
  const agentDirectory = text(parsed["agent-dir"]) ?? defaultAgentDirectory();
  const pool = text(parsed["pool"]);
  const showPool = parsed["show-pool"] === true;
  const noVerify = parsed["no-verify"] === true;
  const batchRelated = parsed["batch-related"] === true;
  const deadlineMs = number(text(parsed["deadline-ms"]), undefined, "--deadline-ms");
  const staleAfterMs = number(text(parsed["stale-after-ms"]), undefined, "--stale-after-ms");
  const gates = list(parsed["gate"], "--gate");
  const gateTimeoutMs = number(text(parsed["gate-timeout-ms"]), undefined, "--gate-timeout-ms");

  return {
    ...(repo === undefined ? {} : { repo }),
    ...(issue === undefined ? {} : { issue }),
    ...(all ? { all: true } : {}),
    ...(workers === undefined ? {} : { workers }),
    ...(merge ? { merge: true } : {}),
    checkout,
    remote,
    baseBranch,
    lockDirectory,
    worktreeRoot,
    ...(model === undefined ? {} : { model }),
    agentDirectory,
    ...(pool === undefined ? {} : { pool }),
    ...(showPool ? { showPool: true } : {}),
    ...(noVerify ? { verifyPushes: false } : {}),
    ...(batchRelated ? { batchRelated: true } : {}),
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
    ...(staleAfterMs === undefined ? {} : { staleAfterMs }),
    ...(gates === undefined ? {} : { gates }),
    ...(gateTimeoutMs === undefined ? {} : { gateTimeoutMs }),
  };
}

/**
 * Say that an option is not one the command has.
 *
 * citty keeps the options it does not know, and a runner that read them would
 * ignore a flag the operator believed in — a misspelled `--gate` would run the
 * default gates and say nothing.
 */
function rejectUnknownOptions(argv: readonly string[]): void {
  for (const argument of argv) {
    if (!argument.startsWith("--")) {
      continue;
    }
    const name = (argument.slice(2).split("=")[0] ?? "").trim();
    if (name !== "" && !(name in ARGS)) {
      throw new Error(`unknown option --${name}`);
    }
  }
}

/**
 * Say that the gates were named more than once.
 *
 * citty keeps the **last** of a repeated flag, so a second `--gate` would
 * quietly drop the first one and the run would judge the tree by half the
 * list the operator asked for. The list is one flag: `--gate "a, b"`.
 */
function rejectRepeatedGate(argv: readonly string[]): void {
  const named = argv.filter((argument) => argument === "--gate" || argument.startsWith("--gate="));
  if (named.length > 1) {
    throw new Error("the gates are named in one --gate, separated by commas");
  }
}

/** An option's value, as text — or nothing when it was not given. */
function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A list of commands, as one comma-separated value. */
function list(value: unknown, name: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${name} must be a list of commands`);
  }
  const commands = value
    .split(",")
    .map((command) => command.trim())
    .filter((command) => command !== "");
  if (commands.length === 0) {
    throw new Error(`${name} must name at least one command`);
  }
  return commands;
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
function number(
  raw: string | undefined,
  fallback: number | undefined,
  name: string,
): number | undefined {
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
    deadlineMs: options.deadlineMs ?? DEFAULT_DEADLINE_MS,
    staleAfterMs: options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
    ...(options.gates === undefined ? {} : { gates: options.gates }),
    ...(options.gateTimeoutMs === undefined ? {} : { gateTimeoutMs: options.gateTimeoutMs }),
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
 * The model the session runs on.
 *
 * The named one when the command names it — a named model is a decision, and
 * the pool does not overrule a decision. Otherwise the pool's best model: the
 * one with the biggest priority that is not at its peak tariff, has not run
 * out of its limit, is reachable, and needs no proxy this host has not got.
 *
 * Nothing at all when neither named nor pooled: the engine's own model, the
 * one the runner carries.
 */
async function chooseModel(options: {
  readonly model?: string;
  readonly pool: Pool | null;
  /** The models whose limit is gone — for the whole run. */
  readonly state: PoolState;
  readonly proxyConfigured: boolean;
}): Promise<{ readonly reference: string; readonly pooled: boolean } | undefined> {
  if (options.model !== undefined) {
    return { reference: options.model, pooled: false };
  }
  const pool = options.pool;
  if (pool === null || pool.models.length === 0) {
    return undefined;
  }
  const { mastraCatalogue } = await import("./mastra/model.js");
  const catalogue = mastraCatalogue();
  const chosen = pickPoolModel(pool, {
    exhausted: options.state.exhausted,
    proxyConfigured: options.proxyConfigured,
    now: new Date(),
    usable: (model) => knownModel(catalogue, model.reference),
  });
  if (chosen === undefined) {
    throw new NoModelAvailable(
      "no model in the pool can be used: every model is at its peak tariff, " +
        "has run out of its limit, or cannot be reached",
    );
  }
  return { reference: chosen.reference, pooled: true };
}

/**
 * What the pool file means right now.
 *
 * A question, not a run: the file is the host's policy, and a host that
 * cannot see what its own file says cannot change it. Nothing is run and no
 * lock is taken.
 */
export async function showPool(options: CliOptions): Promise<number> {
  const path = options.pool ?? poolFile(options.agentDirectory);
  const pool = await readPool(path);
  if (pool === null) {
    process.stdout.write(`there is no pool file at ${path}\n`);
    return EXIT_OK;
  }
  const { mastraCatalogue } = await import("./mastra/model.js");
  const lines = describePool(pool, {
    proxyConfigured: proxyFromEnvironment() !== undefined,
    usable: (model) => knownModel(mastraCatalogue(), model.reference),
  });
  process.stdout.write(`${lines.join("\n")}\n`);
  return EXIT_OK;
}

/**
 * The question the command line asks, when it asks one.
 *
 * `--show-pool` is a question about the pool file: it says what the file
 * means now and runs nothing. The flag is read here and nowhere else.
 */
export function askedQuestion(argv: readonly string[]): CliOptions | null {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch {
    return null;
  }
  return options.showPool === true ? options : null;
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
  | { readonly ok: true; readonly options: ResolvedOptions; readonly lock: Awaited<ReturnType<typeof takeLock>> }
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

  // The gates a run runs: the command's or the repository's own file. A run
  // that is told neither runs no gate, and the ceiling follows them.
  let settings: GateSettings;
  try {
    settings = resolveGateSettings({
      cli: {
        ...(resolved.gates === undefined ? {} : { gates: resolved.gates }),
        ...(resolved.gateTimeoutMs === undefined
          ? {}
          : { gateTimeoutMs: resolved.gateTimeoutMs }),
      },
      repo: await readGateSettings(resolved.checkout),
    });
  } catch (failure) {
    return { ok: false, failure };
  }
  // The pool file is read before the lock is taken: a file that is there but
  // cannot be read is a mistake in the command, and a mistake that holds the
  // lock keeps the next runner out while it is found.
  let pool: Pool | null;
  try {
    pool = await readPool(resolved.pool ?? poolFile(resolved.agentDirectory));
  } catch (failure) {
    return { ok: false, failure };
  }
  const withSettings: ResolvedOptions = {
    ...resolved,
    modelPool: pool,
    gates: settings.gates,
    gateTimeoutMs: settings.gateTimeoutMs,
    deadlineMs: resolved.deadlineMs ?? defaultDeadlineMs(settings.gates.length),
    staleAfterMs: resolved.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
  };

  const take = dependencies.lock ?? takeLock;
  try {
    const lock = await take(withSettings.lockDirectory, lockNameFor(withSettings));
    return { ok: true, options: withSettings, lock };
  } catch (failure) {
    return { ok: false, failure };
  }
}

/** The options of a run that is ready to start. */
export type ResolvedOptions = CliOptions & {
  readonly repo: string;
  /** The pool the models are picked from — null when there is no pool file. */
  readonly modelPool: Pool | null;
  readonly gates: readonly string[];
  readonly gateTimeoutMs: number;
  readonly deadlineMs: number;
  readonly staleAfterMs: number;
};

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
 * What one issue's run said, and the code it reached.
 *
 * The sweep collects these as its issues are worked, and the code the sweep
 * ends with is decided from them.
 */
export interface SweepOutcome {
  /** The issue the outcome belongs to. */
  readonly issue: number;
  /** The exit code the issue's run reached. */
  readonly code: number;
}

/**
 * The code a sweep ends with.
 *
 * The failure of the issue with the **smallest number** decides it. A sweep
 * that works several issues at once has no "first failure": the failures
 * happen in whatever order the workers happen to finish in, and the code must
 * not depend on that. The smallest failing issue is a property of the sweep's
 * issues, so two runs of the same sweep end with the same code.
 *
 * A sweep in which nothing failed ends with the zero.
 */
export function sweepExitCode(outcomes: readonly SweepOutcome[]): number {
  let winner: SweepOutcome | undefined;
  for (const outcome of outcomes) {
    if (outcome.code === EXIT_OK) {
      continue;
    }
    if (winner === undefined || outcome.issue < winner.issue) {
      winner = outcome;
    }
  }
  return winner?.code ?? EXIT_OK;
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
  // A question is not a run: `--show-pool` says what the pool file means and
  // takes no lock.
  const question = askedQuestion(argv);
  if (question !== null) {
    try {
      return await showPool(question);
    } catch (failure) {
      // A pool file the runner cannot read is a mistake in the file, and the
      // question says so instead of throwing at the caller.
      process.stderr.write(`${errorMessage(failure)}\n`);
      return EXIT_USAGE;
    }
  }
  const prepared = await prepareRun(argv, dependencies);
  if (!prepared.ok) {
    const failure = prepared.failure;
    const message = errorMessage(failure);
    if (message === "help") {
      process.stdout.write(`${await usage()}\n`);
      return EXIT_OK;
    }
    if (failure instanceof LockHeld) {
      process.stderr.write(`${failure.message}\n`);
      return EXIT_LOCKED;
    }
    if (failure instanceof LockUnusable) {
      process.stderr.write(`${failure.message}\n`);
      return EXIT_NO_LOCK;
    }
    // Everything else is the command line that was wrong: the options, the
    // repository, or the settings file the repository carries.
    process.stderr.write(`${message}\n\n${await usage()}\n`);
    return EXIT_USAGE;
  }
  const resolved = prepared.options;
  const lock = prepared.lock;

  // A killed process cannot run the release step, and a claim nobody is working
  // is an issue nobody can take. The signal becomes the stop the deadline already
  // uses: the session is aborted, its step fails, and the failure path releases.
  let stopped = false;
  // Every session that is alive: a sweep that works several issues at once has
  // one per issue, and a stop cuts them all.
  const active = new Set<AgentSession>();
  const interrupt = (): void => {
    if (stopped) {
      // A second signal is somebody insisting; the release is best effort.
      process.exit(130);
    }
    stopped = true;
    for (const session of active) {
      void session.abort().catch(() => {});
    }
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);

  const say = (line: string): void => {
    process.stdout.write(`${tagged(line)}\n`);
  };

  // The provider is reached through the proxy when there is one — the SDK's own
  // dispatcher does not read the environment.
  useProxyFromEnvironment();

  // The engine is Mastra, and its module is loaded only when a session is
  // asked for, so a run that never starts one does not pay for it.
  let mastra: SessionFactory | undefined;
  const engine: SessionFactory = async (options) => {
    if (mastra === undefined) {
      const { mastraSessionFactory } = await import("./mastra/session.js");
      mastra = mastraSessionFactory({
        ...(resolved.model === undefined ? {} : { model: resolved.model }),
        onEvent: say,
      });
    }
    return mastra(options);
  };
  const injected = dependencies.session !== undefined;
  const base: SessionFactory = dependencies.session ?? engine;

  // The pool is the host's own file: the models the run may use and the
  // conditions they are used under. The models whose limit is gone are
  // remembered for the whole run, and what the pool did is said in the record.
  const pool = resolved.modelPool;
  const poolState: PoolState = newPoolState();
  const poolEvents: string[] = [];
  const proxyConfigured = proxyFromEnvironment() !== undefined;

  const session: SessionFactory = async (options) => {
    const chosen = await chooseModel({
      ...(resolved.model === undefined ? {} : { model: resolved.model }),
      pool,
      state: poolState,
      proxyConfigured,
    });
    const created = await base({
      ...options,
      ...(chosen === undefined ? {} : { model: chosen.reference }),
    });
    // The session is tracked while it lives: a stop cuts every session that is
    // running, and a sweep that works several issues at once has one per issue.
    const move = created.setModel;
    const tracked: AgentSession = {
      prompt: (text) => created.prompt(text),
      abort: () => created.abort(),
      dispose: () => {
        active.delete(tracked);
        created.dispose();
      },
      get messages(): readonly TurnMessage[] {
        return created.messages ?? [];
      },
      get reference(): string | undefined {
        return created.reference;
      },
      ...(move === undefined ? {} : { setModel: (reference: string) => move(reference) }),
    };
    active.add(tracked);
    if (chosen === undefined || !chosen.pooled || injected) {
      return tracked;
    }
    if (move === undefined) {
      throw new Error(
        "the session cannot be moved onto another model — the model pool needs it",
      );
    }
    const host: PoolHost = {
      prompt: (text) => tracked.prompt(text),
      abort: () => tracked.abort(),
      dispose: () => tracked.dispose(),
      get messages(): readonly TurnMessage[] | undefined {
        return tracked.messages;
      },
      setModel: (reference) => move(reference),
    };
    const { mastraCatalogue } = await import("./mastra/model.js");
    return new PoolSession({
      host,
      catalogue: mastraCatalogue(),
      pool: pool as Pool,
      state: poolState,
      reference: chosen.reference,
      proxyConfigured,
      onEvent: poolEventChannel({
        pool: (line) => {
          poolEvents.push(line);
          say(line);
        },
        // The session's own channel is the journal the run writes: the pool's
        // lines are part of the run's own stream, not a separate report.
        session: options,
      }),
    });
  };

  const run: RunOptions = {
    ...runOptionsFrom(resolved, session, dependencies),
    poolEvents,
    onStep: (record) => {
      const detail = record.detail === "" ? "" : ` — ${record.detail}`;
      process.stdout.write(`${tagged(`[${record.step}] ${record.outcome}${detail}`)}\n`);
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
        poolEvents,
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
      return await sweep(run, resolved.repo, resolved.workers ?? 1);
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
 *
 * **Several workers.** The issues are still worked one by one — each one to
 * the end of its journey — but with `--workers N` there are N of them in
 * flight at once. Each takes the lock of the issue it works, so the workers
 * do not meet on the same issue; the sweep's own lock still keeps two sweeps
 * apart. A line names the issue it belongs to, because the workers write to
 * one stream.
 *
 * The code the sweep ends with is the code of the failure of the issue with
 * the smallest number — see {@link sweepExitCode}.
 */
async function sweep(
  runOptions: RunOptions,
  repo: string,
  workers: number,
): Promise<number> {
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

  let stoppedEarly = false;
  let noModel = false;
  const results: RunResult[] = [];
  // What every issue's run said: the code the sweep ends with is decided from
  // these, and not from the order the failures happened in.
  const outcomes: SweepOutcome[] = [];
  // The issues the workers have not taken yet: the list is worked by number,
  // and every worker takes the next one that is free.
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      // No model is left: the sweep stops, not only this worker.
      if (noModel) {
        return;
      }
      const issueNumber = numbers[next];
      next += 1;
      if (issueNumber === undefined) {
        return;
      }
      // A human who stopped the run stopped the sweep, not one issue of it.
      if (runOptions.stopped?.() === true) {
        stoppedEarly = true;
        return;
      }
      const outcome = await inIssue(issueNumber, workers, () =>
        work({ ...runOptions, issueNumber }, issueNumber),
      );
      if (outcome.code === EXIT_NO_MODEL) {
        // No model is left: the next issue would fail the same way, and a sweep
        // that fails every issue in the queue is not a sweep.
        noModel = true;
        return;
      }
      if (outcome.result !== undefined) {
        // One line per issue: a sweep is a journal.
        results.push(outcome.result);
        process.stdout.write(`${sweepIssueLine(outcome.result)}\n`);
      }
      outcomes.push({ issue: issueNumber, code: outcome.code });
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(workers, numbers.length) }, () => worker()),
  );
  process.stdout.write(`${sweepTotal(results, numbers.length)}\n`);
  if (noModel) {
    process.stderr.write("the sweep stopped: no model was available\n");
    return EXIT_NO_MODEL;
  }
  // Issues were left in the queue, so this is not the success the zero would
  // claim; a stop that did not fail a step reports the code a cut session has.
  const code = sweepExitCode(outcomes);
  if (stoppedEarly && code === EXIT_OK) {
    return STEP_EXIT_CODES.session ?? 1;
  }
  return code;
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
    // The lines below that do not name their issue are named by the context
    // they are written in: a sweep with several workers writes them all to one
    // stream.
    if (failure instanceof LockHeld) {
      process.stderr.write(`${tagged(failure.message)}\n`);
      return { code: EXIT_LOCKED };
    }
    if (failure instanceof LockUnusable) {
      process.stderr.write(`${tagged(failure.message)}\n`);
      return { code: EXIT_NO_LOCK };
    }
    // No model is not a step that failed: it is a reason there was no step to
    // run, and the code says so. The failure is wrapped in the run's own
    // error, so the cause is looked for.
    const noModel = causeOf(failure, (error) => error instanceof NoModelAvailable);
    if (noModel !== null) {
      process.stderr.write(`${tagged(noModel.message)}\n`);
      return { code: EXIT_NO_MODEL };
    }
    if (failure instanceof RunFailed) {
      process.stderr.write(`${tagged(failure.message)}\n`);
      return { code: STEP_EXIT_CODES[failure.step] ?? 1 };
    }
    process.stderr.write(`${tagged(errorMessage(failure))}\n`);
    return { code: 1 };
  }
}

/**
 * The failure in the chain of causes that is the kind asked for, or null.
 *
 * The run wraps what a step failed on, so the reason a run gave up is often
 * one layer down: "no model was available" is the cause of a failed session.
 */
function causeOf(failure: unknown, wanted: (error: Error) => boolean): Error | null {
  let current: unknown = failure;
  for (let depth = 0; depth < 10; depth += 1) {
    if (!(current instanceof Error)) {
      return null;
    }
    if (wanted(current)) {
      return current;
    }
    current = (current as { readonly cause?: unknown }).cause;
  }
  return null;
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
