/**
 * The packing: the repository as one document the agent reads.
 *
 * The tool is what the agent calls; the packer is what does the work. These
 * tests hold the tool to what the runner promises: it packs what the agent
 * names, it refuses what the runner will not have — the machine outside the
 * worktree, a directory that is not here, the files the policy refuses, a
 * document the context cannot hold — and it says which.
 *
 * The last two tests pack with the real repomix, because the seam the other
 * tests use is a fake: the promise that the pack holds no file the policy
 * refuses is only worth anything if the real packer keeps it.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createPackTool,
  insideWorktree,
  type PackOutcome,
  type PackRequest,
} from "../src/packing.js";

/** The worktrees the tests make, to be taken away again. */
const worktrees: string[] = [];

/** A worktree with a file in it, to pack. */
async function worktree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "afk-pack-test-"));
  worktrees.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
  return root;
}

afterEach(async () => {
  for (const root of worktrees.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

/** A packer that answers with what the test tells it to. */
function packerOf(outcome: PackOutcome): {
  pack: (request: PackRequest) => Promise<PackOutcome>;
  calls: PackRequest[];
} {
  const calls: PackRequest[] = [];
  return {
    calls,
    pack: async (request) => {
      calls.push(request);
      return outcome;
    },
  };
}

/** A pack that holds a small document. */
const SMALL: PackOutcome = {
  text: "<files>\n<file path=\"src/a.ts\">the code</file>\n</files>",
  paths: ["src/a.ts"],
  tokens: 42,
  suspicious: [],
};

describe("the pack tool", () => {
  it("answers with the packed document", async () => {
    const { pack, calls } = packerOf(SMALL);
    const tool = createPackTool({ cwd: await worktree(), pack });

    const result = await tool.execute("call-1", { path: "src" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("Packed 1 file(s), 42 tokens.");
    expect(result.content[0]?.text).toContain("<file path=\"src/a.ts\">");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("src");
  });

  it("packs the whole repository when no path is named", async () => {
    const { pack, calls } = packerOf(SMALL);
    const tool = createPackTool({ cwd: await worktree(), pack });

    await tool.execute("call-1", {});

    expect(calls[0]?.path).toBe(".");
  });

  it("passes the patterns and the flags through", async () => {
    const { pack, calls } = packerOf(SMALL);
    const tool = createPackTool({ cwd: await worktree(), pack });

    await tool.execute("call-1", {
      path: "src",
      include: "**/*.kt",
      ignore: "**/build/**",
      structureOnly: true,
    });

    expect(calls[0]?.include).toBe("**/*.kt");
    expect(calls[0]?.ignore).toBe("**/build/**");
    expect(calls[0]?.structureOnly).toBe(true);
  });

  it("refuses a path that climbs out of the worktree", async () => {
    const { pack, calls } = packerOf(SMALL);
    const tool = createPackTool({ cwd: await worktree(), pack });

    const result = await tool.execute("call-1", { path: "../.." });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("outside the repository");
    expect(calls).toHaveLength(0);
  });

  it("refuses a path that is not in the repository", async () => {
    // Repomix reads a two-segment name as a repository on GitHub and fetches
    // it. The runner fetches nothing the model names.
    const { pack, calls } = packerOf(SMALL);
    const tool = createPackTool({ cwd: await worktree(), pack });

    const result = await tool.execute("call-1", { path: "owner/repo" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("there is no owner/repo in the repository");
    expect(calls).toHaveLength(0);
  });

  it("packs again without the files the policy refuses", async () => {
    // The first pack holds a file nobody hands to an agent; the second one,
    // made without it, is the one the model reads.
    const calls: PackRequest[] = [];
    const pack = async (request: PackRequest): Promise<PackOutcome> => {
      calls.push(request);
      return calls.length === 1
        ? { ...SMALL, paths: ["config/.env", "src/a.ts"] }
        : { ...SMALL, paths: ["src/a.ts"] };
    };
    const tool = createPackTool({ cwd: await worktree(), pack });

    const result = await tool.execute("call-1", { path: "." });

    expect(calls).toHaveLength(2);
    expect(calls[1]?.ignore).toBe("config/.env");
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("Packed 1 file(s)");
  });

  it("refuses a pack that still holds a file the policy refuses", async () => {
    const { pack } = packerOf({ ...SMALL, paths: ["config/.env"] });
    const tool = createPackTool({ cwd: await worktree(), pack });

    const result = await tool.execute("call-1", { path: "." });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("nobody hands to an agent");
  });

  it("refuses a pack the context cannot hold, and says how to pack less", async () => {
    const { pack } = packerOf({ ...SMALL, tokens: 90_000 });
    const tool = createPackTool({ cwd: await worktree(), pack, maxTokens: 60_000 });

    const result = await tool.execute("call-1", { path: "." });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("90000 tokens");
    expect(result.content[0]?.text).toContain("structureOnly");
  });

  it("answers with a refusal when the pack fails", async () => {
    const tool = createPackTool({
      cwd: await worktree(),
      pack: async () => {
        throw new Error("the pack died");
      },
    });

    const result = await tool.execute("call-1", { path: "." });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("the pack died");
  });

  it("says how many files were left out as suspicious", async () => {
    const { pack } = packerOf({ ...SMALL, suspicious: ["secrets.txt"] });
    const tool = createPackTool({ cwd: await worktree(), pack });

    const result = await tool.execute("call-1", { path: "." });

    expect(result.content[0]?.text).toContain("1 file(s) were left out as suspicious");
  });
});

describe("the real packer", () => {
  it("packs the worktree and holds no file the policy refuses", async () => {
    const root = await worktree();
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config", ".env"), "SECRET_VALUE=1\n");
    await writeFile(join(root, "config", "secret.pem"), "-----BEGIN KEY-----\n");
    await writeFile(join(root, "config", ".env.example"), "SECRET_VALUE=\n");
    const tool = createPackTool({ cwd: root });

    const result = await tool.execute("call-1", { path: "." });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(text).not.toContain("SECRET_VALUE=1");
    expect(text).not.toContain("BEGIN KEY");
    // The template carries no secret, and the policy allows it.
    expect(text).toContain(".env.example");
  });

  it("refuses a path that is not in the worktree, and fetches nothing", async () => {
    const tool = createPackTool({ cwd: await worktree() });

    const result = await tool.execute("call-1", { path: "octocat/Hello-World" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("there is no octocat/Hello-World in the repository");
  });
});

describe("the worktree's own paths", () => {
  it("keeps a path that stays inside", () => {
    expect(insideWorktree("/tmp/worktree", "src/main.kt")).toBe(true);
    expect(insideWorktree("/tmp/worktree", ".")).toBe(true);
    expect(insideWorktree("/tmp/worktree", "/tmp/worktree/src")).toBe(true);
  });

  it("refuses a path that climbs out", () => {
    expect(insideWorktree("/tmp/worktree", "..")).toBe(false);
    expect(insideWorktree("/tmp/worktree", "../../etc")).toBe(false);
    expect(insideWorktree("/tmp/worktree", "/etc/passwd")).toBe(false);
  });
});
