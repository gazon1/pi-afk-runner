import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  RECOUNT_LABEL,
  REVIEW_MARKER,
  mergePullRequestArgs,
  newestReviewVerdict,
  openPullRequestsArgs,
  type OpenPullRequest,
} from "../src/gh.js";
import { runGit, type CommandRunner } from "../src/git.js";
import {
  issueNumberFromBranch,
  mergeReviewedPullRequests,
  type MergeOptions,
} from "../src/merge.js";
import {
  VERDICT_TOOL_NAME,
  type AgentSession,
  type SessionFactory,
} from "../src/session.js";
import { createFixtureRepository, gitOutput } from "./git-sandbox.js";

/** The stand-in for the repository's own setup script. */
const SETUP = "#!/usr/bin/env bash\nset -euo pipefail\n";

/** The reviewer: a session that ends on the verdict tool with `verdict`. */
function reviewer(tools: readonly unknown[] | undefined, verdict: "pass" | "fail") {
  return {
    async prompt() {
      const tool = tools?.[0] as {
        execute: (id: string, params: unknown) => Promise<unknown>;
      };
      await tool.execute("call-1", { verdict, findings: [] });
    },
    async abort() {},
    dispose() {},
  };
}

function isReviewer(tools: readonly unknown[] | undefined): boolean {
  return (tools ?? []).some(
    (tool) => (tool as { readonly name?: string }).name === VERDICT_TOOL_NAME,
  );
}

/**
 * A session factory whose reviewer passes, and whose merge agent resolves a
 * conflict by writing `shared.txt`.
 */
function resolvingSession(content = "resolved\n"): SessionFactory {
  return async ({ cwd, tools }): Promise<AgentSession> => {
    if (isReviewer(tools)) {
      return reviewer(tools, "pass");
    }
    return {
      async prompt() {
        await writeFile(join(cwd, "shared.txt"), content, "utf8");
      },
      async abort() {},
      dispose() {},
    };
  };
}

/** A candidate the collab pipeline considers landable. */
function reviewedPullRequest(
  overrides: Partial<OpenPullRequest> = {},
): OpenPullRequest {
  return {
    number: 7,
    title: "an issue",
    headRefName: "agent/issue-42",
    isDraft: false,
    labels: [RECOUNT_LABEL],
    comments: [`${REVIEW_MARKER}\n\n**Verdict:** pass`],
    ...overrides,
  };
}

/** A `gh` that answers the pipeline's calls and remembers what was landed. */
function stubGh(pullRequests: readonly OpenPullRequest[]): {
  gh: (args: readonly string[]) => Promise<string>;
  calls: string[];
  merged: number[];
} {
  const calls: string[] = [];
  const merged: number[] = [];
  const gh = async (args: readonly string[]): Promise<string> => {
    calls.push(`gh ${args.join(" ")}`);
    if (args[0] === "pr" && args[1] === "list") {
      return JSON.stringify(pullRequests);
    }
    if (args[0] === "pr" && args[1] === "merge") {
      merged.push(Number(args[2]));
    }
    return "";
  };
  return { gh, calls, merged };
}

/** The repository's CI tool, answering green. */
const okRun: CommandRunner = async (spec) =>
  spec.command === "python3"
    ? JSON.stringify({ workflow: "ci.yml", verdict: "ci.yml  run 1  success", exit: 0 })
    : "";

/** A merge run over a fixture. */
function options(
  fixture: Awaited<ReturnType<typeof createFixtureRepository>>,
  gh: MergeOptions["gh"],
  overrides: Partial<MergeOptions> = {},
): MergeOptions {
  return {
    repo: "gazon1/sing",
    checkout: fixture.repo,
    remote: fixture.remote,
    baseBranch: "main",
    worktreeRoot: join(fixture.root, "worktrees"),
    git: (args, gitOptions) => runGit(args, gitOptions),
    gh,
    run: okRun,
    session: resolvingSession(),
    deadlineMs: 60_000,
    now: new Date("2026-11-02T09:00:00Z"),
    runId: "2026-11-02T09-00-00-000Z-abcdef12",
    ...overrides,
  };
}

