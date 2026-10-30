#!/usr/bin/env node

/**
 * The unattended front door.
 *
 * One invocation: take the lock, work one issue, write the record, give the
 * lock back. The exit code says which step the run reached, because a
 * scheduler has nothing else to read — a systemd unit sees a number, and a
 * number that says "the session" is worth a great deal more than a number
 * that says "1".
 *
 * | Code | What it says |
 * |---|---|
 * | 0 | the run finished, or the queue was empty |
 * | 10..80 | the step the run stopped at — see `STEP_EXIT_CODES` |
 * | 75 | another runner holds the lock |
 * | 76 | the lock could not be taken |
 * | 2 | the command line was wrong |
 *
 * The runner never merges. A pull request it opens stays open, and a human
 * closes it.
 */

import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  DefaultResourceLoader,
  createAgentSession,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { EnvHttpProxyAgent, fetch as undiciFetch, setGlobalDispatcher } from "undici";

import { runGh, type GhRunner } from "./gh.js";
import { runCommand, runGit, type CommandRunner, type GitRunner } from "./git.js";
import { LockHeld, LockUnusable, takeLock } from "./lock.js";
import { RunFailed, runOnce, type RunOptions } from "./runner.js";
import type { SessionFactory } from "./session.js";

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
  push: 50,
  "pull request": 60,
  review: 70,
  "re-count": 80,
};

/** A week — how long a claim may sit before another run may take it over. */
export const DEFAULT_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Two hours — the wall-clock ceiling on one turn of the agent.
 *
 * A turn is a long one: the agent reads the repository, writes the change and
 * runs the gates, and the gates of a Kotlin Multiplatform repository take
 * minutes. Two hours is long enough for the work and short enough that a
 * session that has stopped making progress is cut off rather than left to
 * burn a night.
 */
export const DEFAULT_DEADLINE_MS = 2 * 60 * 60 * 1000;

/** What the command line says. */
export interface CliOptions {
  /** The repository the issue lives in — `owner/name`. */
  readonly repo: string;
  /** The issue to work. The queue's first eligible one when it is absent. */
  readonly issue?: number;
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
  /** Whether the target repository's pre-push hook may gate the pushes. */
  readonly verifyPushes?: boolean;
  /** The wall-clock ceiling on one turn of the agent. */
  readonly deadlineMs: number;
  /** How long a claim may sit before another run may take it over. */
  readonly staleAfterMs: number;
}

/** The usage the command prints when it is asked or when it is wrong. */
export const USAGE = [
  "pi-afk-runner — work one issue from the queue and open a reviewed pull request",
  "",
  "  pi-afk-runner --repo <owner/name> [options]",
  "",
  "  --repo <owner/name>    the repository the issue lives in (required)",
  "  --issue <number>        the issue to work (default: the queue's first eligible one)",
  "  --checkout <path>       the checkout the worktree is made from (default: the cwd)",
  "  --remote <name>         the remote the base comes from (default: origin)",
  "  --base <branch>         the branch the base is read from (default: main)",
  "  --lock-dir <path>       where the lock lives (default: <checkout>/build/afk-runner)",
  "  --worktree-root <path>  where the worktrees are created (default: <checkout>/../afk-worktrees)",
  "  --agent-dir <path>      Pi's agent directory (default: ~/.pi/agent)",
  "  --model <provider/id>   the model the agent runs on (default: the provider's first)",
  "  --no-verify             skip the target repository's pre-push hook when pushing",
  "  --deadline-ms <n>       the ceiling on one turn of the agent (default: 7200000)",
  "  --stale-after-ms <n>    how long a claim may sit (default: 604800000 — a week)",
  "  --help                  this text",
].join("\n");

