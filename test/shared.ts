/**
 * What the test files share.
 *
 * The fakes the door's tests and the queue bridge's tests are written with:
 * the fake host API — the git and the GitHub the runner reads — the fake host
 * context — the worktree a run works in — and the fake session the runner
 * opens. They live here, so a file that needs one says so by importing it
 * instead of by writing its own.
 */

import type { GhRunner } from "../src/gh.js";
import { workBranch, type GitRunner } from "../src/git.js";
import type { AgentSession } from "../src/session.js";

/**
 * A git runner that answers with what the test tells it to.
 *
 * The repository is the host's: the remote, the worktree, the commits. A test
 * that does not care about any of them says what the git answers.
 */
export function fakeGit(answer: string): GitRunner {
  return async () => answer;
}

/**
 * The GitHub the runner reads the queue from.
 *
 * The issue it hands back carries a brief, because a run without a brief is
 * not a run.
 */
export function fakeGhApi(): GhRunner {
  return async (args: readonly string[]): Promise<string> => {
    if (args[0] === "issue" && args[1] === "view") {
      return JSON.stringify({
        body: "## Agent Brief\n\ndo the thing",
        comments: [],
        title: "an issue",
        labels: [],
        updatedAt: "",
        state: "OPEN",
      });
    }
    return "";
  };
}

/**
 * The worktree facts a work session is given, for the tests that do not care
 * which branch it is on. The tests that do care build their own.
 */
export function fakeWorktree(issueNumber: number) {
  return {
    branch: workBranch(issueNumber),
    baseBranch: "main",
    baseSha: "0".repeat(40),
    commits: [] as readonly string[],
  };
}

/**
 * A session that does nothing.
 *
 * The session is the seam the runner talks through, so a test that is not
 * about the turns says so with a session that answers nothing.
 */
export function fakeSession(): AgentSession {
  return {
    prompt: async () => {},
    abort: async () => {},
    dispose: () => {},
  };
}

/** The value that follows a flag, or a failure that says which flag is missing. */
export function valueAfter(args: readonly string[], flag: string): string {
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
