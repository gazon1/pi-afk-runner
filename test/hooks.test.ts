/**
 * The runner's own commits and pushes run no hook.
 *
 * The repository it works on has a pre-commit hook that lints and compiles and
 * a pre-push hook that runs a detekt verdict, and a run builds nothing. A hook
 * that refused the commit failed the run that was about to push the work — and
 * the work went with the worktree; a hook that refused the push ended the run
 * with the work already made.
 */

import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { pushWorkBranch } from "../src/git.js";
import { preserveUnfinishedWork } from "../src/runner.js";
import { createFixtureRepository, git, gitOutput } from "./git-sandbox.js";

/** A hook that refuses everything, in the fixture's own repository. */
async function refuse(repo: string, hook: string): Promise<void> {
  const path = join(repo, ".git", "hooks", hook);
  await writeFile(path, "#!/usr/bin/env bash\necho 'the gate is red' >&2\nexit 1\n", {
    encoding: "utf8",
    mode: 0o755,
  });
  await chmod(path, 0o755);
}

describe("the runner's own commits and pushes", () => {
  it("keeps the work when the pre-commit hook refuses", async () => {
    const fixture = await createFixtureRepository();
    try {
      await refuse(fixture.repo, "pre-commit");
      await writeFile(join(fixture.repo, "work.txt"), "the work\n", "utf8");
      await git(["add", "-A"], { cwd: fixture.repo, env: fixture.env });

      // The hook is live: a plain commit is refused here, so the commit below
      // going through is the flag and not a hook that never ran — a host whose
      // global `core.hooksPath` hides the fixture's hooks would fail this.
      await expect(
        git(["commit", "-q", "-m", "plain"], { cwd: fixture.repo, env: fixture.env }),
      ).rejects.toThrow(/the gate is red/);

      const kept = await preserveUnfinishedWork({
        git: (args, options) => git(args, { cwd: options.cwd, env: fixture.env }),
        cwd: fixture.repo,
        branch: "main",
      });

      expect(kept).not.toBeNull();
      const files = await gitOutput(["ls-tree", "--name-only", "main"], {
        cwd: fixture.repo,
        env: fixture.env,
      });
      expect(files).toContain("work.txt");
    } finally {
      await fixture.dispose();
    }
  });

  it("pushes the work when the pre-push hook refuses", async () => {
    const fixture = await createFixtureRepository();
    try {
      await refuse(fixture.repo, "pre-push");
      const head = await gitOutput(["rev-parse", "HEAD"], {
        cwd: fixture.repo,
        env: fixture.env,
      });

      // The hook is live: a plain push is refused here, so the push below going
      // through is the flag and not a hook that never ran.
      await expect(
        git(["push", "origin", "HEAD:refs/heads/scratch"], {
          cwd: fixture.repo,
          env: fixture.env,
        }),
      ).rejects.toThrow(/the gate is red/);

      await pushWorkBranch(
        (args, options) => git(args, { cwd: options.cwd, env: fixture.env }),
        fixture.repo,
        { remote: "origin", issueNumber: 42, sha: head },
      );

      const pushed = await gitOutput(["rev-parse", "refs/heads/agent/issue-42"], {
        cwd: fixture.remote,
        env: fixture.env,
      });
      expect(pushed).toBe(head);
    } finally {
      await fixture.dispose();
    }
  });
});