/** The message of a failure, whatever it was thrown as. */
function errorMessage(failure: unknown): string {
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
    if (name === "no-verify") {
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
  if (repo === undefined || !repo.includes("/")) {
    throw new Error("--repo must name a repository, as owner/name");
  }

  const issue = values.get("issue");
  const checkout = resolve(values.get("checkout") ?? process.cwd());
  const remote = values.get("remote") ?? "origin";
  const baseBranch = values.get("base") ?? "main";
  const lockDirectory =
    values.get("lock-dir") ?? join(checkout, "build", "afk-runner");
  const worktreeRoot =
    values.get("worktree-root") ?? join(dirname(checkout), "afk-worktrees");
  const agentDirectory =
    values.get("agent-dir") ??
    process.env.PI_AGENT_DIR ??
    join(homedir(), ".pi", "agent");
  const model = values.get("model");
  const noVerify = values.has("no-verify");
  const deadlineMs = number(values.get("deadline-ms"), DEFAULT_DEADLINE_MS, "--deadline-ms");
  const staleAfterMs = number(values.get("stale-after-ms"), DEFAULT_STALE_AFTER_MS, "--stale-after-ms");

  return {
    repo,
    ...(issue === undefined ? {} : { issue: positiveNumber(issue, "--issue") }),
    checkout,
    remote,
    baseBranch,
    lockDirectory,
    worktreeRoot,
    agentDirectory,
    ...(model === undefined ? {} : { model }),
    ...(noVerify ? { verifyPushes: false } : {}),
    deadlineMs,
    staleAfterMs,
  };
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
 * creates sessions.
 */
export function piSessionFactory(options: {
  readonly agentDirectory: string;
  /** The model — `provider/id`. The provider's first model when it is absent. */
  readonly model?: string;
  /** Told what the agent is doing, as it does it. */
  readonly onEvent?: (line: string) => void;
}): SessionFactory {
  return async ({ cwd, systemPromptSections, tools }) => {
    useProxyFromEnvironment();
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: options.agentDirectory,
      extensionFactories: [
        {
          name: "afk-runner-guardrail",
          factory: (pi) => {
            pi.on("before_agent_start", (event) => {
              for (const [name, text] of Object.entries(systemPromptSections)) {
                event.systemPromptOptions.sections[name] = text;
              }
            });
            pi.on("tool_call", (event) => {
              options.onEvent?.(`  → ${describeToolCall(event)}`);
            });
          },
        },
      ],
    });
    await loader.reload();

    const created = await createAgentSession({
      cwd,
      resourceLoader: loader,
      ...(tools === undefined ? {} : { customTools: [...tools] }),
    });

    const model = pickModel(created.session.modelRuntime, options.model);
    if (model === undefined) {
      throw new Error(
        "no model to run on: name one with --model <provider/id>, or give the " +
          "host a provider whose credential is configured",
      );
    }
    await created.session.setModel(model);
    return created.session;
  };
}

/** One line about a tool call: the tool, and the command when there is one. */
function describeToolCall(event: { toolName: string; input?: unknown }): string {
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
    const separator = reference.indexOf("/");
    if (separator <= 0 || separator === reference.length - 1) {
      throw new Error(`--model must name a model, as provider/id — got ${reference}`);
    }
    const provider = reference.slice(0, separator);
    const id = reference.slice(separator + 1);
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
}

/**
 * Run once, and say what happened through the exit code.
 *
 * The lock is taken for the whole run and given back whatever happens — a
 * runner that died holding it would keep the next one out for ever, and a
 * runner that gave it back too early would let two of them work at once.
 */
export async function main(
  argv: readonly string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (failure) {
    const message = errorMessage(failure);
    if (message !== "help") {
      process.stderr.write(`${message}\n\n${USAGE}\n`);
      return EXIT_USAGE;
    }
    process.stdout.write(`${USAGE}\n`);
    return EXIT_OK;
  }

  let lock;
  try {
    lock = await takeLock(options.lockDirectory);
  } catch (failure) {
    if (failure instanceof LockHeld) {
      process.stderr.write(`${failure.message}\n`);
      return EXIT_LOCKED;
    }
    if (failure instanceof LockUnusable) {
      process.stderr.write(`${failure.message}\n`);
      return EXIT_NO_LOCK;
    }
    process.stderr.write(`${errorMessage(failure)}\n`);
    return EXIT_NO_LOCK;
  }

  const run: RunOptions = {
    repo: options.repo,
    ...(options.issue === undefined ? {} : { issueNumber: options.issue }),
    checkout: options.checkout,
    remote: options.remote,
    baseBranch: options.baseBranch,
    worktreeRoot: options.worktreeRoot,
    git: dependencies.git ?? runGit,
    gh: dependencies.gh ?? runGh,
    run: dependencies.run ?? runCommand,
    session:
      dependencies.session ??
      piSessionFactory({
        agentDirectory: options.agentDirectory,
        ...(options.model === undefined ? {} : { model: options.model }),
        onEvent: (line) => {
          process.stdout.write(`${line}\n`);
        },
      }),
    deadlineMs: options.deadlineMs,
    ...(options.verifyPushes === undefined ? {} : { verifyPushes: options.verifyPushes }),
    onStep: (record) => {
      const detail = record.detail === "" ? "" : ` — ${record.detail}`;
      process.stdout.write(`[${record.step}] ${record.outcome}${detail}\n`);
    },
  };

  try {
    const result = await runOnce(run);
    if (result.outcome === "empty") {
      process.stdout.write("the queue is empty — there was nothing to work\n");
    } else {
      process.stdout.write(
        `worked issue ${result.issue} — the record is at ${result.record}\n`,
      );
    }
    return EXIT_OK;
  } catch (failure) {
    if (failure instanceof RunFailed) {
      process.stderr.write(`${failure.message}\n`);
      return STEP_EXIT_CODES[failure.step] ?? 1;
    }
    process.stderr.write(`${errorMessage(failure)}\n`);
    return 1;
  } finally {
    await lock.release();
  }
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
