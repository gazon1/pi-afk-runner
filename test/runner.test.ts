import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { describe, expect, it } from "vitest";

import { claimIssue, releaseClaim } from "../src/claim.js";
import { claimRef, claimRefName, readClaimBase, runGit, workBranch } from "../src/git.js";
import { createFixtureRepository, gitOutput } from "./git-sandbox.js";
import {
  GH_DEFAULT_PAGE_SIZE,
  QUEUE_LABEL,
  CLAIM_LABEL,
  RECOUNT_LABEL,
  REVIEW_MARKER,
  claimedArgs,
  parseIssues,
  parsePullRequest,
  queueArgs,
  readClaimed,
  readQueue,
} from "../src/gh.js";
import {
  UNCLAIMED,
  deriveState,
  isStale,
  observePullRequest,
  selectIssue,
  type Observables,
} from "../src/runner.js";
import {
  PINNED_PI_RANGE,
  PiVersionMismatch,
  assertPiVersion,
  checkPiVersion,
  comparePiVersions,
  installedPiVersion,
  parsePiVersion,
  satisfiesRange,
} from "../src/version.js";

/**
 * The version gate is the one thing the extension must never get wrong in the wrong
 * direction: it has to let a supported Pi through and stop an unsupported one. Everything
 * here is about the boundary — the version that is exactly the lower bound, the one that is
 * exactly the upper bound, and the one just outside each.
 */
describe("the pinned Pi version range", () => {
  it("test_the_extension_refuses_to_run_outside_its_pi_version_range", async () => {
    // The version this extension is written against passes.
    const inside = checkPiVersion("1.4.0");
    expect(inside.ok).toBe(true);
    expect(inside.reason).toBeNull();

    // Outside the range, in either direction, the check refuses.
    const below = checkPiVersion("1.3.9");
    expect(below.ok).toBe(false);
    expect(below.reason).toContain("1.3.9");
    expect(below.reason).toContain(PINNED_PI_RANGE);

    const above = checkPiVersion("1.5.0");
    expect(above.ok).toBe(false);
    expect(above.reason).toContain("1.5.0");

    // A far-away version is refused for the same reason, not by accident of parsing.
    expect(checkPiVersion("0.9.1").ok).toBe(false);
    expect(checkPiVersion("2.0.0").ok).toBe(false);

    // And the refusal is a refusal, not a warning: the caller throws.
    expect(() => assertPiVersion("1.5.0")).toThrow(PiVersionMismatch);
    expect(() => assertPiVersion("1.4.0")).not.toThrow();

    // The range the check actually uses is the pinned one.
    expect(PINNED_PI_RANGE).toBe(">=1.4.0 <1.5.0");
  });

  it("accepts every version inside the range, including its bounds", () => {
    for (const version of ["1.4.0", "1.4.1", "1.4.17", "1.4.99"]) {
      expect(checkPiVersion(version).ok).toBe(true);
    }
  });

  it("refuses a prerelease of the range's lower bound", () => {
    // `1.4.0-rc.1` is older than `1.4.0`, so it is not inside `>=1.4.0`.
    expect(checkPiVersion("1.4.0-rc.1").ok).toBe(false);
    // And it is not inside the range either.
    const version = parsePiVersion("1.4.0-rc.1");
    expect(version).not.toBeNull();
    expect(satisfiesRange(version!, PINNED_PI_RANGE)).toBe(false);
  });

  it("refuses a version it cannot parse, rather than passing it", () => {
    for (const raw of ["", "1.4", "1.4.0.0", "not-a-version", "v1.4.0"]) {
      expect(checkPiVersion(raw).ok).toBe(false);
    }
    expect(parsePiVersion("not-a-version")).toBeNull();
    expect(parsePiVersion("v1.4.0")).toBeNull();
  });

  it("reads the version of the Pi it is running inside", () => {
    const installed = installedPiVersion();
    expect(installed).toMatch(/^\d+\.\d+\.\d+/);
    // The SDK this extension is developed against is the one it is running inside.
    expect(checkPiVersion(installed).ok).toBe(true);
  });
});

