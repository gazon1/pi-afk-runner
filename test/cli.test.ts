/**
 * The command line, as citty reads it.
 *
 * The command is the runner's front door: a systemd unit, a person at three
 * in the morning, or a script. So the flags are long, the values are checked,
 * and a flag the command does not have is an error — a misspelled `--gate`
 * would otherwise run the default gates and say nothing.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ARGS, parseArgs, prepareRun, usage } from "../src/cli.js";
import { defaultDeadlineMs } from "../src/budget.js";
import { fakeGit } from "./shared.js";

/** A git runner that answers what the repository's origin is. */
const originGit = fakeGit("git@github.com:gazon1/sing.git\n");

describe("the command line", () => {
  it("names every flag it has, in one place", () => {
    // The usage, the parsing and the runner's options are one list: a flag
    // written down twice is a flag whose two copies drift.
    expect(Object.keys(ARGS)).toContain("gate");
    expect(Object.keys(ARGS)).toContain("gate-timeout-ms");
  });

  it("prints the usage citty renders from that one list", async () => {
    const text = await usage();

    expect(text).toContain("--gate");
    expect(text).toContain("--gate-timeout-ms");
    expect(text).toContain("pi-afk-runner");
  });

  it("reads the gates it is given, in one flag", () => {
    const options = parseArgs(["--gate", "./check.sh --fast,just docs-audit"]);

    expect(options.gates).toEqual(["./check.sh --fast", "just docs-audit"]);
  });

  it("says that the gates are named in one flag", () => {
    // citty keeps the last of a repeated flag, so a second `--gate` would
    // quietly drop the first one.
    expect(() => parseArgs(["--gate", "a", "--gate", "b"])).toThrow("separated by commas");
  });

  it("reads how long one gate may take", () => {
    const options = parseArgs(["--gate-timeout-ms", "60000"]);

    expect(options.gateTimeoutMs).toBe(60_000);
  });

  it("says that a flag it does not have is not one of its flags", () => {
    // A misspelled `--gate` must not run the default gates and say nothing.
    expect(() => parseArgs(["--gates", "./check.sh"])).toThrow("unknown option --gates");
  });

  it("asks for the usage when it is asked for it", () => {
    expect(() => parseArgs(["--help"])).toThrow("help");
  });

  it("says that a repository is named as owner/name", () => {
    expect(() => parseArgs(["--repo", "sing"])).toThrow("owner/name");
  });

  it("says that an issue is a number", () => {
    expect(() => parseArgs(["--issue", "zero"])).toThrow("--issue must be a number");
  });

  it("says that --all and --issue cannot be combined", () => {
    expect(() => parseArgs(["--all", "--issue", "42"])).toThrow("cannot be combined");
  });

  it("reads how many issues --all works at once", () => {
    const options = parseArgs(["--all", "--workers", "3"]);

    expect(options.workers).toBe(3);
  });

  it("works one issue at a time when the command does not say otherwise", () => {
    expect(parseArgs(["--all"]).workers).toBeUndefined();
  });

  it("says that --workers needs --all", () => {
    // The workers are the sweep's: there is no queue to work without it.
    expect(() => parseArgs(["--workers", "2"])).toThrow("needs --all");
  });

  it("says that the number of workers is a number", () => {
    expect(() => parseArgs(["--all", "--workers", "many"])).toThrow("--workers must be a number");
  });
});

describe("the gates a run runs", () => {
  it("takes the command line over the repository's own file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-cli-"));
    try {
      await writeFile(
        join(dir, ".afk-runner.json"),
        JSON.stringify({ gates: ["just docs-audit"] }),
        "utf8",
      );

      const prepared = await prepareRun(["--checkout", dir, "--gate", "./check.sh --fast"], {
        git: originGit,
      });

      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      expect(prepared.options.gates).toEqual(["./check.sh --fast"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("takes the repository's own file over the contract's list", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-cli-"));
    try {
      await writeFile(
        join(dir, ".afk-runner.json"),
        JSON.stringify({ gates: ["just docs-audit"], gateTimeoutMs: 60_000 }),
        "utf8",
      );

      const prepared = await prepareRun(["--checkout", dir], { git: originGit });

      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      expect(prepared.options.gates).toEqual(["just docs-audit"]);
      expect(prepared.options.gateTimeoutMs).toBe(60_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("runs no gates when nothing says so", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-cli-"));
    try {
      const prepared = await prepareRun(["--checkout", dir], { git: originGit });

      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      expect(prepared.options.gates).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("gives the run a ceiling that follows the gates it runs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-cli-"));
    try {
      const prepared = await prepareRun(["--checkout", dir, "--gate", "./check.sh --fast"], {
        git: originGit,
      });

      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      // A run with one gate does not carry the budget of a run with three.
      expect(prepared.options.deadlineMs).toBe(defaultDeadlineMs(1));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("says that a repository's own file it cannot read ends the run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-cli-"));
    try {
      await writeFile(join(dir, ".afk-runner.json"), "{not json", "utf8");

      const prepared = await prepareRun(["--checkout", dir], { git: originGit });

      expect(prepared.ok).toBe(false);
      if (prepared.ok) return;
      expect((prepared.failure as Error).message).toContain("not valid JSON");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
