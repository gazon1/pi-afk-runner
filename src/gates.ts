/**
 * The gates the target repository runs, and the runner's own run of them.
 *
 * A run runs **no** gate unless it is asked to: the command line names them
 * (`--gate "./check.sh --fast"`), or the repository's own file in the root of
 * the checkout names them (`.afk-runner.json`). The contract still names three
 * gates, and the machinery that runs them is still here — but nothing runs
 * them unless somebody says so, and the tree that is pushed is the tree the
 * agent left.
 *
 * The gates run in the worktree, on the tree the agent left, and the tree they
 * judged is the tree that is pushed.
 */

import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { CommandFailed, CommandTimedOut, type CommandRunner } from "./git.js";

/**
 * The gates a run runs when nothing says otherwise: none.
 *
 * The runner's speed is the point of a run that is not a gate, and the
 * repository's own CI still judges the pull request.
 */
export const NO_GATES: readonly string[] = [];

/**
 * The settings a repository may carry, in its own root.
 *
 * The file is the **repository's**: it says which gates a run on it runs, and
 * the runner reads it from the checkout it works. A repository with no such
 * file — or with no gates in it — runs no gates.
 */
export const GATE_CONFIG_FILE = ".afk-runner.json";

/** What a repository says about the gates a run on it runs. */
export interface GateSettings {
  /** The gates, in the order they run. */
  readonly gates: readonly string[];
  /** How long one gate may take, in milliseconds. */
  readonly gateTimeoutMs: number;
}

