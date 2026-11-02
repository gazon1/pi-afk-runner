#!/usr/bin/env node

/**
 * The unattended front door.
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
 * | 3 | no model could be used |
 * | 75 | another runner holds the lock |
 * | 76 | the lock could not be taken |
 * | 2 | the command line was wrong |
 *
 * The work pipeline never merges. A pull request it opens stays open, and a
 * human closes it. `--merge` is the explicit exception: a separate, opt-in
 * mode that lands the reviewed, green pull requests the work pipeline opened.
 */

import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DefaultResourceLoader,
  ModelRuntime,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import chalk from "chalk";

import { DEFAULT_DEADLINE_MS } from "./budget.js";
import { readClaimed, readQueue, runGh, type GhRunner } from "./gh.js";
import { guardExtensionPath, installGuardPolicy } from "./guard.js";
import { runCommand, runGit, type CommandRunner, type GitRunner } from "./git.js";
import { LockHeld, LockUnusable, lockNameFor, takeLock, workLockName } from "./lock.js";
import {
  mergeReviewedPullRequests,
  type MergeOptions,
  type MergeResult,
} from "./merge.js";
import { PoolSession } from "./pool-session.js";
import {
  NoModelAvailable,
  describePool,
  knownModel,
  newPoolState,
  pickPoolModel,
  poolFile,
  readPool,
  splitReference,
  type Pool,
  type PoolState,
} from "./pool.js";
import { proxyFromEnvironment, useProxy } from "./proxy.js";
import {
  RunFailed,
  emptyQueueSentence,
  runOnce,
  type RunOptions,
  type RunResult,
} from "./runner.js";
import {
  addUsage,
  skillsDirectory,
  usageFromMessage,
  type AgentSession,
  type RunUsage,
  type SessionFactory,
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
  /** Pi's agent directory — its settings, its extensions, its credentials. */
  readonly agentDirectory: string;
  /** The model the agent runs on — `provider/id`. */
  readonly model?: string;
  /** The model pool — the file the models and their conditions are read from. */
  readonly pool?: string;
  /** Whether to print what the pool file means now, and run nothing. */
  readonly showPool?: boolean;
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
  "  --agent-dir <path>      Pi's agent directory (default: ~/.pi/agent)",
  "  --model <provider/id>   the model the agent runs on (default: the pool's best model)",
  "  --pool <path>           the model pool file (default: <agent-dir>/models.yaml)",
  "  --show-pool             print what the pool file means now, and run nothing",
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
    if (
      name === "no-verify" ||
      name === "all" ||
      name === "merge" ||
      name === "batch-related" ||
      name === "show-pool"
    ) {
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
  // The same precedence Pi itself uses for its agent directory, so that the
  // directory this runner names is the one the session and the guard read.
  const agentDirectory =
    values.get("agent-dir") ??
    process.env.PI_CODING_AGENT_DIR ??
    process.env.PI_AGENT_DIR ??
    join(homedir(), ".pi", "agent");
  const model = values.get("model");
  const pool = values.get("pool");
  const showPool = values.has("show-pool");
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
    agentDirectory,
    ...(model === undefined ? {} : { model }),
    ...(pool === undefined ? {} : { pool }),
    ...(showPool ? { showPool: true } : {}),
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
 * The lines an assistant text block contributes to the run stream.
 *
 * A text block can hold several lines — the final summary usually does — and
 * every one of them is tagged, so no line of the stream reads as runner
 * output. A blank line carries nothing and is dropped.
 */
export function assistantTextLines(text: string): string[] {
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() !== "") {
      lines.push(`· ${line}`);
    }
  }
  return lines;
}

/**
 * The loader the session's resources come from.
 *
 * It is the SDK's own loader, with three things said: the guard's extension is
 * installed into the session, the runner's own skills are in its skill paths,
 * and this package's own extension is dropped from the set the loader
 * discovered.
 */
