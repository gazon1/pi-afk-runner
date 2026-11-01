import { describe, expect, it } from "vitest";

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_PIPELINE,
  DEFAULT_STEPS,
  PIPELINE_PATH,
  STEP_KINDS,
  STEP_NAMES,
  parsePipeline,
  readPipeline,
} from "../src/pipeline.js";
import { STEP_EXIT_CODES } from "../src/cli.js";
import { runGit } from "../src/git.js";
import { VERDICT_TOOL_NAME } from "../src/session.js";
import { runOnce, type RunOptions } from "../src/runner.js";
import { createFixtureRepository } from "./git-sandbox.js";

/** Whether the session is the reviewer's — the one with the verdict tool. */
function isReviewer(tools: readonly unknown[] | undefined): boolean {
  return (tools ?? []).some(
    (tool) => (tool as { readonly name?: string }).name === VERDICT_TOOL_NAME,
  );
}

describe("the pipeline a repository declares", () => {
  it("is the runner's own steps when nothing is declared", () => {
    // The default is the list the runner has always taken, in the order it has
    // always taken them: a repository that says nothing runs what it ran
    // before.
    expect(DEFAULT_PIPELINE.steps).toEqual([
      "claim",
      "worktree",
      "session",
      "push",
      "pull-request",
      "review",
      "re-count",
    ]);
    expect(DEFAULT_PIPELINE.gates).toEqual([]);
  });

  it("reads the steps in the order they are written", () => {
    const pipeline = parsePipeline(
      ["steps:", "  - claim", "  - worktree", "  - session", "  - push"].join("\n"),
    );

    expect(pipeline.steps).toEqual(["claim", "worktree", "session", "push"]);
  });

  it("refuses a step kind the runner does not know", () => {
    // The failure comes when the file is read, not half-way through a run: a
    // repository that names a step the runner has not got must not have its
    // issue claimed first. And the failure names the kinds the runner knows,
    // because the reader of it has to be able to fix it.
    expect(() => parsePipeline(["steps:", "  - claim", "  - frobnicate"].join("\n"))).toThrow(
      /unknown step kind "frobnicate" — the runner knows: claim, worktree, session, gates, push, pull-request, review, re-count/,
    );
  });

  it("refuses a step it declares twice", () => {
    expect(() => parsePipeline(["steps:", "  - claim", "  - claim"].join("\n"))).toThrow(
      /declares the step "claim" twice/,
    );
  });

  it("refuses a pipeline that declares no claim step", () => {
    // The claim is what stops two runners working the same issue. The runner
    // does not trust the queue's query to keep that promise, and it does not
    // trust a file either.
    expect(() => parsePipeline(["steps:", "  - worktree", "  - session"].join("\n"))).toThrow(
      /declares no claim step/,
    );
  });

  it("gives every step an exit code", () => {
    // The step's wording and the process's exit code live in two files, and a
    // step that is in one and not the other is a step whose failure reads as
    // "1" to whoever reads the exit code.
    const missing = STEP_KINDS.filter((kind) => !(STEP_NAMES[kind] in STEP_EXIT_CODES));

    expect(missing).toEqual([]);
  });

  it("refuses a file that is not a pipeline", () => {
    expect(() => parsePipeline("steps: claim\n")).toThrow(/not a list/);
    expect(() => parsePipeline("- claim\n")).toThrow(/not a pipeline/);
    expect(() => parsePipeline("steps: [\n")).toThrow(/not YAML/);
  });

  it("reads the gate commands", () => {
    const pipeline = parsePipeline(
      ["steps:", "  - claim", "  - gates", "gates:", "  - ./check.sh", "  - just docs-audit"].join(
        "\n",
      ),
    );

    expect(pipeline.gates).toEqual(["./check.sh", "just docs-audit"]);
    expect(pipeline.steps).toEqual(["claim", "gates"]);
  });

  it("puts the gates step where the gates belong when no step list is declared", () => {
    // The gates judge the work the session did, so they come after it.
    const pipeline = parsePipeline(["gates:", "  - ./check.sh"].join("\n"));

    expect(pipeline.steps).toEqual([
      "claim",
      "worktree",
      "session",
      "gates",
      "push",
      "pull-request",
      "review",
      "re-count",
    ]);
  });

  it("is the default when the file says nothing", () => {
    expect(parsePipeline("").steps).toEqual(DEFAULT_STEPS);
    expect(parsePipeline("# a comment\n").steps).toEqual(DEFAULT_STEPS);
  });

  it("leaves the keys it does not read alone", () => {
    // The file is the repository's, and it may say things about prompts and
    // skills that this runner does not read yet.
    const pipeline = parsePipeline(
      ["prompts:", "  - 01-brief.md", "steps:", "  - claim"].join("\n"),
    );

    expect(pipeline.steps).toEqual(["claim"]);
  });

  it("is the default when the repository declares no file", async () => {
    const root = await mkdtemp(join(tmpdir(), "afk-pipeline-"));
    try {
      expect((await readPipeline(root)).steps).toEqual(DEFAULT_STEPS);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("is read from the repository's own file", async () => {
    const root = await mkdtemp(join(tmpdir(), "afk-pipeline-"));
    try {
      await mkdir(join(root, ".afk-runner"), { recursive: true });
      await writeFile(
        join(root, PIPELINE_PATH),
        ["steps:", "  - claim", "  - worktree"].join("\n"),
        "utf8",
      );

      expect((await readPipeline(root)).steps).toEqual(["claim", "worktree"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("is read from the file the repository spells either way", async () => {
    const root = await mkdtemp(join(tmpdir(), "afk-pipeline-"));
    try {
      await mkdir(join(root, ".afk-runner"), { recursive: true });
      await writeFile(
        join(root, ".afk-runner/pipeline.yaml"),
        ["steps:", "  - claim"].join("\n"),
        "utf8",
      );

      expect((await readPipeline(root)).steps).toEqual(["claim"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("the run that follows a pipeline", () => {
  /** The gh the run talks to, and the calls it made. */
  function stubGh(): {
    gh: (args: readonly string[]) => Promise<string>;
    calls: string[];
  } {
    const calls: string[] = [];
    const gh = async (args: readonly string[]): Promise<string> => {
      calls.push(`gh ${args.join(" ")}`);
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([
          { number: 42, title: "an issue", updatedAt: "", labels: [] },
        ]);
      }
      if (args[0] === "pr" && args[1] === "list") {
        return "[]";
      }
      if (args[0] === "pr" && args[1] === "create") {
        return "https://github.com/gazon1/sing/pull/1040\n";
      }
      if (args[0] === "issue" && args[1] === "view") {
        // The shape the queue really has: the brief is in the body, and no
        // comment carries the marker.
        return JSON.stringify({
          body: "**What this is:** the work\n\n**Fix:** 1. do it",
          comments: [{ body: "a comment" }],
          title: "an issue",
          labels: [],
          updatedAt: "",
          state: "OPEN",
        });
      }
      return "";
    };
    return { gh, calls };
  }

  /** The run options a composition test needs. */
  function runOptions(
    fixture: Awaited<ReturnType<typeof createFixtureRepository>>,
    gh: (args: readonly string[]) => Promise<string>,
    commands: string[],
  ): RunOptions {
    const worked = new Set<string>();
    return {
      repo: "gazon1/sing",
      checkout: fixture.repo,
      remote: fixture.remote,
      baseBranch: "main",
      worktreeRoot: join(fixture.root, "worktrees"),
      git: (args, options) => runGit(args, options),
      gh,
      run: async (spec) => {
        commands.push(`${spec.command} ${spec.args.join(" ")}`);
        return JSON.stringify({ verdict: "ci.yml  run 1  success" });
      },
      session: async ({ cwd, tools }) => {
        if (isReviewer(tools)) {
          // The reviewer: it answers with a verdict and nothing else.
          return {
            async prompt() {
              const tool = (tools ?? [])[0] as unknown as {
                execute: (id: string, params: unknown) => Promise<unknown>;
              };
              await tool.execute("call-1", { verdict: "pass", findings: [] });
            },
            async abort() {},
            dispose() {},
          };
        }
        // The implementer: it writes the work and commits it, once.
        return {
          async prompt() {
            if (worked.has(cwd)) {
              return;
            }
            worked.add(cwd);
            await writeFile(join(cwd, "work.txt"), "the work\n", "utf8");
            await runGit(["add", "-A"], { cwd });
            await runGit(
              [
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.com",
                "commit",
                "-q",
                "-m",
                "the work",
              ],
              { cwd },
            );
          },
          async abort() {},
          dispose() {},
        };
      },
      deadlineMs: 60_000,
      staleAfterMs: 7 * 24 * 60 * 60 * 1000,
      now: new Date("2026-10-30T09:00:00Z"),
      nonce: "nonce-42",
      runId: "2026-10-30T09-00-00-000Z-abcdef12",
    };
  }

  /** A fixture repository with the setup script and a pipeline file. */
  async function fixtureWith(pipeline: string): Promise<
    Awaited<ReturnType<typeof createFixtureRepository>>
  > {
    const fixture = await createFixtureRepository({
      files: { "scripts/setup-worktree.sh": "#!/usr/bin/env bash\nset -euo pipefail\n" },
    });
    await mkdir(join(fixture.repo, ".afk-runner"), { recursive: true });
    await writeFile(join(fixture.repo, PIPELINE_PATH), pipeline, "utf8");
    return fixture;
  }

  it("takes the steps the pipeline declares, in the order it declares them", async () => {
    // The gates step comes before the session here, and the run takes it
    // there: the pipeline says what the run does, and the runner's own steps
    // are what they do.
    const fixture = await fixtureWith(
      [
        "steps:",
        "  - claim",
        "  - worktree",
        "  - gates",
        "  - session",
        "  - push",
        "  - pull-request",
        "  - review",
        "  - re-count",
        "gates:",
        "  - ./check.sh",
      ].join("\n"),
    );
    try {
      const { gh } = stubGh();
      const commands: string[] = [];
      const result = await runOnce(runOptions(fixture, gh, commands));

      expect(result.steps.map((step) => step.step)).toEqual([
        "claim",
        "worktree",
        "gates",
        "session",
        "push",
        "pull request",
        "review",
        "re-count",
      ]);

      // And the gate the repository declared is the gate that ran.
      expect(commands.some((command) => command.includes("./check.sh"))).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });

  it("takes the runner's own steps when the repository declares no pipeline", async () => {
    const fixture = await createFixtureRepository({
      files: { "scripts/setup-worktree.sh": "#!/usr/bin/env bash\nset -euo pipefail\n" },
    });
    try {
      const { gh } = stubGh();
      const commands: string[] = [];
      const result = await runOnce(runOptions(fixture, gh, commands));

      expect(result.steps.map((step) => step.step)).toEqual([
        "claim",
        "worktree",
        "session",
        "push",
        "pull request",
        "review",
        "re-count",
      ]);
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses an unknown step kind before it claims anything", async () => {
    const fixture = await fixtureWith(
      ["steps:", "  - claim", "  - frobnicate"].join("\n"),
    );
    try {
      const { gh, calls } = stubGh();
      const commands: string[] = [];

      await expect(runOnce(runOptions(fixture, gh, commands))).rejects.toThrow(
        /unknown step kind "frobnicate"/,
      );

      // Nothing was claimed: the run stopped before it took an issue.
      expect(calls.some((call) => call.includes("--add-label agent-in-progress"))).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });
});