describe("the version comparison", () => {
  it("orders versions by major, then minor, then patch", () => {
    const at = (raw: string) => parsePiVersion(raw)!;
    expect(comparePiVersions(at("1.4.0"), at("1.5.0"))).toBeLessThan(0);
    expect(comparePiVersions(at("1.5.0"), at("1.4.0"))).toBeGreaterThan(0);
    expect(comparePiVersions(at("1.4.0"), at("1.4.0"))).toBe(0);
    expect(comparePiVersions(at("2.0.0"), at("1.99.99"))).toBeGreaterThan(0);
  });

  it("orders a prerelease before its release", () => {
    const at = (raw: string) => parsePiVersion(raw)!;
    expect(comparePiVersions(at("1.4.0-rc.1"), at("1.4.0"))).toBeLessThan(0);
    expect(comparePiVersions(at("1.4.0-rc.1"), at("1.4.0-rc.2"))).toBeLessThan(0);
  });

  it("ignores build metadata", () => {
    const at = (raw: string) => parsePiVersion(raw)!;
    expect(comparePiVersions(at("1.4.0+build.1"), at("1.4.0"))).toBe(0);
    expect(checkPiVersion("1.4.0+build.1").ok).toBe(true);
  });
});

describe("the range grammar", () => {
  const at = (raw: string) => parsePiVersion(raw)!;

  it("reads a conjunction of comparators", () => {
    expect(satisfiesRange(at("1.4.0"), ">=1.4.0 <1.5.0")).toBe(true);
    expect(satisfiesRange(at("1.4.9"), ">=1.4.0 <1.5.0")).toBe(true);
    expect(satisfiesRange(at("1.5.0"), ">=1.4.0 <1.5.0")).toBe(false);
    expect(satisfiesRange(at("1.3.9"), ">=1.4.0 <1.5.0")).toBe(false);
  });

  it("reads each comparator", () => {
    expect(satisfiesRange(at("1.4.0"), ">=1.4.0")).toBe(true);
    expect(satisfiesRange(at("1.3.9"), ">=1.4.0")).toBe(false);
    expect(satisfiesRange(at("1.4.0"), ">1.4.0")).toBe(false);
    expect(satisfiesRange(at("1.5.0"), "<=1.5.0")).toBe(true);
    expect(satisfiesRange(at("1.5.1"), "<=1.5.0")).toBe(false);
    expect(satisfiesRange(at("1.4.0"), "<1.5.0")).toBe(true);
    expect(satisfiesRange(at("1.4.0"), "=1.4.0")).toBe(true);
    expect(satisfiesRange(at("1.4.1"), "=1.4.0")).toBe(false);
  });

  it("satisfies nothing when the range itself cannot be read", () => {
    expect(satisfiesRange(at("1.4.0"), "")).toBe(false);
    expect(satisfiesRange(at("1.4.0"), "not-a-range")).toBe(false);
    expect(satisfiesRange(at("1.4.0"), ">=1.4.0 <<broken")).toBe(false);
  });
});

describe("the extension entry point", () => {
  it("loads against the Pi it is running inside, and says which Pi that is", async () => {
    const activate = (await import("../src/extension.js")).default;

    const registered: string[] = [];
    const pi = {
      registerCommand: (name: string) => {
        registered.push(name);
      },
    };

    // The gate runs at load: an unsupported Pi throws here, and the extension does not load.
    expect(() => activate(pi as unknown as ExtensionAPI)).not.toThrow();

    // And the gate's other half is reachable: the session can ask which Pi it is running against.
    expect(registered).toContain("afk-runner-version");
  });
});

