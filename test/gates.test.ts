/**
 * The gates the agent reports, and the check the runner makes of the report.
 *
 * The report is the only thing that stands between the work the agent left and
 * the tree the runner pushes, so each of the ways it can be wrong needs a
 * test that says so: no report, a failed gate, a gate nobody reported, and a
 * tree that moved after the report.
 */
import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  GATES,
  GATES_TOOL_NAME,
  assertGatesGreen,
  createGatesTool,
  type GateReport,
} from "../src/gates.js";
import { promptsDirectory } from "../src/session.js";
import { runGit } from "../src/git.js";
import { createFixtureRepository } from "./git-sandbox.js";

/** What the agent reports when every gate is green. */
const GREEN = {
  gates: GATES.map((gate) => ({ gate, outcome: "pass", detail: "ok" })),
};

/** The tool the runner gives the agent, as something a test can call. */
function gatesTool(options: {
  readonly cwd: string;
  readonly holder: { value?: GateReport };
}): { execute: (id: string, params: unknown) => Promise<unknown> } {
  return createGatesTool({ git: runGit, cwd: options.cwd, holder: options.holder }) as unknown as {
    execute: (id: string, params: unknown) => Promise<unknown>;
  };
}

describe("the gates the agent reports", () => {
  it("records what each gate said, and the tree it was made against", async () => {
    const fixture = await createFixtureRepository();
    try {
      const holder: { value?: GateReport } = {};
      const tool = gatesTool({ cwd: fixture.repo, holder });

      await tool.execute("call-1", GREEN);

      expect(holder.value?.outcomes.map((entry) => entry.gate)).toEqual([...GATES]);
      expect(holder.value?.tree).not.toBe("");
    } finally {
      await fixture.dispose();
    }
  });

  it("names the tool the agent ends its turn with", () => {
    expect(GATES_TOOL_NAME).toBe("agent_gates");
  });

  it("names every gate in the prompt that asks the agent to run them", async () => {
    // The runner refuses a run that reported no result for a gate, so the
    // prompt that asks for the report has to name the gates the runner wants.
    const prompt = await readFile(join(promptsDirectory(), "03-verify.md"), "utf8");
    for (const gate of GATES) {
      expect(prompt).toContain(gate);
    }
  });

  it("accepts a report whose gates are green and whose tree has not moved", async () => {
    const fixture = await createFixtureRepository();
    try {
      const holder: { value?: GateReport } = {};
      await gatesTool({ cwd: fixture.repo, holder }).execute("call-1", GREEN);

      await expect(
        assertGatesGreen({ git: runGit, cwd: fixture.repo, report: holder.value }),
      ).resolves.toBeUndefined();
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses a run whose agent reported no gates at all", async () => {
    const fixture = await createFixtureRepository();
    try {
      await expect(
        assertGatesGreen({ git: runGit, cwd: fixture.repo, report: undefined }),
      ).rejects.toThrow(/reported no gates/);
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses a gate that failed, and says which one", async () => {
    const fixture = await createFixtureRepository();
    try {
      const holder: { value?: GateReport } = {};
      await gatesTool({ cwd: fixture.repo, holder }).execute("call-1", {
        gates: [
          { gate: "./check.sh", outcome: "fail", detail: "the JVM tests are red" },
          { gate: "just tcheck-evals", outcome: "pass", detail: "ok" },
          { gate: "just docs-audit", outcome: "pass", detail: "ok" },
        ],
      });

      await expect(
        assertGatesGreen({ git: runGit, cwd: fixture.repo, report: holder.value }),
      ).rejects.toThrow(/the gates failed: \.\/check\.sh — the JVM tests are red/);
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses a report that names no result for one of the gates", async () => {
    const fixture = await createFixtureRepository();
    try {
      const holder: { value?: GateReport } = {};
      await gatesTool({ cwd: fixture.repo, holder }).execute("call-1", {
        gates: [
          { gate: "./check.sh", outcome: "pass", detail: "ok" },
          { gate: "just tcheck-evals", outcome: "pass", detail: "ok" },
        ],
      });

      await expect(
        assertGatesGreen({ git: runGit, cwd: fixture.repo, report: holder.value }),
      ).rejects.toThrow(/no result for just docs-audit/);
    } finally {
      await fixture.dispose();
    }
  });

  it("ignores a gate this workflow does not run", async () => {
    // `just gate` needs a device, and the agent was not asked to run it: the
    // three gates it was asked about are the ones that count.
    const fixture = await createFixtureRepository();
    try {
      const holder: { value?: GateReport } = {};
      await gatesTool({ cwd: fixture.repo, holder }).execute("call-1", {
        gates: [
          ...GREEN.gates,
          { gate: "just gate", outcome: "fail", detail: "no device" },
        ],
      });

      await expect(
        assertGatesGreen({ git: runGit, cwd: fixture.repo, report: holder.value }),
      ).resolves.toBeUndefined();
    } finally {
      await fixture.dispose();
    }
  });

  it("says what is wrong when the call carries no gates at all", async () => {
    const fixture = await createFixtureRepository();
    try {
      const holder: { value?: GateReport } = {};
      const tool = gatesTool({ cwd: fixture.repo, holder });

      await expect(tool.execute("call-1", {})).rejects.toThrow(
        /the gates tool takes a list of gates/,
      );
      expect(holder.value).toBeUndefined();
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses a tree that changed after the gates were reported", async () => {
    const fixture = await createFixtureRepository();
    try {
      const holder: { value?: GateReport } = {};
      await gatesTool({ cwd: fixture.repo, holder }).execute("call-1", GREEN);

      // A fix the self-review made after the gates ran: the gates saw a
      // different tree from the one the runner is about to push.
      await writeFile(join(fixture.repo, "late.txt"), "the late fix\n", "utf8");

      await expect(
        assertGatesGreen({ git: runGit, cwd: fixture.repo, report: holder.value }),
      ).rejects.toThrow(/changed after the gates were reported/);
    } finally {
      await fixture.dispose();
    }
  });
});
