import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  GitCommandFailed,
  INHERITED_FROM_HOOK,
  SANDBOX_IDENTITY,
  assertOwnRepository,
  createFixtureRepository,
  git,
  gitOutput,
  sandboxEnv,
  treeEnv,
  type FixtureRepository,
} from "./git-sandbox.js";

/**
 * The sandbox exists because of what happened on 2026-10-23: a fixture ran
 * inside a hook, inherited the names git exports for hooks, and committed a
 * 12124-file deletion into the repository it ran in. Every fetch and every push
 * in every worktree of that repository failed afterwards.
 *
 * These tests are the contract, and the contract has three halves: the names are
 * removed, the walk stops at the fixture's own tree, and the fixture's
 * repository is its own repository.
 */

let fixture: FixtureRepository | undefined;

afterEach(async () => {
  await fixture?.dispose();
  fixture = undefined;
});

describe("the sandbox environment", () => {
  it("removes the names git exports for a hook", () => {
    const env = treeEnv({
      ...process.env,
      GIT_DIR: "/somebody/else/.git",
      GIT_WORK_TREE: "/somebody/else",
      GIT_INDEX_FILE: "/somebody/else/.git/index",
      GIT_COMMON_DIR: "/somebody/else/.git",
      PATH: process.env.PATH ?? "",
    });

    for (const name of INHERITED_FROM_HOOK) {
      expect(env[name]).toBeUndefined();
    }
    // Everything else is inherited: a test that cannot reach the network or
    // the user's configuration is a test that passes for the wrong reason.
    expect(env.PATH).toBe(process.env.PATH);
  });

  it("carries an identity, so a commit works with no configuration at all", () => {
    const env = sandboxEnv("/tmp/fixture");
    expect(env.GIT_AUTHOR_NAME).toBe(SANDBOX_IDENTITY.GIT_AUTHOR_NAME);
    expect(env.GIT_COMMITTER_EMAIL).toBe(SANDBOX_IDENTITY.GIT_COMMITTER_EMAIL);
  });

  it("sets the ceiling the upward walk must not pass", () => {
    expect(sandboxEnv("/tmp/fixture").GIT_CEILING_DIRECTORIES).toBe("/tmp/fixture");
  });
});

describe("the fixture repository", () => {
  it("is its own repository", async () => {
    fixture = await createFixtureRepository();
    // The assertion is the point: it says so when the fixture is not its own.
    await expect(assertOwnRepository(fixture.repo, fixture.env)).resolves.toBeUndefined();
    await expect(gitOutput(["rev-parse", "--show-toplevel"], {
      cwd: fixture.repo,
      env: fixture.env,
    })).resolves.toBe(fixture.repo);
  });

  it("has a commit, made without any git configuration", async () => {
    fixture = await createFixtureRepository();
    const head = await gitOutput(["rev-parse", "HEAD"], {
      cwd: fixture.repo,
      env: fixture.env,
    });
    expect(head).toMatch(/^[0-9a-f]{40}$/);

    // The commit is attributed to the fixture, not to whoever ran the test.
    const author = await gitOutput(["log", "-1", "--format=%an <%ae>"], {
      cwd: fixture.repo,
      env: fixture.env,
    });
    expect(author).toBe(`${SANDBOX_IDENTITY.GIT_AUTHOR_NAME} <${SANDBOX_IDENTITY.GIT_AUTHOR_EMAIL}>`);
  });

  it("cannot reach a repository above itself", async () => {
    const root = await mkdtemp(join(tmpdir(), "afk-ceiling-"));
    try {
      // A repository at the ceiling, which a command below it must not find:
      // the walk stops when the next directory it would enter is the ceiling.
      await git(["init", "-q", "-b", "main"], { cwd: root, env: sandboxEnv(root) });

      const inner = join(root, "inner");
      await mkdir(inner, { recursive: true });

      await expect(
        gitOutput(["rev-parse", "--show-toplevel"], {
          cwd: inner,
          env: sandboxEnv(root),
        }),
      ).rejects.toThrow(GitCommandFailed);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("has a remote it can push to, with its main branch already on it", async () => {
    fixture = await createFixtureRepository();
    const remote = await gitOutput(["remote", "get-url", "origin"], {
      cwd: fixture.repo,
      env: fixture.env,
    });
    expect(remote).toBe(fixture.remote);

    // The runner takes its worktree from `origin/main`, so the branch has to be
    // on the remote before anything else asks for it.
    const remoteHead = await gitOutput(["rev-parse", "main"], {
      cwd: fixture.remote,
      env: fixture.env,
    });
    const localHead = await gitOutput(["rev-parse", "main"], {
      cwd: fixture.repo,
      env: fixture.env,
    });
    expect(remoteHead).toBe(localHead);
  });
});

describe("a failing git command", () => {
  it("says what git said", async () => {
    fixture = await createFixtureRepository();
    const failure = await git(["rev-parse", "--verify", "no-such-ref"], {
      cwd: fixture.repo,
      env: fixture.env,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GitCommandFailed);
    const error = failure as GitCommandFailed;
    expect(error.exitCode).not.toBe(0);
    // The reason is in the message: a reader of a red test run sees
    // "Command failed" and nothing else.
    expect(error.message).toContain("git rev-parse --verify no-such-ref failed");
    expect(error.stderr.length).toBeGreaterThan(0);
  });
});
