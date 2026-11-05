/**
 * The question the pool file is asked.
 *
 * `--show-pool` is a question, not a run: it says what the file means now,
 * and it takes no lock — a lock nobody gives back keeps the next runner out.
 *
 * The flag is read in one place, and the tests below say so: the parser reads
 * it, and nobody else does. A second reader is a second question, and the two
 * can disagree — the flag would be asked for in one spelling and answered in
 * another.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EXIT_OK, EXIT_USAGE, askedQuestion, main, parseArgs } from "../src/cli.js";
import { sourceFiles } from "./source.js";

/** What the runner wrote to a stream, and a way to stop watching. */
interface Recorder {
  readonly lines: string[];
  readonly restore: () => void;
}

/** Watch one of the runner's streams. */
function capture(stream: "stdout" | "stderr"): Recorder {
  const lines: string[] = [];
  const spy = vi.spyOn(process[stream], "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  return { lines, restore: () => spy.mockRestore() };
}

/** The agent's directory, empty. */
async function agentDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "afk-runner-show-pool-"));
  const agent = join(root, "agent");
  await mkdir(agent, { recursive: true });
  return agent;
}

/** A model the runner carries, and the host has a key for. */
const MODEL = "minimax/MiniMax-M2.7";

describe("the question the pool file is asked", () => {
  const recorders: Recorder[] = [];

  afterEach(() => {
    for (const recorder of recorders.splice(0)) {
      recorder.restore();
    }
  });

  it("says_that_there_is_no_pool_file", async () => {
    const agent = await agentDirectory();
    const out = capture("stdout");
    recorders.push(out);
    try {
      const code = await main(["--show-pool", "--agent-dir", agent]);

      expect(code).toBe(EXIT_OK);
      expect(out.lines.join("")).toContain(
        `there is no pool file at ${join(agent, "models.yaml")}`,
      );
    } finally {
      await rm(join(agent, ".."), { recursive: true, force: true });
    }
  });

  it("says_what_the_file_means", async () => {
    const agent = await agentDirectory();
    await writeFile(
      join(agent, "models.yaml"),
      `models:\n  - model: ${MODEL}\n    priority: 100\n`,
      "utf8",
    );
    const out = capture("stdout");
    recorders.push(out);
    try {
      const code = await main(["--show-pool", "--agent-dir", agent]);

      expect(code).toBe(EXIT_OK);
      expect(out.lines.join("")).toContain(`${MODEL} — priority 100 — it would be used`);
    } finally {
      await rm(join(agent, ".."), { recursive: true, force: true });
    }
  });

  it("says_why_a_model_the_runner_does_not_carry_is_not_used", async () => {
    const agent = await agentDirectory();
    // A model the runner carries no gateway for cannot be used, and the host
    // has to see that: a file that names it and says nothing is a secret.
    await writeFile(
      join(agent, "models.yaml"),
      "models:\n  - model: fake/beam\n    priority: 100\n",
      "utf8",
    );
    const out = capture("stdout");
    recorders.push(out);
    try {
      const code = await main(["--show-pool", "--agent-dir", agent]);

      expect(code).toBe(EXIT_OK);
      expect(out.lines.join("")).toContain("fake/beam — priority 100 — it cannot be reached");
    } finally {
      await rm(join(agent, ".."), { recursive: true, force: true });
    }
  });

  it("says_why_a_file_it_cannot_read_is_wrong", async () => {
    const agent = await agentDirectory();
    // A key the runner does not know is an error, not something it ignores.
    await writeFile(
      join(agent, "models.yaml"),
      "models:\n  - model: fake/beam\n    priorety: 100\n",
      "utf8",
    );
    const err = capture("stderr");
    recorders.push(err);
    try {
      const code = await main(["--show-pool", "--agent-dir", agent]);

      expect(code).toBe(EXIT_USAGE);
      expect(err.lines.join("")).toContain("priorety");
    } finally {
      await rm(join(agent, ".."), { recursive: true, force: true });
    }
  });

  it("takes_no_lock", async () => {
    const agent = await agentDirectory();
    const lockDirectory = join(agent, "..", "afk-runner");
    try {
      const code = await main(["--show-pool", "--agent-dir", agent, "--lock-dir", lockDirectory]);

      expect(code).toBe(EXIT_OK);
      // A lock nobody gives back keeps the next runner out: the question takes
      // none.
      expect(existsSync(lockDirectory)).toBe(false);
    } finally {
      await rm(join(agent, ".."), { recursive: true, force: true });
    }
  });

  it("is_asked_when_the_options_say_so", () => {
    // The options carry the flag, and the question is asked from them.
    expect(parseArgs(["--show-pool"]).showPool).toBe(true);
    expect(askedQuestion(["--show-pool"])?.showPool).toBe(true);
    expect(askedQuestion(["--all"])).toBeNull();
  });

  it("is_read_in_one_place_in_the_source", async () => {
    // The flag's name is read by the parser, in the parser's own file.
    const readers: string[] = [];
    for (const { file, code } of await sourceFiles()) {
      for (const _ of code.matchAll(/["'`]show-pool["'`]/g)) {
        readers.push(file);
      }
    }
    expect([...new Set(readers)]).toEqual(["cli.ts"]);

    // And nobody scans the raw arguments for it: the question is asked from
    // the options the parser built. A second reader of the arguments is a
    // second question, and the two can disagree about what was asked.
    const scans: string[] = [];
    for (const { file, code } of await sourceFiles()) {
      for (const match of code.matchAll(/argv[^\n]*show-pool/g)) {
        scans.push(`${file}: ${match[0].trim()}`);
      }
    }
    expect(scans).toEqual([]);
  });
});
