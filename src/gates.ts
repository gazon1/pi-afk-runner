/**
 * The gates the target repository runs, and the runner's own run of them.
 *
 * The list is the **target repository's**, and it is written down **once**:
 * `contract/afk-runner.md` copies it out of the target's own review skill,
 * `GATES` below is the runner's copy of that list, and a test holds the two
 * together. Two lists are two rules that drift apart, and the one that drifts
 * is the one that judges the work.
 *
 * The runner runs the gates itself. An agent that is told to run them is an
 * instruction, and an instruction is followed as often as not — the runner is
 * the one place that cannot forget. The agent still runs them, because it has
 * to fix what they report; the agent's word about them is not what the push
 * rests on.
 *
 * The gates run in the worktree, on the tree the agent left, and the tree they
 * judged is the tree that is pushed.
 */

import { mkdir, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

import { CommandFailed, CommandTimedOut, type CommandRunner } from "./git.js";

/**
 * The gates the target repository runs, in the order they run.
 *
 * These are the **repository's** gates, not the runner's: the contract names
 * them, and a runner that judged a change by a gate of its own invention
 * would be judging it by a rule the repository does not have.
 *
 * The list is the whole of it. `just gate` is not it: it runs the Maestro
 * flows on a device, and it does not run `docs-audit`.
 */
export const GATES = ["./check.sh", "just tcheck-evals", "just docs-audit"] as const;

/** One of the target repository's gates. */
export type Gate = (typeof GATES)[number];

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
 * gates are written down: a gate named `./check.sh` is run by the shell, and
 * a gate named `just <recipe>` is run by `just`.
 */
export function gateInvocation(gate: string): GateInvocation {
  if (gate.startsWith("./")) {
    return { command: "bash", args: [gate] };
  }
  const [command, ...args] = gate.split(" ");
  return { command: command ?? gate, args };
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
  const said = firstLine(options.output);
  const how = options.exitCode === undefined ? "failed" : `failed (exit ${options.exitCode})`;
  return said === ""
    ? `the gate ${options.gate} ${how}`
    : `the gate ${options.gate} ${how}: ${said}`;
}

/** The first line of what a gate printed. */
function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    if (line.trim() !== "") {
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
async function gateFailure(
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
}): Promise<string> {
  const startedAt = Date.now();
  const passed: string[] = [];
  for (const gate of GATES) {
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
        timeoutMs: Math.min(GATE_TIMEOUT_MS, options.budgetMs, left),
        // The tail of the output is the evidence; the rest is noise the
        // runner neither keeps nor records.
        maxOutputBytes: GATE_OUTPUT_LIMIT_BYTES,
        // The build the gate starts dies with the gate: a build that keeps
        // going writes into the worktree the runner restores and pushes.
        killGroup: true,
        // The whole of it goes to the file, so that the record can quote the
        // tail and still say where the rest of it is.
        ...(outputFile === undefined ? {} : { outputFile }),
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