export function createResourceLoader(options: {
  readonly cwd: string;
  readonly agentDirectory: string;
  readonly systemPromptSections: Record<string, string>;
  /** Told what the agent is doing, as it does it. */
  readonly onEvent?: (line: string) => void;
  /**
   * Told what a turn cost, when the provider reported it.
   *
   * The message the `message_end` event carries is the one that holds the
   * numbers, and the loader is the one that sees the event.
   */
  readonly onUsage?: (usage: RunUsage) => void;
}): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDirectory,
    additionalExtensionPaths: [guardExtensionPath()],
    // The runner's own skills, and nothing else: the target repository's
    // skills and the host user's come from the loader's own discovery. The
    // host's are not the runner's to depend on — a run has to be the same on
    // every host — so a skill the runner depends on is a skill the runner
    // carries.
    additionalSkillPaths: [skillsDirectory()],
    extensionsOverride: (loaded) => ({
      ...loaded,
      extensions: loaded.extensions.filter((extension) => !isOwnExtension(extension.path)),
    }),
    extensionFactories: [
      {
        name: "afk-runner-guardrail",
        factory: (pi) => {
          pi.on("before_agent_start", (event) => {
            for (const [name, text] of Object.entries(options.systemPromptSections)) {
              event.systemPromptOptions.sections[name] = text;
            }
          });
          pi.on("tool_call", (event) => {
            options.onEvent?.(chalk.dim(`  → ${describeToolCall(event)}`));
          });
          pi.on("message_end", (event: any) => {
            const message = event?.message;
            if (!message || message.role !== "assistant") {
              return;
            }
            // What the turn cost, when the provider said what it cost. The
            // message this event carries is the one that holds the numbers.
            const usage = usageFromMessage(message);
            if (usage !== undefined) {
              options.onUsage?.(usage);
            }
            const content = Array.isArray(message.content)
              ? message.content
              : [];
            for (const block of content) {
              if (!block || typeof block !== "object") {
                continue;
              }
              if (block.type === "thought" || block.type === "thinking") {
                const thinking =
                  typeof (block as any).thinking === "string"
                    ? (block as any).thinking
                    : typeof (block as any).text === "string"
                      ? (block as any).text
                      : "";
                if (thinking === "") {
                  continue;
                }
                const lines = thinking.split("\n");
                const shown = lines.slice(0, 3);
                for (const line of shown) {
                  // A blank line carries nothing: the marker on it would be a
                  // line of its own, and it would read as the agent's line.
                  if (line.trim() === "") {
                    continue;
                  }
                  // The marker is what says "the agent, not the runner": the
                  // journal is not a TTY, so the dim is the same text as a
                  // status line and the shape is all that is left.
                  options.onEvent?.(chalk.dim(`· ${line}`));
                }
                if (lines.length > 3) {
                  options.onEvent?.(chalk.dim(`… (+${lines.length - 3} lines)`));
                }
                continue;
              }
              if (block.type === "text") {
                const text =
                  typeof (block as any).text === "string"
                    ? (block as any).text
                    : "";
                for (const line of assistantTextLines(text)) {
                  options.onEvent?.(line);
                }
                continue;
              }
            }
          });
        },
      },
    ],
  });
}

/**
 * The session the agent works in.
 *
 * Pi's own session, with two things added: the runner's guardrail reaches the
 * model through the system prompt, and a model is **chosen**. A session with
 * no model answers to nobody — the SDK's own initial resolution falls back to
 * "unknown" when the host has no default model saved — so the runner names
 * one, and says so when it cannot find any.
 *
 * The extension is installed **into the session**, not into the host's Pi — a
 * session the runner creates must not be steered by the extension that also
 * creates sessions. That is what `extensionsOverride` enforces: discovery stays
 * on, because the host's model providers are extensions and a session that
 * discovered nothing would have no model to run on, and **this** extension is
 * dropped by path before the session's runner is built.
 */