describe("the state the runner derives", () => {
  it("test_the_state_is_derived_from_the_observables", () => {
    // Every row of the derivation table, one case each.
    const withObservables = (overrides: Partial<Observables>): Observables => ({
      ...UNCLAIMED,
      ...overrides,
    });

    // No claim → the issue is in the queue.
    expect(deriveState(withObservables({}))).toBe("Queue");

    // Claimed, nothing durable behind it, still fresh → a live run owns it.
    expect(
      deriveState(withObservables({ claimLabel: true, stale: false })),
    ).toBe("Claimed");

    // Claimed, nothing durable behind it, and old → the run that took it died.
    expect(
      deriveState(withObservables({ claimLabel: true, stale: true })),
    ).toBe("Orphaned");

    // Claimed and the branch is on the remote → the work was pushed.
    expect(
      deriveState(withObservables({ claimLabel: true, workBranch: true })),
    ).toBe("Pushed");

    // A pull request exists and carries no review → it needs one.
    expect(
      deriveState(withObservables({ claimLabel: true, pullRequest: true })),
    ).toBe("Opened");

    // It carries a review → the review is there, the re-count is not.
    expect(
      deriveState(
        withObservables({ claimLabel: true, pullRequest: true, reviewComment: true }),
      ),
    ).toBe("Reviewed");

    // It carries the re-count too → the runner is done with it.
    expect(
      deriveState(
        withObservables({
          claimLabel: true,
          pullRequest: true,
          reviewComment: true,
          recountLabel: true,
        }),
      ),
    ).toBe("Counted");
  });

  it("does not read a pull request's review before the pull request exists", () => {
    // A review comment without a pull request is not a state — the gate reads
    // the pull request's comments, so the comment cannot exist without it.
    expect(
      deriveState({
        ...UNCLAIMED,
        claimLabel: true,
        reviewComment: true,
        recountLabel: true,
      }),
    ).toBe("Claimed");
  });
});

/** The value that follows a flag, or a failure that says which flag is missing. */
function valueAfter(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  if (index < 0) {
    throw new Error(`\`${flag}\` is not in the arguments`);
  }
  const value = args[index + 1];
  if (value === undefined) {
    throw new Error(`\`${flag}\` is the last argument and has no value`);
  }
  return value;
}

describe("the queue", () => {
  it("test_selection_excludes_claimed_issues", async () => {
    const args = queueArgs("gazon1/sing");

    // The exclusion is in the query itself: the claimed issues are never
    // fetched, so they cannot be worked by accident.
    expect(args).toContain("-label:agent-in-progress");
    // And it is the minus form. The `no:label:` form returns nothing at all,
    // because there is no such thing as an issue with no labels — measured
    // against this repository, not assumed.
    expect(args).not.toContain("no:label:agent-in-progress");
    expect(args.join(" ")).not.toContain("no:label:");
    expect(args).not.toContain(`no:label:${CLAIM_LABEL}`);

    // The query asks for the label a human applies, and only open issues.
    expect(args).toContain(QUEUE_LABEL);
    expect(args).toContain("--state");
    expect(args).toContain("open");

    // And the selection refuses a claimed issue even if one turns up in the
    // queue anyway. The query is not the only thing standing between two runs
    // and one issue.
    const claimed = {
      number: 1,
      title: "claimed",
      updatedAt: "2026-10-30T00:00:00Z",
      labels: [QUEUE_LABEL, CLAIM_LABEL],
    };
    const free = {
      number: 2,
      title: "free",
      updatedAt: "2026-10-30T00:00:00Z",
      labels: [QUEUE_LABEL],
    };
    expect(selectIssue([claimed, free])?.number).toBe(2);
    expect(selectIssue([claimed])).toBeUndefined();
    expect(selectIssue([])).toBeUndefined();
  });

  it("test_selection_uses_the_minus_search_form", () => {
    const args = queueArgs("gazon1/sing");

    // The exclusion is a *search*, and it is the minus form.
    const search = valueAfter(args, "--search");
    expect(search).toBe(`-label:${CLAIM_LABEL}`);
    expect(search.startsWith("-")).toBe(true);
    expect(search.startsWith("no:")).toBe(false);

    // `gh`'s default page size is 30 and the queue is larger than that, so the
    // limit is not optional: without it the runner sees the first thirty
    // issues and believes it has seen them all.
    const limit = Number(valueAfter(args, "--limit"));
    expect(limit).toBeGreaterThan(GH_DEFAULT_PAGE_SIZE);
    expect(args).toContain("--limit");
  });

  it("reads the claimed issues with a query of its own", () => {
    // The queue excludes the claimed issues by construction, so a claim left
    // behind by a run that died would be invisible to every later run. The
    // claimed set is read separately — with both labels, which means both.
    const args = claimedArgs("gazon1/sing");
    const labels = args.filter((_, index) => args[index - 1] === "--label");
    expect(labels).toEqual([QUEUE_LABEL, CLAIM_LABEL]);
    expect(args).not.toContain("--search");
  });

  it("parses what gh returns", () => {
    const issues = parseIssues(
      JSON.stringify([
        { number: 7, title: "an issue", updatedAt: "2026-10-30T09:00:00Z", labels: [{ name: QUEUE_LABEL }] },
      ]),
    );
    expect(issues).toEqual([
      {
        number: 7,
        title: "an issue",
        updatedAt: "2026-10-30T09:00:00Z",
        labels: [QUEUE_LABEL],
      },
    ]);

    const pullRequest = parsePullRequest(
      JSON.stringify({
        number: 3,
        headRefName: "agent/issue-7",
        labels: [{ name: RECOUNT_LABEL }],
        comments: [{ body: `<!-- agent-review -->\n\n**Verdict:** pass` }],
      }),
    );
    expect(pullRequest?.headRefName).toBe("agent/issue-7");
    expect(pullRequest?.labels).toEqual([RECOUNT_LABEL]);
    expect(pullRequest?.comments).toHaveLength(1);
  });

  it("reads the queue and the claimed set through the gh it is given", async () => {
    const seen: string[][] = [];
    const gh = async (args: readonly string[]): Promise<string> => {
      seen.push([...args]);
      return "[]";
    };

    await readQueue("gazon1/sing", gh);
    await readClaimed("gazon1/sing", gh);

    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(queueArgs("gazon1/sing"));
    expect(seen[1]).toEqual(claimedArgs("gazon1/sing"));
  });
});