/** Put a commit on `agent/issue-42` and push it, without touching the base. */
async function pushBranch(
  fixture: Awaited<ReturnType<typeof createFixtureRepository>>,
  file = "work.txt",
  content = "the work\n",
): Promise<string> {
  await gitOutput(["checkout", "-q", "-b", "agent/issue-42"], {
    cwd: fixture.repo,
    env: fixture.env,
  });
  const sha = await commitOn(fixture, file, content, "the work");
  await gitOutput(["push", "-q", fixture.remote, `${sha}:refs/heads/agent/issue-42`], {
    cwd: fixture.repo,
    env: fixture.env,
  });
  return sha;
}

/** Move `main`: a commit on the checked-out branch, pushed. */
async function moveMain(
  fixture: Awaited<ReturnType<typeof createFixtureRepository>>,
  content: string,
): Promise<void> {
  await gitOutput(["checkout", "-q", "main"], { cwd: fixture.repo, env: fixture.env });
  const sha = await commitOn(fixture, "shared.txt", content, "the base moves");
  await gitOutput(["push", "-q", fixture.remote, `${sha}:refs/heads/main`], {
    cwd: fixture.repo,
    env: fixture.env,
  });
}

async function commitOn(
  fixture: Awaited<ReturnType<typeof createFixtureRepository>>,
  file: string,
  content: string,
  message: string,
): Promise<string> {
  await mkdir(dirname(join(fixture.repo, file)), { recursive: true });
  await writeFile(join(fixture.repo, file), content, "utf8");
  await gitOutput(["add", "-A"], { cwd: fixture.repo, env: fixture.env });
  await gitOutput(
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "-q",
      "-m",
      message,
    ],
    { cwd: fixture.repo, env: fixture.env },
  );
  return gitOutput(["rev-parse", "HEAD"], { cwd: fixture.repo, env: fixture.env });
}

describe("the review verdict the merge gate reads", () => {
  it("reads the newest marked comment and nothing else", () => {
    const pass = `${REVIEW_MARKER}\n\n**Verdict:** pass`;
    const fail = `${REVIEW_MARKER}\n\n**Verdict:** fail`;

    // The newest marked comment decides.
    expect(newestReviewVerdict([pass, fail])).toBe("fail");
    expect(newestReviewVerdict([fail, pass])).toBe("pass");

    // A comment that merely quotes the marker is not a review.
    expect(newestReviewVerdict(["the marker is <!-- agent-review -->"])).toBeNull();

    // A newest comment with no verdict decides nothing rather than falling
    // back to an older pass.
    expect(newestReviewVerdict([pass, `${REVIEW_MARKER}\n\nnotes only`])).toBeNull();

    // Two verdicts in one comment decide nothing.
    expect(
      newestReviewVerdict([`${REVIEW_MARKER}\n\n**Verdict:** pass\n**Verdict:** fail`]),
    ).toBeNull();

    // No review at all is not a pass.
    expect(newestReviewVerdict([])).toBeNull();
  });

  it("recognises the pipeline's own branches", () => {
    expect(issueNumberFromBranch("agent/issue-42")).toBe(42);
    expect(issueNumberFromBranch("agent/issue-7")).toBe(7);
    expect(issueNumberFromBranch("feature/thing")).toBeNull();
    expect(issueNumberFromBranch("agent/issue-42-extra")).toBeNull();
  });

  it("asks gh for the open pull requests against the base", () => {
    const args = openPullRequestsArgs("gazon1/sing", "main");
    expect(args).toContain("--base");
    expect(args[args.indexOf("--base") + 1]).toBe("main");
    expect(args).toContain("--state");
    expect(args).toContain("open");
    expect(args).toContain("--json");

    // The merge is the repository's shape: squash, and the branch goes.
    const merge = mergePullRequestArgs("gazon1/sing", 7);
    expect(merge).toContain("--squash");
    expect(merge).toContain("--delete-branch");
  });
});