export function piSessionFactory(options: {
  readonly agentDirectory: string;
  /** The model — `provider/id`. It wins over the pool. */
  readonly model?: string;
  /** The model to run on when there is no pool — the host's own. */
  readonly fallbackModel?: string;
  /** The pool the model is picked from, and moved around in. */
  readonly pool?: Pool | null;
  /** What the pool remembers for the whole run. */
  readonly state?: PoolState;
  /** Told what the agent is doing, as it does it. */
  readonly onEvent?: (line: string) => void;
  /** Told what the pool did — the model it moved to, and why. */
  readonly onPoolEvent?: (line: string) => void;
}): SessionFactory {
  return async ({ cwd, systemPromptSections, tools, onUsage }) => {
    // The host's own proxy first; the pool's own proxy replaces it per model.
    const proxyConfigured = useProxy(undefined);
    const state = options.state ?? newPoolState();
    await installGuardPolicy({ cwd });
    const loader = createResourceLoader({
      cwd,
      agentDirectory: options.agentDirectory,
      systemPromptSections,
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
      ...(onUsage === undefined ? {} : { onUsage }),
    });
    await loader.reload();

    const created = await createAgentSession({
      cwd,
      // The same directory the loader was given: the flag means "this agent
      // directory", not "the extensions of this one and the credentials of another".
      agentDir: options.agentDirectory,
      resourceLoader: loader,
      ...(tools === undefined ? {} : { customTools: [...tools] }),
    });

    // `session_start` is the host's event, and this session has no host: the SDK
    // builds the extension runner and binds the tool-call gate, but never emits it.
    // The guard loads its policy there, so without this line it has none — and a
    // call with no rule is an ask, which in a session with no dialog is a deny.
    // Measured: every tool call blocked before this line, only the denied paths after.
    await created.session.bindExtensions({});

    const chosen = chooseModel(created.session.modelRuntime, {
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.fallbackModel === undefined
        ? {}
        : { fallbackModel: options.fallbackModel }),
      ...(options.pool === undefined ? {} : { pool: options.pool }),
      exhausted: state.exhausted,
      proxyConfigured,
    });
    if (chosen === undefined) {
      throw new Error(
        "no model to run on: name one with --model <provider/id>, or give the " +
          "host a provider whose credential is configured",
      );
    }
    await created.session.setModel(chosen.model);
    if (!chosen.pooled) {
      return created.session;
    }
    // The pool moves the session between its models: a limit that runs out, a
    // peak hour that comes, a model that becomes available.
    return new PoolSession({
      host: created.session,
      runtime: created.session.modelRuntime,
      pool: options.pool as Pool,
      state,
      reference: chosen.reference,
      proxyConfigured,
      ...(options.onPoolEvent === undefined ? {} : { onEvent: options.onPoolEvent }),
    });
  };
}

/**
 * The model the session runs on.
 *
 * The named one when the command names it — a named model is a decision, and
 * the pool does not overrule a decision. Otherwise the pool's best model: the
 * one with the biggest priority that is not at its peak tariff, has not run out
 * of its limit, is reachable, and needs no proxy this host has not got.
 */
function chooseModel(
  runtime: ModelRuntime,
  options: {
    readonly model?: string;
    readonly fallbackModel?: string;
    readonly pool?: Pool | null;
    /** The models whose limit is gone — for the whole run. */
    readonly exhausted?: ReadonlySet<string>;
    readonly proxyConfigured: boolean;
  },
):
  | {
      readonly model: NonNullable<ReturnType<ModelRuntime["getModel"]>>;
      readonly reference: string;
      /** Whether the pool owns the session and may move it. */
      readonly pooled: boolean;
    }
  | undefined {
  if (options.model !== undefined) {
    const model = pickModel(runtime, options.model);
    return model === undefined
      ? undefined
      : { model, reference: options.model, pooled: false };
  }
  const pool = options.pool ?? null;
  if (pool !== null && pool.models.length > 0) {
    const chosen = pickPoolModel(pool, {
      ...(options.exhausted === undefined ? {} : { exhausted: options.exhausted }),
      proxyConfigured: options.proxyConfigured,
      now: new Date(),
      usable: (model) => knownModel(runtime, model.reference),
    });
    if (chosen === undefined) {
      throw new NoModelAvailable(
        "no model in the pool can be used: every model is at its peak tariff, " +
          "has run out of its limit, or cannot be reached",
      );
    }
    const { provider, id } = splitReference(chosen.reference, "the pool's model");
    const model = runtime.getModel(provider, id);
    if (model === undefined) {
      throw new NoModelAvailable(`the provider ${provider} has no model ${id}`);
    }
    return { model, reference: chosen.reference, pooled: true };
  }
  const model = pickModel(runtime, options.fallbackModel);
  return model === undefined
    ? undefined
    : { model, reference: options.fallbackModel ?? "", pooled: false };
}

