/**
 * Where an issue's worktree lives.
 *
 * The name of the directory is written in one place — `issueWorktreePath` — and
 * the four places that create, remove or restore that worktree ask it. The
 * tests below are the guard: a name spelled out a second time is a name the
 * two sides can disagree about, and the live door's restore is the sharp edge
 * of that — it restores the worktree the runner made, so a name that changed
 * on one side alone leaves the chat standing in an empty directory.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { issueWorktreePath } from "../src/git.js";

/** Where the runner's source is. */
const SOURCE = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/**
 * The name of the worktree's directory, wherever it is spelled out: a root
 * joined onto `issue-${…}`.
 *
 * The root may be a bare name or a property — `join(root, …)` and
 * `join(options.worktreeRoot, …)` are both spellings, and the second is the
 * shape the code used before the name moved into one function.
 */
const SPELLED = /join\(\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*,\s*`issue-\$\{/;

describe("the path of an issue's worktree", () => {
  it("is the issue's own directory under the worktree root", () => {
    expect(issueWorktreePath("/tmp/worktrees", 42)).toBe(
      join("/tmp/worktrees", "issue-42"),
    );
  });

  it("is spelled out in one place in the source", async () => {
    // The pattern has to catch the spelling the code used before, or the guard
    // below proves nothing: it has to fail on a second place.
    expect("join(options.worktreeRoot, `issue-${issue.number}`)").toMatch(SPELLED);

    const files = (await readdir(SOURCE)).sort();
    const spelled: string[] = [];
    for (const file of files) {
      if (!file.endsWith(".ts")) {
        continue;
      }
      const source = await readFile(join(SOURCE, file), "utf8");
      for (const match of source.matchAll(new RegExp(SPELLED, "g"))) {
        spelled.push(`${file}: ${match[0]}`);
      }
    }
    expect(spelled).toHaveLength(1);
    expect(spelled[0]).toContain("git.ts");
    expect(spelled[0]).toContain("issue-${");
  });

  it("is asked for by every place that creates, removes or restores the worktree", async () => {
    // The runner's worktree step, its review path and the reclaim, and the
    // live door that puts the worktree back.
    for (const file of ["runner.ts", "claim.ts", "extension.ts"]) {
      const source = await readFile(join(SOURCE, file), "utf8");
      expect(source, file).toContain("issueWorktreePath(");
    }
  });
});
