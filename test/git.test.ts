/**
 * The git the runner runs: its errors, its bound, and what it reads.
 *
 * The things above the seam rely on are that a git which refused is a
 * `CommandFailed` with its exit code, that a git which hangs does not hold the
 * run, and that a git which reads a payload gets the payload the runner wrote.
 * The first and the third are checked against the real binary, the second
 * against a git that ignores the kill signal.
 */

import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CommandFailed,
  CommandTimedOut,
  changedPaths,
  claimMessage,
  claimTagObject,
  gitFailure,
  runGitWithTimeout,
  type GitRunner,
} from "../src/git.js";
import { createFixtureRepository, git, gitOutput } from "./git-sandbox.js";

/** The directories the tests made. */
const made: string[] = [];

/** A directory of its own, removed when the file is done. */
async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "afk-git-"));
  made.push(directory);
  return directory;
}

afterEach(async () => {
  while (made.length > 0) {
    const directory = made.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

describe("the git the runner runs", () => {
  it("says a git that refused with the exit code it gave", async () => {
    const directory = await scratch();

    const failure = await runGitWithTimeout(
      ["rev-parse", "--verify", "refs/heads/afk-no-such-branch"],
      { cwd: directory },
      30_000,
    ).catch((error: unknown) => error);

    // The code above the seam reads the exit code: a conflict is `1`, a
    // missing ref is `128`, and the difference is what tells them apart.
    expect(failure).toBeInstanceOf(CommandFailed);
    expect((failure as CommandFailed).exitCode).toBe(128);
  });

  it("fails at once when the directory is not there", async () => {
    const directory = await scratch();
    const started = Date.now();

    const failure = await runGitWithTimeout(
      ["version"],
      { cwd: join(directory, "gone") },
      200,
    ).catch((error: unknown) => error);

    // The git never ran, so there is nothing to wait for: the call says so at
    // once instead of holding the run until the bound is spent.
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(CommandTimedOut);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("stops waiting for a git that ignores the kill signal", async () => {
    const directory = await scratch();
    // A git that ignores the signal it is given, and that is still there
    // when the bound is spent.
    const stubborn = join(directory, "git");
    await writeFile(stubborn, "#!/bin/sh\ntrap '' INT\nsleep 2\nexit 0\n", "utf8");
    await chmod(stubborn, 0o755);

    const path = process.env["PATH"] ?? "";
    process.env["PATH"] = `${directory}:${path}`;
    try {
      const started = Date.now();
      const failure = await runGitWithTimeout(["version"], { cwd: directory }, 200, 100).catch(
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(CommandTimedOut);
      // The run stopped waiting at the bound. The child is still alive; the
      // run does not wait for it.
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      process.env["PATH"] = path;
    }
  });

  it("writes the payload to the git that reads it", async () => {
    const fixture = await createFixtureRepository();
    made.push(fixture.root);
    const sha = (
      await runGitWithTimeout(["rev-parse", "HEAD"], { cwd: fixture.repo }, 30_000)
    ).trim();

    // The claim is a tag object, and the object is written with `mktag`: the
    // payload goes to the git's standard input, and the git answers with the
    // id of what it wrote.
    const payload = claimTagObject({
      baseSha: sha,
      name: "afk-claim-issue-1",
      message: claimMessage(1, "the nonce"),
      timestampSeconds: 1_700_000_000,
    });
    const id = (
      await runGitWithTimeout(["mktag"], { cwd: fixture.repo, input: payload }, 30_000)
    ).trim();

    expect(id).toMatch(/^[0-9a-f]{40}$/);
    expect(
      (await runGitWithTimeout(["cat-file", "-t", id], { cwd: fixture.repo }, 30_000)).trim(),
    ).toBe("tag");

    // The private refs are removed with `update-ref --stdin`: a list of refs,
    // also on the standard input.
    await runGitWithTimeout(
      ["update-ref", "--stdin"],
      {
        cwd: fixture.repo,
        input: `create refs/afk/test ${sha}\n`,
      },
      30_000,
    );
    expect(
      (
        await runGitWithTimeout(["rev-parse", "refs/afk/test"], { cwd: fixture.repo }, 30_000)
      ).trim(),
    ).toBe(sha);
  });

  it("gives the child git the whole environment", async () => {
    const directory = await scratch();
    // A git that answers with what it was given.
    const echoing = join(directory, "git");
    await writeFile(echoing, '#!/bin/sh\necho "$GIT_AFK_MARKER"\n', "utf8");
    await chmod(echoing, 0o755);

    const path = process.env["PATH"] ?? "";
    process.env["PATH"] = `${directory}:${path}`;
    // The marker is set after this module was read: the list of keys the child
    // gets is made when the command runs, not when the module is loaded. A key
    // that appears between the two is a key the git still sees.
    process.env["GIT_AFK_MARKER"] = "seen";
    try {
      const output = await runGitWithTimeout(["version"], { cwd: directory }, 30_000);

      expect(output.trim()).toBe("seen");
    } finally {
      process.env["PATH"] = path;
      delete process.env["GIT_AFK_MARKER"];
    }
  });
});

describe("the failure a git call raises", () => {
  const answered = { exitCode: 0, stdOut: [], stdErr: [] };
  const context = { aborted: false, timeoutMs: 100, args: ["version"] };

  it("is none for a git that answered", () => {
    expect(gitFailure(undefined, answered, context)).toBeUndefined();
  });

  it("is the exit code for a git that refused", () => {
    const failure = gitFailure(
      undefined,
      {
        exitCode: 128,
        stdOut: [Buffer.from("out")],
        stdErr: [Buffer.from("fatal: no such ref\n")],
      },
      { ...context, args: ["rev-parse"] },
    );

    expect(failure).toBeInstanceOf(CommandFailed);
    expect((failure as CommandFailed).exitCode).toBe(128);
    expect((failure as CommandFailed).stderr).toBe("fatal: no such ref\n");
  });

  it("is a timeout for a git that was killed at the bound", () => {
    // A git that was killed at the bound never answered: it has no exit code,
    // and the bound is the only thing that killed it.
    const failure = gitFailure(
      new Error("Abort signal received"),
      { exitCode: null, stdOut: [], stdErr: [] },
      {
        ...context,
        aborted: true,
      },
    );

    expect(failure).toBeInstanceOf(CommandTimedOut);
    expect((failure as CommandTimedOut).timeoutMs).toBe(100);
  });

  it("is the error itself for a git that never ran", () => {
    const cause = new Error("spawn git ENOENT");

    expect(gitFailure(cause, { exitCode: null, stdOut: [], stdErr: [] }, context)).toBe(cause);
  });
});

describe("the work in the tree", () => {
  it("counts the paths that changed, and not the host's own files", async () => {
    // The work is what the tree holds, and the runner's guard reads it before
    // the push: a run that pushed a commit carrying nothing but the host's
    // own state opened a pull request with no implementation in it.
    const fixture = await createFixtureRepository();
    try {
      const runner: GitRunner = async (args, options) =>
        git(args, { cwd: options.cwd, env: fixture.env });
      const base = await gitOutput(["rev-parse", "HEAD"], {
        cwd: fixture.repo,
        env: fixture.env,
      });

      expect(await changedPaths(runner, fixture.repo, base)).toEqual([]);

      // The change the agent made, in the tree and not committed.
      await writeFile(join(fixture.repo, "README.md"), "# changed\n", "utf8");
      expect(await changedPaths(runner, fixture.repo, base)).toEqual(["README.md"]);

      // A new file is work too.
      await writeFile(join(fixture.repo, "new.ts"), "export const a = 1;\n", "utf8");
      expect(await changedPaths(runner, fixture.repo, base)).toEqual(["README.md", "new.ts"]);

      // The host's own state is the host's business: git ignores it, and the
      // runner does not count it. The ignore file itself is work — it is a
      // file the agent added to the tree.
      await writeFile(join(fixture.repo, ".gitignore"), ".local/\n", "utf8");
      await mkdir(join(fixture.repo, ".local", "state"), { recursive: true });
      await writeFile(join(fixture.repo, ".local", "state", "device-id"), "abc\n", "utf8");
      const paths = await changedPaths(runner, fixture.repo, base);
      expect(paths).toEqual(["README.md", ".gitignore", "new.ts"]);
      expect(paths.some((path) => path.startsWith(".local/"))).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });

  it("counts the branch's own commits, and not the base's own changes", async () => {
    // The branch may have started from a base older than the one the run
    // claimed: a diff against the base would read the base's own changes as
    // the branch's work.
    const fixture = await createFixtureRepository();
    try {
      const runner: GitRunner = async (args, options) =>
        git(args, { cwd: options.cwd, env: fixture.env });
      const base = await gitOutput(["rev-parse", "HEAD"], {
        cwd: fixture.repo,
        env: fixture.env,
      });

      await writeFile(join(fixture.repo, "src.ts"), "export const a = 1;\n", "utf8");
      await git(["add", "-A"], { cwd: fixture.repo, env: fixture.env });
      await git(["commit", "-q", "-m", "the work"], { cwd: fixture.repo, env: fixture.env });

      expect(await changedPaths(runner, fixture.repo, base)).toEqual(["src.ts"]);
    } finally {
      await fixture.dispose();
    }
  });
});