/** The name of the directory this package is installed in, whatever the install. */
const OWN_PACKAGE = basename(dirname(dirname(fileURLToPath(import.meta.url))));

/**
 * Whether a discovered extension is this package's own.
 *
 * It is decided by the **package**, not by the file: a host can have two copies
 * of this package installed (a project install and a global one), and the copy
 * the host activated is not necessarily the copy a work session discovers. A path
 * comparison would let the other copy in — and that copy's hooks would fire in
 * the session this package created.
 *
 * A synthetic path is not a package at all. It is the loader's name for an
 * extension that has no file — `<inline:...>` for the factory this package
 * registers, `builtin:...` for the SDK's own. `resolve()` turns one into a
 * path under the working directory, and the package name is then read off the
 * working directory's **parent**: on a CI runner the checkout sits at
 * `<repo>/<repo>`, so the parent is named after the package and the runner's own
 * inline factory was mistaken for a second copy of itself — and dropped, taking
 * the tool-call log with it.
 */
export function isOwnExtension(path: string): boolean {
  // A synthetic path names no file: `builtin:` for the SDK's own, `<...>` for
  // the factory this package registers. The SDK's own rule, kept in step with
  // it — the SDK does not export `isSyntheticPath`.
  if (path.startsWith("builtin:") || path.startsWith("<")) {
    return false;
  }
  // `<package>/dist/extension.js` from an install, `<package>/src/extension.ts` from source.
  return basename(dirname(dirname(resolve(path)))) === OWN_PACKAGE;
}

/**
 * The run both front doors give the runner.
 *
 * Everything here comes from the command line or from the injected dependencies;
 * the doors differ only in how they report a run — a scheduler reads stdout, a
 * human reads the footer — so those callbacks are added by each door. One map,
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

/** One line about a tool call: the tool, and the command when there is one. */
export function describeToolCall(event: { toolName: string; input?: unknown }): string {
  const input = event.input;
  const command =
    typeof input === "object" &&
    input !== null &&
    "command" in input &&
    typeof (input as { command: unknown }).command === "string"
      ? (input as { command: string }).command
      : undefined;
  if (command === undefined) {
    return event.toolName;
  }
  const first = command.split("\n")[0] ?? "";
  return `${event.toolName}: ${first.length > 120 ? `${first.slice(0, 120)}…` : first}`;
}

/**
 * The model the session runs on.
 *
 * The named one when the command names it; otherwise the first model of the
 * first provider whose credential is configured. "First" is the provider's own
 * order — the order its catalogue lists its models in — and not a ranking:
 * choosing a model well is the host's judgement, not the runner's.
 */
export function pickModel(
  runtime: ModelRuntime,
  reference: string | undefined,
): ReturnType<ModelRuntime["getModel"]> {
  if (reference !== undefined) {
    // The provider and the model are separated by the **first** slash: a model
    // id may itself contain one — `commandcode/reflection/beam:free` is a
    // provider called `commandcode` and a model called `reflection/beam:free`.
    const { provider, id } = splitReference(reference, "--model");
    const model = runtime.getModel(provider, id);
    if (model === undefined) {
      throw new Error(`the provider ${provider} has no model ${id}`);
    }
    return model;
  }
  for (const provider of runtime.getRegisteredProviderIds()) {
    if (!runtime.hasConfiguredAuth(provider)) {
      continue;
    }
    const models = runtime.getModels(provider);
    if (models.length > 0) {
      return models[0];
    }
  }
  return undefined;
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
  // The catalogue and the credentials are the host's own: the pool says which
  // models it wants, and only they say which of them can be reached.
  const runtime = await ModelRuntime.create({
    authPath: join(options.agentDirectory, "auth.json"),
    modelsPath: join(options.agentDirectory, "models.json"),
  });
  const lines = describePool(pool, {
    proxyConfigured: proxyFromEnvironment() !== undefined,
    usable: (model) => knownModel(runtime, model.reference),
  });
  process.stdout.write(`${lines.join("\n")}\n`);
  return EXIT_OK;
}

