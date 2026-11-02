/**
 * The branch an issue's work lives on.
 *
 * The name and the pattern that recognises it are written in one place —
 * `src/git.ts` — and the two places that have to agree ask it: the guard that
 * decides whether a worktree may be removed, and the merge pipeline that
 * decides which pull requests are its own.
 *
 * The tests below are the guard. A name spelled in three places is three
 * chances to disagree, and the disagreement is not a crash: it is a removal
 * guard that refuses the runner's own worktrees, or removes a human's, and a
 * merge pipeline that no longer sees the branches it is meant to land.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { WORK_BRANCH_PATTERN, removeWorktree, workBranch, type GitRunner } from "../src/git.js";
import { WORK_BRANCH_PATTERN as MERGE_WORK_BRANCH_PATTERN } from "../src/merge.js";
import { createFixtureRepository, git as sandboxGit, gitOutput } from "./git-sandbox.js";
import { sourceFiles } from "./source.js";

describe("the branch an issue's work lives on", () => {
  it("names the branch and recognises it from the one place", () => {
    expect(workBranch(42)).toBe("agent/issue-42");
    expect(WORK_BRANCH_PATTERN.test(workBranch(42))).toBe(true);
    expect(WORK_BRANCH_PATTERN.test(workBranch(7))).toBe(true);
  });

  it("recognises nothing but its own branches", () => {
    expect(WORK_BRANCH_PATTERN.test("feature/thing")).toBe(false);
    expect(WORK_BRANCH_PATTERN.test("agent/issue-42-extra")).toBe(false);
    expect(WORK_BRANCH_PATTERN.test("agent/issue-")).toBe(false);
    expect(WORK_BRANCH_PATTERN.test("issue-42")).toBe(false);
  });

  it("is spelled out in one place in the source", async () => {
    // The branch's name: the prefix and the segment are written once, and
    // everything else is composed from them. The spelling may be a string
    // (`agent/`) or a regular expression (`agent\/`), and both count.
    const spelled: string[] = [];
    for (const { file, code } of await sourceFiles()) {
      for (const match of code.matchAll(/agent\\?\//g)) {
        spelled.push(`${file}: ${match[0]}`);
      }
    }
    expect(spelled.length).toBeGreaterThan(0);
    expect([...new Set(spelled.map((entry) => entry.split(":")[0]))]).toEqual(["git.ts"]);

    // The pattern that recognises it: defined once, asked for everywhere else.
    const defined: string[] = [];
    for (const { file, code } of await sourceFiles()) {
      if (/WORK_BRANCH_PATTERN\s*=/.test(code)) {
        defined.push(file);
      }
    }
    expect(defined).toEqual(["git.ts"]);
  });

  it("is the pattern the merge pipeline asks", () => {
    // The same object, not a copy of it: the merge pipeline and the removal
    // guard cannot end up recognising different branches.
    expect(MERGE_WORK_BRANCH_PATTERN).toBe(WORK_BRANCH_PATTERN);
  });
});

describe("the guard that decides whether a worktree may be removed", () => {
  it("removes a worktree on the runner's own branch", async () => {
    const fixture = await createFixtureRepository();
    try {
      const git: GitRunner = (args, options) =>
        sandboxGit(args, { cwd: options.cwd, env: fixture.env });
      const path = join(fixture.root, "worktree-42");
      await gitOutput(["branch", workBranch(42)], { cwd: fixture.repo, env: fixture.env });
      await gitOutput(["worktree", "add", path, workBranch(42)], {
        cwd: fixture.repo,
        env: fixture.env,
      });
      expect(existsSync(path)).toBe(true);

      await removeWorktree(git, fixture.repo, path);

      expect(existsSync(path)).toBe(false);
      const listed = await gitOutput(["worktree", "list", "--porcelain"], {
        cwd: fixture.repo,
        env: fixture.env,
      });
      expect(listed).not.toContain(path);
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses a worktree on a branch that is not the runner's own", async () => {
    const fixture = await createFixtureRepository();
    try {
      const git: GitRunner = (args, options) =>
        sandboxGit(args, { cwd: options.cwd, env: fixture.env });
      const path = join(fixture.root, "worktree-human");
      await gitOutput(["branch", "feature/human"], { cwd: fixture.repo, env: fixture.env });
      await gitOutput(["worktree", "add", path, "feature/human"], {
        cwd: fixture.repo,
        env: fixture.env,
      });

      await expect(removeWorktree(git, fixture.repo, path)).rejects.toThrow(
        /refusing to remove worktree/,
      );

      // The worktree is still there: the guard refuses, it does not tidy up.
      expect(existsSync(path)).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });
});