/** The message of a failure, whatever it was thrown as. */
function failureMessage(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/**
 * Read the repository's own gate settings, or nothing when it has no file.
 *
 * A file that cannot be read is the repository's own mistake and ends the run
 * where it stands: a runner that quietly falls back to the contract's gates
 * would judge a tree by a list the repository did not ask for.
 */
export async function readGateSettings(
  checkout: string,
): Promise<GateSettings | undefined> {
  const path = join(checkout, GATE_CONFIG_FILE);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new Error(`${GATE_CONFIG_FILE} could not be read: ${failureMessage(failure)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (failure) {
    throw new Error(`${GATE_CONFIG_FILE} is not valid JSON: ${failureMessage(failure)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${GATE_CONFIG_FILE} must hold an object`);
  }
  const settings = parsed as { readonly gates?: unknown; readonly gateTimeoutMs?: unknown };

  if (settings.gates !== undefined && !Array.isArray(settings.gates)) {
    throw new Error(`${GATE_CONFIG_FILE}: "gates" must be a list of commands`);
  }
  const gates = (settings.gates ?? NO_GATES) as readonly unknown[];
  for (const gate of gates) {
    if (typeof gate !== "string" || gate.trim() === "") {
      throw new Error(`${GATE_CONFIG_FILE}: every gate must be a command`);
    }
  }
  if (
    settings.gateTimeoutMs !== undefined &&
    (!Number.isInteger(settings.gateTimeoutMs) ||
      (settings.gateTimeoutMs as number) <= 0)
  ) {
    throw new Error(
      `${GATE_CONFIG_FILE}: "gateTimeoutMs" must be a whole number of milliseconds`,
    );
  }

  return {
    gates: gates.map((gate) => (gate as string).trim()),
    gateTimeoutMs: (settings.gateTimeoutMs as number | undefined) ?? GATE_TIMEOUT_MS,
  };
}

/**
 * The gates a run runs, and how long each may take.
 *
 * The command line wins over the repository's file, and neither of them means
 * any gate at all: a run that nobody asked to gate runs no gate.
 */
export function resolveGateSettings(options: {
  /** The gates the command line named. */
  readonly cli?: {
    readonly gates?: readonly string[];
    readonly gateTimeoutMs?: number;
  };
  /** The settings the repository's own file carried. */
  readonly repo?: GateSettings | undefined;
}): GateSettings {
  const cli = options.cli;
  const repo = options.repo;
  const gates = cli?.gates ?? repo?.gates ?? NO_GATES;
  const gateTimeoutMs = cli?.gateTimeoutMs ?? repo?.gateTimeoutMs ?? GATE_TIMEOUT_MS;
  return { gates: [...gates], gateTimeoutMs };
}

/**
 * How long one gate may run before the runner gives up on it.
 *
 * The merge pipeline gives the same repository gate an hour, and the two doors
 * must not disagree about how long a build may take: the work pipeline runs
 * the gate first, and a stricter budget there would kill a build the merge
 * pipeline would have let finish.
 */
export const GATE_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * How much of a gate's output the runner keeps.
 *
 * A failing `./check.sh` prints megabytes — a compiler's every finding, a test
 * run's every failure. The record carries the tail of it, and the runner does
 * not hold the rest in memory either: a gate's output is evidence, not a
 * thing to be kept whole. The whole of it goes to a file, and the record
 * names the file.
 */
export const GATE_OUTPUT_LIMIT_BYTES = 64 * 1024;

/** How a gate is run. */
export interface GateInvocation {
  /** The program to run. */
  readonly command: string;
  /** Its arguments. */
  readonly args: readonly string[];
}

/**
 * The command that runs a gate.
 *
 * Derived from the gate's own name, so the list stays the only place the
 * gates are written down: a gate named `./check.sh --fast` is run by the
 * shell with that flag, and a gate named `just <recipe>` is run by `just`.
 */
export function gateInvocation(gate: string): GateInvocation {
  const [name, ...args] = gate.split(" ");
  if (name?.startsWith("./")) {
    return { command: "bash", args: [name, ...args] };
  }
  return { command: name ?? gate, args };
}

/**
 * Why a gate did not pass.
 *
 * - `failed` — the gate ran, and it said no.
 * - `missing` — the program that runs it is not on this host. The gate never
 *   got to answer, and a record that says "exit 1" would say the gate refused
 *   the change when it never saw it.
 * - `unfinished` — it was killed, or the run's budget was spent before it
 *   could start.
 */
export type GateFailure = "failed" | "missing" | "unfinished";

/** A gate that did not pass, with what it printed. */
export class GateFailed extends Error {
  /** The gate that failed, as the contract writes it. */
  readonly gate: string;
  /** Why it did not pass. */
  readonly reason: GateFailure;
  /**
   * The exit code the gate returned — absent when it never returned one.
   *
   * A gate that was killed, or that never started, has no exit code, and the
   * record must not claim one.
   */
  readonly exitCode: number | undefined;
  /** What the gate printed — its standard output and its standard error. */
  readonly output: string;
  /**
   * Where the gate's whole output is, when it was written to a file.
   *
   * The record quotes the tail of the output; this is where the rest of it
   * is, for whoever wants to read the whole build log.
   */
  readonly outputFile: string | undefined;

  constructor(options: {
    readonly gate: string;
    readonly reason: GateFailure;
    readonly exitCode?: number;
    readonly output: string;
    /** The program the gate needs, when the program is what is missing. */
    readonly program?: string;
    /** What else the record should say. */
    readonly detail?: string;
    /** Where the gate's whole output was written. */
    readonly outputFile?: string;
  }) {
    super(gateFailureMessage(options));
    this.name = "GateFailed";
    this.gate = options.gate;
    this.reason = options.reason;
    this.exitCode = options.exitCode;
    this.output = options.output;
    this.outputFile = options.outputFile;
  }
}

/** What a gate's failure says. */
function gateFailureMessage(options: {
  readonly gate: string;
  readonly reason: GateFailure;
  readonly exitCode?: number;
  readonly output: string;
  readonly program?: string;
  readonly detail?: string;
}): string {
  if (options.reason === "missing") {
    return (
      `the gate ${options.gate} could not run: ` +
      `${options.program ?? "the program it needs"} is not on this host`
    );
  }
  if (options.reason === "unfinished") {
    return `the gate ${options.gate} did not finish: ${options.detail ?? "it was killed"}`;
  }
  const said = lastLine(options.output);
  const how = options.exitCode === undefined ? "failed" : `failed (exit ${options.exitCode})`;
  return said === ""
    ? `the gate ${options.gate} ${how}`
    : `the gate ${options.gate} ${how}: ${said}`;
}

/** The last non-empty line of what a gate printed. */
function lastLine(text: string): string {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line !== undefined && line.trim() !== "") {
      return line.trim();
    }
  }
  return "";
}

/**
 * What a failed gate's failure is.
 *
 * The three reasons are three different stories, and the record tells them
 * apart: a gate that refused the change, a host that cannot run the gate, and
 * a gate that never got to answer.
 */
export async function gateFailure(
  gate: string,
  invocation: GateInvocation,
  failure: unknown,
  outputFile: string | undefined,
): Promise<GateFailed> {
  if (failure instanceof CommandFailed) {
    return new GateFailed({
      gate,
      reason: "failed",
      exitCode: failure.exitCode,
      output: [failure.stdout, failure.stderr].join("\n"),
      ...(await writtenLog(outputFile)),
    });
  }
  if (failure instanceof CommandTimedOut) {
    return new GateFailed({
      gate,
      reason: "unfinished",
      output: [failure.stdout, failure.stderr].join("\n"),
      detail: `it was killed after ${failure.timeoutMs}ms`,
      ...(await writtenLog(outputFile)),
    });
  }
  const code = (failure as { code?: string } | null)?.code;
  if (code === "ENOENT" || code === "EACCES") {
    // The gate never ran, so it printed nothing and there is no log of it.
    return new GateFailed({
      gate,
      reason: "missing",
      output: "",
      program: invocation.command,
    });
  }
  return new GateFailed({
    gate,
    reason: "unfinished",
    output: "",
    detail: failure instanceof Error ? failure.message : String(failure),
  });
}

/**
 * The file the gate's whole output went to, when it is there.
 *
 * A gate that never ran has no output and no file, and a record that names a
 * file that is not there sends the reader looking for nothing. A gate that
 * ran and said nothing has an empty file, and there is nothing to point at.
 */
async function writtenLog(
  outputFile: string | undefined,
): Promise<{ readonly outputFile?: string }> {
  if (outputFile === undefined) {
    return {};
  }
  const there = await stat(outputFile).then(
    (file) => file.size > 0,
    () => false,
  );
  return there ? { outputFile } : {};
}

/**
 * Run the target repository's gates in the worktree.
 *
 * Each gate is the repository's own command, run where the repository runs it:
 * in the worktree, on the tree the agent left. A gate that does not pass ends
 * the run — the work is not finished, and a run that pushes it anyway hands
 * the review a diff the repository's own gate has already refused.
 *
 * The gates run in order, and the first one that fails ends the run: the gates
 * after it would judge a tree that is already refused.
 *
 * The budget is the run's own: the gates share what the rest of the run left
 * behind, so a run cannot outlive its ceiling by three gate-hours.
 */
export async function runGates(options: {
  readonly run: CommandRunner;
  readonly cwd: string;
  /** The budget the gates share, in milliseconds. */
  readonly budgetMs: number;
  /**
   * Where the gates' whole output goes while they run.
   *
   * The file is the gate's own evidence, whole; the record quotes the tail of
   * it and names the file. A gate that passes leaves nothing behind: the log
   * of a green build is evidence of nothing.
   */
  readonly outputFile?: string;
  /**
   * The gates to run, in the order they run.
   *
   * None when it is not given: a run that was not told to run a gate runs no
   * gate.
   */
  readonly gates?: readonly string[];
  /**
   * How long one gate may take, in milliseconds.
   *
   * The contract's own budget when it is not given.
   */
  readonly gateTimeoutMs?: number;
  /**
   * The environment the gates run with, over the runner's own.
   *
   * The repository's own setup says which PATH its tools live under: the gate
   * CLI is an editable install of that checkout's own venv, and a gate that
   * cannot find it never got to answer.
   */
  readonly env?: Readonly<Record<string, string>>;
}): Promise<string> {
  const gates = options.gates ?? NO_GATES;
  const gateTimeoutMs = options.gateTimeoutMs ?? GATE_TIMEOUT_MS;
  if (gates.length === 0) {
    return "no gates to run";
  }
  const startedAt = Date.now();
  const passed: string[] = [];
  for (const gate of gates) {
    const invocation = gateInvocation(gate);
    const left = options.budgetMs - (Date.now() - startedAt);
    if (left <= 0) {
      throw new GateFailed({
        gate,
        reason: "unfinished",
        output: "",
        detail: "the run's budget was spent before the gates could run",
      });
    }
    const outputFile = options.outputFile;
    if (outputFile !== undefined) {
      // The log is a convenience: a directory that cannot be created is not a
      // gate's verdict, and the gates still have to run.
      await mkdir(dirname(outputFile), { recursive: true }).catch(() => {});
    }
    try {
      await options.run({
        command: invocation.command,
        args: invocation.args,
        cwd: options.cwd,
        // The gate's own budget, and no more than the run has left: a build
        // that runs long is still the gate's own answer, and a timeout the
        // gate never chose is not a verdict.
        timeoutMs: Math.min(gateTimeoutMs, options.budgetMs, left),
        // The tail of the output is the evidence; the rest is noise the
        // runner neither keeps nor records.
        maxOutputBytes: GATE_OUTPUT_LIMIT_BYTES,
        // The build the gate starts dies with the gate: a build that keeps
        // going writes into the worktree the runner restores and pushes.
        killGroup: true,
        // The whole of it goes to the file, so that the record can quote the
        // tail and still say where the rest of it is.
        ...(outputFile === undefined ? {} : { outputFile }),
        // The repository's own PATH: the gate's tools live in that checkout's
        // venv, and a gate that cannot find them never got to answer.
        ...(options.env === undefined ? {} : { env: options.env }),
      });
    } catch (failure) {
      const failed = await gateFailure(gate, invocation, failure, outputFile);
      if (failed.outputFile === undefined && outputFile !== undefined) {
        // The gate never ran, or it ran and said nothing: there is no log of
        // it to keep.
        await rm(outputFile, { force: true });
      }
      throw failed;
    }
    if (outputFile !== undefined) {
      // A gate that passed leaves no log behind.
      await rm(outputFile, { force: true });
    }
    passed.push(`${gate} — ok`);
  }
  return passed.join(", ");
}