describe("what a pull request says about itself", () => {
  it("counts a review only when the comment opens with the marker", () => {
    const withReview = {
      number: 3,
      headRefName: "agent/issue-7",
      labels: [] as string[],
      comments: [`${REVIEW_MARKER}\n\n**Verdict:** pass`],
    };
    expect(observePullRequest(withReview).reviewComment).toBe(true);

    // A comment that quotes the format is not a review: the gate wants the
    // marker on the first non-blank line.
    const quoting = {
      ...withReview,
      comments: ["The marker is <!-- agent-review -->, in case you were wondering."],
    };
    expect(observePullRequest(quoting).reviewComment).toBe(false);

    // Leading blank lines are still "opening with" it.
    const padded = { ...withReview, comments: ["\n\n  " + REVIEW_MARKER] };
    expect(observePullRequest(padded).reviewComment).toBe(true);

    // No pull request at all.
    expect(observePullRequest(null)).toEqual({ reviewComment: false, recountLabel: false });

    // The recount label is read from the pull request's own labels.
    const recounted = { ...withReview, labels: [RECOUNT_LABEL] };
    expect(observePullRequest(recounted).recountLabel).toBe(true);
  });
});

describe("the staleness of a claim", () => {
  it("is a comparison against a window the caller supplies", () => {
    const updated = "2026-10-30T09:00:00Z";
    const sixHours = 6 * 60 * 60 * 1000;

    expect(isStale(updated, new Date("2026-10-30T12:00:00Z"), sixHours)).toBe(false);
    expect(isStale(updated, new Date("2026-10-30T16:00:00Z"), sixHours)).toBe(true);

    // A claim whose last-update time cannot be read is not treated as stale:
    // guessing wrong in that direction takes an issue from a live run.
    expect(isStale("not a date", new Date("2027-01-01T00:00:00Z"), sixHours)).toBe(false);
  });
});