/**
 * The question the command line asks, when it asks one.
 *
 * `--show-pool` is a question about the pool file: it says what the file
 * means now and runs nothing. The flag is read here and nowhere else — the
 * options say the question was asked, and the answer comes from the file.
 *
 * A command line that cannot be read is not a question: the run says how it
 * is wrong.
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
  | {
      readonly ok: true;
      readonly options: CliOptions & { readonly repo: string };
      readonly lock: Awaited<ReturnType<typeof takeLock>>;
      /** The model pool, when the host has one. */
      readonly pool: Pool | null;
    }
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

  // The pool is read before the lock: a pool file that cannot be read is a
  // mistake in the command, and a mistake that holds the lock keeps the next
  // runner out while it is found.
  let pool: Pool | null;
  try {
    pool = await readPool(resolved.pool ?? poolFile(resolved.agentDirectory));
  } catch (failure) {
    return { ok: false, failure };
  }

  const take = dependencies.lock ?? takeLock;
  try {
    const lock = await take(resolved.lockDirectory, lockNameFor(resolved));
    return { ok: true, options: resolved, lock, pool };
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
  // The question about the pool file is asked before the run is prepared: it
  // prints and stops, and it takes no lock — a lock nobody gives back keeps
  // the next runner out.
  const question = askedQuestion(argv);
  if (question !== null) {
    try {
      return await showPool(question);
    } catch (failure) {
      process.stderr.write(`${errorMessage(failure)}\n`);
      return EXIT_USAGE;
    }
  }
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

  // What the pool remembers for the whole run: a model whose limit is gone is
  // gone for every issue of the sweep, not only for the session that found it.
  const state = newPoolState();
  // What the pool did, for the record of the run: the model it moved to, and
  // why it moved.
  const poolEvents: string[] = [];
  const base =
    dependencies.session ??
    piSessionFactory({
      agentDirectory: resolved.agentDirectory,
      ...(resolved.model === undefined ? {} : { model: resolved.model }),
      pool: prepared.pool,
      state,
      onEvent: (line) => {
        process.stdout.write(`${line}\n`);
      },
      onPoolEvent: (line) => {
        poolEvents.push(line);
        process.stdout.write(`${line}\n`);
      },
    });
  const session: SessionFactory = async (options) => {
    const created = await base(options);
    active = created;
    return created;
  };

  const run: RunOptions = {
    ...runOptionsFrom(resolved, session, dependencies),
    poolEvents,
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
        poolEvents,
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
  let noModel = false;
  const results: RunResult[] = [];
  for (const issueNumber of numbers) {
    // A human who stopped the run stopped the sweep, not one issue of it.
    if (runOptions.stopped?.() === true) {
      stoppedEarly = true;
      break;
    }
    const outcome = await work({ ...runOptions, issueNumber }, issueNumber);
    if (outcome.code === EXIT_NO_MODEL) {
      // No model is left: the next issue would fail the same way, and a sweep
      // that fails every issue in the queue is not a sweep.
      noModel = true;
      break;
    }
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
  if (noModel) {
    process.stderr.write("the sweep stopped: no model was available\n");
    return EXIT_NO_MODEL;
  }
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
    // No model is not a step that failed: it is a reason there was no step to
    // run, and the code says so.
    const noModel = causeOf(failure, (error) => error instanceof NoModelAvailable);
    if (noModel !== null) {
      process.stderr.write(`${noModel.message}\n`);
      return { code: EXIT_NO_MODEL };
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
 * The failure behind a failure, when it is the one being looked for.
 *
 * A failure is wrapped as it travels: the session's error becomes the step's,
 * and the step's becomes the run's. The reason is at the bottom of that chain.
 */
function causeOf(
  failure: unknown,
  wanted: (error: Error) => boolean,
): Error | null {
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
