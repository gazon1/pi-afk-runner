/**
 * The gates the runner runs, and what it says when one of them does not pass.
 *
 * A run runs no gate unless it is told to: the command line names them, or the
 * repository's own file does. The rest is about the failure: a gate that
 * refused the change, a host that cannot run the gate, and a gate that never
 * got to answer are three different stories, and the record tells them apart.
 */
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NO_GATES,
  GATE_CONFIG_FILE,
  GATE_OUTPUT_LIMIT_BYTES,
  GATE_TIMEOUT_MS,
  GateFailed,
  gateInvocation,
  readGateSettings,
  resolveGateSettings,
  runGates,
} from "../src/gates.js";
import { CommandFailed, CommandTimedOut, runCommand, type CommandRunner } from "../src/git.js";

/** The gates a run is told to run, in these tests. */
const GATES = ["./check.sh --fast", "just tcheck-evals", "just docs-audit"];

describe("the gates the runner runs", () => {
  it("runs no gate unless it is told to", async () => {
    // The runner's speed is the point of a run that is not a gate, and the
    // repository's own CI still judges the pull request.
    expect(resolveGateSettings({}).gates).toEqual([...NO_GATES]);
    await expect(
      runGates({ run: async () => "", cwd: "/the/worktree", budgetMs: 60_000 }),
    ).resolves.toBe("no gates to run");
  });

  it("runs a gate the way the contract writes it", () => {
    // The list is the only place the gates are written down, so the command
    // that runs one is derived from it.
    expect(gateInvocation("./check.sh --fast")).toEqual({
      command: "bash",
      args: ["./check.sh", "--fast"],
    });
    expect(gateInvocation("just tcheck-evals")).toEqual({
      command: "just",
      args: ["tcheck-evals"],
    });
  });

  it("runs the gates in order, in the worktree", async () => {
    const called: string[] = [];
    const run: CommandRunner = async (spec) => {
      called.push(`${spec.command} ${spec.args.join(" ")}`);
      return "";
    };

    const summary = await runGates({ run, cwd: "/the/worktree", budgetMs: 60_000, gates: GATES });

    expect(called).toEqual([
      "bash ./check.sh --fast",
      "just tcheck-evals",
      "just docs-audit",
    ]);
    expect(summary).toContain("./check.sh --fast — ok");
  });

  it("gives each gate the gate's own budget, and no more than the run has left", async () => {
    const budgets: (number | undefined)[] = [];
    const run: CommandRunner = async (spec) => {
      budgets.push(spec.timeoutMs);
      return "";
    };

    // More of the run left than any gate may take: every gate gets its own
    // budget, whatever the clock did between them.
    await runGates({
      run,
      cwd: "/the/worktree",
      budgetMs: GATE_TIMEOUT_MS + 60_000,
      gates: GATES,
    });
    expect(budgets).toEqual([GATE_TIMEOUT_MS, GATE_TIMEOUT_MS, GATE_TIMEOUT_MS]);

    // Less than a gate's own budget: no gate gets more than the run has left.
    // The left-over shrinks by the milliseconds that pass, so the share is
    // bounded and not fixed — an exact figure here asserts the clock, not the
    // gate.
    budgets.length = 0;
    await runGates({ run, cwd: "/the/worktree", budgetMs: 90_000, gates: GATES });
    expect(budgets).toHaveLength(GATES.length);
    for (const budget of budgets) {
      expect(budget).toBeGreaterThan(0);
      expect(budget).toBeLessThanOrEqual(90_000);
    }
  });

  it("stops at the first gate that does not pass", async () => {
    const called: string[] = [];
    const run: CommandRunner = async (spec) => {
      called.push(`${spec.command} ${spec.args.join(" ")}`);
      if (spec.command === "just" && spec.args[0] === "tcheck-evals") {
        throw new CommandFailed(2, "just", [...spec.args], "", "the evals are red");
      }
      return "";
    };

    const failure = await runGates({ run, cwd: "/the/worktree", budgetMs: 60_000, gates: GATES }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(GateFailed);
    const gate = failure as GateFailed;
    expect(gate.gate).toBe("just tcheck-evals");
    expect(gate.reason).toBe("failed");
    expect(gate.exitCode).toBe(2);
    expect(gate.output).toContain("the evals are red");
    // The gates after it would judge a tree that is already refused.
    expect(called).toEqual(["bash ./check.sh --fast", "just tcheck-evals"]);
  });

  it("says that a gate could not run, when the host has no such program", async () => {
    // A host without `just` is not a gate that refused the change, and the
    // record must not say it was.
    const run: CommandRunner = async (spec) => {
      if (spec.command !== "just") {
        return "";
      }
      const error = new Error("spawn just ENOENT") as Error & { code?: string };
      error.code = "ENOENT";
      throw error;
    };

    const failure = await runGates({ run, cwd: "/the/worktree", budgetMs: 60_000, gates: GATES }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(GateFailed);
    const gate = failure as GateFailed;
    expect(gate.reason).toBe("missing");
    expect(gate.exitCode).toBeUndefined();
    expect(gate.message).toContain("just is not on this host");
  });

  it("says that a gate never got to answer, when it was killed", async () => {
    const run: CommandRunner = async (spec) => {
      throw new CommandTimedOut(1000, spec.command, spec.args, "half a build", "");
    };

    const failure = await runGates({ run, cwd: "/the/worktree", budgetMs: 60_000, gates: GATES }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(GateFailed);
    const gate = failure as GateFailed;
    expect(gate.reason).toBe("unfinished");
    expect(gate.exitCode).toBeUndefined();
    // What it printed before it was killed is the only evidence there is.
    expect(gate.output).toContain("half a build");
  });

  it("does not run a gate the run has no budget for", async () => {
    const called: string[] = [];
    const run: CommandRunner = async (spec) => {
      called.push(`${spec.command} ${spec.args.join(" ")}`);
      return "";
    };

    const failure = await runGates({ run, cwd: "/the/worktree", budgetMs: 0, gates: GATES }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(GateFailed);
    expect((failure as GateFailed).reason).toBe("unfinished");
    expect((failure as GateFailed).message).toContain("budget");
    expect(called).toEqual([]);
  });

  it("asks the command runner for the tail of a gate's output, and not the whole of it", async () => {
    // A failing `./check.sh` prints megabytes. The runner keeps the tail of
    // it, and the record carries no more than that.
    const limits: (number | undefined)[] = [];
    const run: CommandRunner = async (spec) => {
      limits.push(spec.maxOutputBytes);
      return "";
    };

    await runGates({ run, cwd: "/the/worktree", budgetMs: 60_000, gates: GATES });

    expect(limits).toEqual([
      GATE_OUTPUT_LIMIT_BYTES,
      GATE_OUTPUT_LIMIT_BYTES,
      GATE_OUTPUT_LIMIT_BYTES,
    ]);
  });

  it("keeps the tail of a command's output, and not the whole of it", async () => {
    // The cap is the command runner's: the output a gate prints is evidence,
    // not a thing to be kept whole.
    const output = await runCommand({
      command: "bash",
      args: ["-c", "head -c 200000 /dev/zero | tr '\\0' 'x'"],
      cwd: process.cwd(),
      maxOutputBytes: 1024,
    });

    expect(output.length).toBe(1024);
  });

  it("writes the whole of a gate's output to a file, and keeps the tail of it", async () => {
    // The record quotes the tail of what a gate printed; the file is where the
    // rest of it is. The two are the same output: the tail is the end of the
    // file.
    const dir = await mkdtemp(join(tmpdir(), "afk-gates-"));
    try {
      await writeFile(
        join(dir, "check.sh"),
        "#!/bin/sh\nfor i in $(seq 1 20000); do echo \"line $i\"; done\nexit 1\n",
        "utf8",
      );
      const log = join(dir, "gates.log");

      const failure = await runGates({
        run: runCommand,
        cwd: dir,
        budgetMs: 60_000,
        outputFile: log,
        gates: GATES,
      }).then(
        () => null,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(GateFailed);
      const gate = failure as GateFailed;
      expect(gate.outputFile).toBe(log);

      // The file holds the whole of it.
      const whole = await readFile(log, "utf8");
      expect(whole).toContain("line 1\n");
      expect(whole).toContain("line 20000\n");

      // The runner kept the tail of it, and not the whole of it.
      expect(gate.output.length).toBeLessThanOrEqual(GATE_OUTPUT_LIMIT_BYTES);
      expect(gate.output).toContain("line 20000");
      expect(gate.output).not.toContain("line 1\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves no log behind when the gates pass", async () => {
    // The log of a green build is evidence of nothing, and a diagnostics
    // directory full of them is a directory nobody reads.
    const dir = await mkdtemp(join(tmpdir(), "afk-gates-"));
    try {
      const log = join(dir, "gates.log");
      const run: CommandRunner = async (spec) => {
        // A runner that is asked for a file writes the command's output there.
        if (spec.outputFile !== undefined) {
          await writeFile(spec.outputFile, "the gate said this\n", "utf8");
        }
        return "";
      };

      await runGates({ run, cwd: dir, budgetMs: 60_000, outputFile: log, gates: GATES });

      expect(existsSync(log)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("names the last non-empty line of the gate's output", async () => {
    // The detail carries the last non-empty line, not the first: a build's
    // summary (or the bottom of a stack trace), never an arbitrary warning.
    const run: CommandRunner = async (spec) => {
      throw new CommandFailed(1, spec.command, [...spec.args], "w: Foo.kt:12:5 Unused import\nFAIL: test failed\n\n", "");
    };

    const failure = await runGates({ run, cwd: "/the/worktree", budgetMs: 60_000, gates: GATES }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(GateFailed);
    const gate = failure as GateFailed;
    expect(gate.message).toContain("FAIL: test failed");
    expect(gate.message).not.toContain("Unused import");
  });

  it("names the gate that failed, when it printed nothing", async () => {
    // A gate that says nothing has still refused the change, and the record
    // has to say which gate it was.
    const run: CommandRunner = async (spec) => {
      throw new CommandFailed(1, spec.command, [...spec.args], "", "");
    };

    const failure = await runGates({ run, cwd: "/the/worktree", budgetMs: 60_000, gates: GATES }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(GateFailed);
    const gate = failure as GateFailed;
    expect(gate.reason).toBe("failed");
    expect(gate.message).toContain("./check.sh");
    expect(gate.message).toContain("exit 1");
  });
});

describe("the gates a repository may carry in its own root", () => {
  it("has no file of its own, and so runs the contract's gates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-gate-config-"));
    try {
      expect(await readGateSettings(dir)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads the gates and the timeout the repository names", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-gate-config-"));
    try {
      await writeFile(
        join(dir, GATE_CONFIG_FILE),
        JSON.stringify({ gates: ["./check.sh --fast"], gateTimeoutMs: 60_000 }),
        "utf8",
      );

      const settings = await readGateSettings(dir);

      expect(settings?.gates).toEqual(["./check.sh --fast"]);
      expect(settings?.gateTimeoutMs).toBe(60_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("says that a file it cannot read is the repository's own mistake", async () => {
    // A runner that quietly falls back to the contract's gates would judge a
    // tree by a list the repository did not ask for.
    const dir = await mkdtemp(join(tmpdir(), "afk-gate-config-"));
    try {
      await writeFile(join(dir, GATE_CONFIG_FILE), "{not json", "utf8");

      await expect(readGateSettings(dir)).rejects.toThrow("not valid JSON");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("says that a gate which is not a command is not a gate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-gate-config-"));
    try {
      await writeFile(join(dir, GATE_CONFIG_FILE), JSON.stringify({ gates: [42] }), "utf8");

      await expect(readGateSettings(dir)).rejects.toThrow("every gate must be a command");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("takes the command line over the repository's file", () => {
    // A run started by hand says what it wants to run; a repository says what
    // a run on it runs.
    expect(resolveGateSettings({}).gates).toEqual([...NO_GATES]);
    expect(
      resolveGateSettings({ repo: { gates: ["./check.sh --fast"], gateTimeoutMs: 60_000 } }),
    ).toEqual({ gates: ["./check.sh --fast"], gateTimeoutMs: 60_000 });
    expect(
      resolveGateSettings({
        cli: { gates: ["just docs-audit"] },
        repo: { gates: ["./check.sh --fast"], gateTimeoutMs: 60_000 },
      }),
    ).toEqual({ gates: ["just docs-audit"], gateTimeoutMs: 60_000 });
  });

  it("runs the gates a run was told to run", async () => {
    const called: string[] = [];
    const run: CommandRunner = async (spec) => {
      called.push(`${spec.command} ${spec.args.join(" ")}`);
      return "";
    };

    await runGates({
      run,
      cwd: "/the/worktree",
      budgetMs: 60_000,
      gates: ["just docs-audit"],
    });

    expect(called).toEqual(["just docs-audit"]);
  });

  it("runs the gates with the PATH the repository's own setup named", async () => {
    // The gate CLI is an editable install of that checkout's own venv: a gate
    // that cannot find it never got to answer.
    const paths: (string | undefined)[] = [];
    const run: CommandRunner = async (spec) => {
      paths.push(spec.env?.["PATH"]);
      return "";
    };

    await runGates({
      run,
      cwd: "/the/worktree",
      budgetMs: 60_000,
      gates: ["just docs-audit"],
      env: { PATH: "/the/venv/bin:/usr/bin" },
    });

    expect(paths).toEqual(["/the/venv/bin:/usr/bin"]);
  });

  it("runs no gate at all, when the run was told to run none", async () => {
    const run: CommandRunner = async () => {
      throw new Error("no gate may run");
    };

    expect(await runGates({ run, cwd: "/the/worktree", budgetMs: 60_000, gates: [] })).toBe(
      "no gates to run",
    );
  });
});