describe("the claim", () => {
  it("test_claim_precedes_worktree_creation", async () => {
    const calls: string[] = [];
    const git = async (args: readonly string[]): Promise<string> => {
      calls.push(`git ${args.join(" ")}`);
      if (args[0] === "ls-remote") {
        return "abc123\trefs/heads/main\n";
      }
      if (args[0] === "mktag") {
        return "tagobject0000000000000000000000000000000\n";
      }
      return "";
    };
    const gh = async (args: readonly string[]): Promise<string> => {
      calls.push(`gh ${args.join(" ")}`);
      return "";
    };

    const outcome = await claimIssue({
      issue: { number: 42, title: "an issue", updatedAt: "", labels: [] },
      repo: "gazon1/sing",
      remote: "origin",
      baseBranch: "main",
      cwd: "/tmp/does-not-matter",
      git: (args) => git(args),
      gh: (args) => gh(args),
      nonce: "a-nonce",
      now: new Date("2026-10-30T09:00:00Z"),
    });

    expect(outcome.claimed).toBe(true);

    // The label goes on first: it is what a human sees, and what starts the
    // issue's staleness clock. The claim ref comes second, because the ref is
    // what makes the claim exclusive — and nothing may touch a worktree before
    // the claim is held.
    const labelAt = calls.findIndex((call) => call.includes("--add-label agent-in-progress"));
    const refAt = calls.findIndex((call) => call.includes(claimRef(42)));
    expect(labelAt).toBeGreaterThanOrEqual(0);
    expect(refAt).toBeGreaterThan(labelAt);
    expect(calls.some((call) => call.includes("worktree"))).toBe(false);
  });

  it("test_the_claim_label_is_not_the_lock", async () => {
    // Two runners, one issue, the same base commit. The label cannot stop the
    // second one — adding a label is idempotent, so both runners "win" it —
    // and the claim ref must.
    const fixture = await createFixtureRepository();
    try {
      const issue = { number: 42, title: "an issue", updatedAt: "", labels: [] as string[] };
      const labels: string[] = [];

      const gh = async (args: readonly string[]): Promise<string> => {
        if (args.includes("--add-label")) {
          labels.push("added");
        }
        if (args.includes("--remove-label")) {
          labels.push("removed");
        }
        return "";
      };

      const first = await claimIssue({
        issue,
        repo: "gazon1/sing",
        remote: fixture.remote,
        baseBranch: "main",
        cwd: fixture.repo,
        git: (args, options) => runGit(args, options),
        gh,
        nonce: "nonce-one",
        now: new Date("2026-10-30T09:00:00Z"),
      });
      expect(first.claimed).toBe(true);

      // The label really is not a lock: adding it again succeeds.
      await gh(["issue", "edit", "42", "--add-label", "agent-in-progress"]);
      expect(labels.filter((entry) => entry === "added")).toHaveLength(2);

      // The second runner takes the same issue from the same base and is
      // rejected by the ref — this is a real push, against a real repository.
      const second = await claimIssue({
        issue,
        repo: "gazon1/sing",
        remote: fixture.remote,
        baseBranch: "main",
        cwd: fixture.repo,
        git: (args, options) => runGit(args, options),
        gh,
        nonce: "nonce-two",
        now: new Date("2026-10-30T09:00:01Z"),
      });
      expect(second.claimed).toBe(false);

      // And it does not leave a claim behind: the label it added comes off.
      expect(labels).toContain("removed");
      expect(labels[labels.length - 1]).toBe("removed");

      // The claim records the base it was taken from.
      const base = await readClaimBase(
        (args, options) => runGit(args, options),
        fixture.repo,
        { remote: fixture.remote, issueNumber: 42 },
      );
      const remoteBase = await gitOutput(["rev-parse", "main"], {
        cwd: fixture.remote,
        env: fixture.env,
      });
      expect(base).toBe(remoteBase);
      expect(claimRefName(42)).toBe("afk-claim-issue-42");
      expect(workBranch(42)).toBe("agent/issue-42");
    } finally {
      await fixture.dispose();
    }
  });

  it("releases a claim: the label comes off and the ref goes away", async () => {
    const fixture = await createFixtureRepository();
    try {
      const calls: string[] = [];
      const gh = async (args: readonly string[]): Promise<string> => {
        calls.push(`gh ${args.join(" ")}`);
        return "";
      };
      // A claim to release: take it, then let it go.
      await claimIssue({
        issue: { number: 42, title: "an issue", updatedAt: "", labels: [] },
        repo: "gazon1/sing",
        remote: fixture.remote,
        baseBranch: "main",
        cwd: fixture.repo,
        git: (args, options) => runGit(args, options),
        gh,
        nonce: "nonce-for-release",
        now: new Date("2026-10-30T09:00:00Z"),
      });

      await releaseClaim({
        repo: "gazon1/sing",
        remote: fixture.remote,
        cwd: fixture.repo,
        issueNumber: 42,
        git: (args, options) => runGit(args, options),
        gh,
      });

      expect(calls.some((call) => call.includes("--remove-label agent-in-progress"))).toBe(true);

      // The ref is gone: a claim that has been released must not exclude the
      // next runner.
      const base = await readClaimBase(
        (args, options) => runGit(args, options),
        fixture.repo,
        { remote: fixture.remote, issueNumber: 42 },
      );
      expect(base).toBeNull();
    } finally {
      await fixture.dispose();
    }
  });
});