describe("the merge pipeline", () => {
  it("test_only_a_reviewed_green_pull_request_is_merged", async () => {
    const fixture = await createFixtureRepository({ files: { "scripts/setup-worktree.sh": SETUP } });
    try {
      await pushBranch(fixture);
      const { gh, merged, calls } = stubGh([reviewedPullRequest()]);

      const result = await mergeReviewedPullRequests(options(fixture, gh));

      expect(result.merged).toEqual([7]);
      expect(result.failed).toEqual([]);
      expect(merged).toEqual([7]);
      // The branch did not move, so it was landed as CI judged it.
      expect(calls.some((call) => call.includes("pr merge 7"))).toBe(true);
      expect(calls.some((call) => call.includes("pr comment"))).toBe(false);

      const record = await readFile(
        join(
          fixture.repo,
          "build",
          "diagnostics",
          "merge",
          "pr-7",
          "2026-11-02T09-00-00-000Z-abcdef12.md",
        ),
        "utf8",
      );
      expect(record).toContain("# Merge pull request 7");
      expect(record).toContain("pull request: 7");
      expect(record).toContain("merge — ok");
    } finally {
      await fixture.dispose();
    }
  });

  it("test_a_failed_or_missing_review_is_not_merged", async () => {
    const fixture = await createFixtureRepository({ files: { "scripts/setup-worktree.sh": SETUP } });
    try {
      await pushBranch(fixture);
      const { gh, merged } = stubGh([
        reviewedPullRequest({ comments: [`${REVIEW_MARKER}\n\n**Verdict:** fail`] }),
      ]);

      const result = await mergeReviewedPullRequests(options(fixture, gh));

      expect(result.merged).toEqual([]);
      expect(merged).toEqual([]);
      expect(result.skipped[0]?.reason).toContain("fail");

      // And a pull request with no review is not a pass either.
      const none = stubGh([reviewedPullRequest({ comments: [] })]);
      const second = await mergeReviewedPullRequests(options(fixture, none.gh));
      expect(second.skipped[0]?.reason).toContain("no review verdict");
      expect(none.merged).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  it("test_a_red_ci_is_not_merged", async () => {
    const fixture = await createFixtureRepository({ files: { "scripts/setup-worktree.sh": SETUP } });
    try {
      await pushBranch(fixture);
      const { gh, merged } = stubGh([reviewedPullRequest()]);
      const redRun: CommandRunner = async () =>
        JSON.stringify({
          workflow: "ci.yml",
          verdict: "ci.yml  run 1  failure",
          exit: 1,
        });

      const result = await mergeReviewedPullRequests(
        options(fixture, gh, { run: redRun }),
      );

      expect(merged).toEqual([]);
      expect(result.skipped[0]?.reason).toContain("not green");
    } finally {
      await fixture.dispose();
    }
  });

  it("test_the_pull_request_is_read_again_before_it_is_merged", async () => {
    const fixture = await createFixtureRepository({ files: { "scripts/setup-worktree.sh": SETUP } });
    try {
      await pushBranch(fixture);
      let lists = 0;
      const merged: number[] = [];
      const gh = async (args: readonly string[]): Promise<string> => {
        if (args[0] === "pr" && args[1] === "list") {
          lists += 1;
          // The first read is the selection; the second is the merge step's
          // re-check. A human posted `fail` in between.
          return JSON.stringify([
            lists === 1
              ? reviewedPullRequest()
              : reviewedPullRequest({
                  comments: [`${REVIEW_MARKER}\n\n**Verdict:** fail`],
                }),
          ]);
        }
        if (args[0] === "pr" && args[1] === "merge") {
          merged.push(Number(args[2]));
        }
        return "";
      };

      const result = await mergeReviewedPullRequests(options(fixture, gh));

      expect(merged).toEqual([]);
      expect(result.failed[0]?.step).toBe("merge");
      expect(result.failed[0]?.message).toContain("fail");
    } finally {
      await fixture.dispose();
    }
  });

  it("test_a_branch_that_moved_after_the_check_is_not_merged", async () => {
    const fixture = await createFixtureRepository({ files: { "scripts/setup-worktree.sh": SETUP } });
    try {
      await pushBranch(fixture);
      let lists = 0;
      const merged: number[] = [];
      const gh = async (args: readonly string[]): Promise<string> => {
        if (args[0] === "pr" && args[1] === "list") {
          lists += 1;
          if (lists === 2) {
            // Someone pushes to the branch while this run was checking it.
            const sha = await commitOn(fixture, "later.txt", "moved\n", "the branch moves");
            await gitOutput(
              ["push", "-q", fixture.remote, `${sha}:refs/heads/agent/issue-42`],
              { cwd: fixture.repo, env: fixture.env },
            );
          }
          return JSON.stringify([reviewedPullRequest()]);
        }
        if (args[0] === "pr" && args[1] === "merge") {
          merged.push(Number(args[2]));
        }
        return "";
      };

      const result = await mergeReviewedPullRequests(options(fixture, gh));

      expect(merged).toEqual([]);
      expect(result.failed[0]?.step).toBe("merge");
      expect(result.failed[0]?.message).toContain("branch moved");
    } finally {
      await fixture.dispose();
    }
  });

  it("test_a_fix_the_gate_forced_is_pushed_with_the_branch", async () => {
    const fixture = await createFixtureRepository({
      files: { "scripts/setup-worktree.sh": SETUP, "shared.txt": "the base\n" },
    });
    try {
      // The branch adds a file and the base changes another, so the merge is
      // clean but the branch moves — and the gate runs.
      await pushBranch(fixture, "work.txt", "the work\n");
      await moveMain(fixture, "the base moved\n");

      let gateCalls = 0;
      const flakyGate: CommandRunner = async (spec) => {
        if (spec.command === "python3") {
          return JSON.stringify({
            workflow: "ci.yml",
            verdict: "ci.yml  run 1  success",
            exit: 0,
          });
        }
        if (spec.args[0] === "./check.sh") {
          gateCalls += 1;
          if (gateCalls === 1) {
            throw new Error("the gate is red");
          }
        }
        return "";
      };

      const { gh } = stubGh([reviewedPullRequest()]);
      const result = await mergeReviewedPullRequests(
        options(fixture, gh, {
          run: flakyGate,
          session: resolvingSession("both sides\n"),
        }),
      );

      expect(result.merged).toEqual([]);
      expect(gateCalls).toBe(2);

      // The fix was committed after merge-sync recorded the head, and it is on
      // the branch that was pushed — not dropped with the worktree.
      const pushed = await gitOutput(["rev-parse", "agent/issue-42"], {
        cwd: fixture.remote,
        env: fixture.env,
      });
      expect(
        await gitOutput(["show", `${pushed}:shared.txt`], {
          cwd: fixture.remote,
          env: fixture.env,
        }),
      ).toBe("both sides");
    } finally {
      await fixture.dispose();
    }
  });

  it("test_a_conflict_is_resolved_pushed_and_reviewed_but_lands_on_a_later_run", async () => {
    const fixture = await createFixtureRepository({
      files: { "scripts/setup-worktree.sh": SETUP, "shared.txt": "the base\n" },
    });
    try {
      // The branch and the base both change the same file.
      await pushBranch(fixture, "shared.txt", "the branch\n");
      const branchSha = await gitOutput(["rev-parse", "agent/issue-42"], {
        cwd: fixture.remote,
        env: fixture.env,
      });
      await moveMain(fixture, "the base moved\n");

      const { gh, merged, calls } = stubGh([reviewedPullRequest()]);
      const result = await mergeReviewedPullRequests(
        options(fixture, gh, { session: resolvingSession("both sides\n") }),
      );

      // Nothing is landed this run: the new commit's CI has not judged it.
      expect(merged).toEqual([]);
      expect(result.merged).toEqual([]);
      expect(result.failed).toEqual([]);
      expect(result.skipped[0]?.reason).toContain("lands once CI is green");

      // The resolution was pushed, and a fresh review was posted for the new diff.
      const pushed = await gitOutput(["rev-parse", "agent/issue-42"], {
        cwd: fixture.remote,
        env: fixture.env,
      });
      expect(pushed).not.toBe(branchSha);
      expect(calls.some((call) => call.includes("pr comment"))).toBe(true);

      // And the next run, with CI green, lands it.
      const next = stubGh([reviewedPullRequest()]);
      const landed = await mergeReviewedPullRequests(options(fixture, next.gh));
      expect(landed.merged).toEqual([7]);
      expect(next.merged).toEqual([7]);
    } finally {
      await fixture.dispose();
    }
  });
});
