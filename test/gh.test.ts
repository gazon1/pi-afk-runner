/**
 * The queue the bridge reads.
 *
 * The runner does not know GitHub: it asks the bridge for the queue, and the
 * bridge answers with the issues the labels select — oldest first, the
 * claimed ones excluded by the query itself, and the claimed set read with a
 * query of its own so that a claim a dead run left behind is not invisible.
 */

import { describe, expect, it } from "vitest";

import {
  CLAIM_LABEL,
  GH_DEFAULT_PAGE_SIZE,
  QUEUE_LABEL,
  RECOUNT_LABEL,
  claimedArgs,
  parseIssues,
  parsePullRequest,
  queueArgs,
  readClaimed,
  readQueue,
} from "../src/gh.js";
import { valueAfter } from "./shared.js";

describe("the queue", () => {
  it("test_selection_uses_the_minus_search_form", () => {
    const args = queueArgs("gazon1/sing");

    // The exclusion is a *search*, and it is the minus form.
    const search = valueAfter(args, "--search");
    expect(search).toBe(`-label:${CLAIM_LABEL} sort:created-asc`);
    expect(search.startsWith("-")).toBe(true);
    expect(search.startsWith("no:")).toBe(false);

    // `gh`'s default page size is 30 and the queue is larger than that, so
    // the limit is not optional: without it the runner sees the first thirty
    // issues and believes it has seen them all.
    const limit = Number(valueAfter(args, "--limit"));
    expect(limit).toBeGreaterThan(GH_DEFAULT_PAGE_SIZE);
    expect(args).toContain("--limit");
  });

  it("reads the queue oldest first", () => {
    // The backlog drains in the order it was filed: the issue the runner
    // filed last is worked last, not first.
    const search = valueAfter(queueArgs("gazon1/sing"), "--search");
    expect(search).toContain("sort:created-asc");
    expect(search).not.toContain("sort:created-desc");
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
        {
          number: 7,
          title: "an issue",
          updatedAt: "2026-10-30T09:00:00Z",
          labels: [{ name: QUEUE_LABEL }],
        },
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
