/**
 * The leftovers: the work that follows from the work a run just did.
 *
 * A run ends by asking the question the work leaves open — what logically
 * follows from it — and the answer is two kinds of thing. The cheap ones the
 * agent fixes in the run, with the gates run again. The rest are the next
 * run's work, and they are filed as issues in the target repository: an issue
 * whose body is a brief opening with `## Agent Brief`, labelled
 * `ready-for-agent`, so the queue read finds it and the next run takes it.
 *
 * **The runner files them, not the agent.** The agent could open an issue with
 * a shell command, and then nothing would bound the queue: three leftovers a
 * run is a promise, and a promise the agent can break with one command is not a
 * promise. So the leftovers go through this tool, which holds the bounds — at
 * most {@link MAX_LEFTOVERS_PER_RUN} a run, and nothing that is already open
 * in the repository, which is also what stops the same title twice.
 *
 * The brief goes in the issue's **body**, not in a comment. The target
 * repository's triage skill writes briefs as comments, and the runner reads a
 * body as the brief when no comment carries the marker — so a body is a brief
 * the next run will work, and one `gh` call files it whole. A comment after the
 * fact could fail, and an issue whose body is empty and whose comment never
 * arrived is an issue the runner refuses to work.
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  BRIEF_MARKER,
  QUEUE_LABEL,
  createIssue,
  readOpenIssues,
  type GhRunner,
} from "./gh.js";

/**
 * How many leftovers one run may file.
 *
 * The queue grows for ever otherwise: every run files what it noticed, and the
 * next run files what it noticed on top of that. Three is enough to carry the
 * work forward without turning the queue into a backlog nobody reads.
 */
export const MAX_LEFTOVERS_PER_RUN = 3;

/** The name of the tool the fourth turn files a leftover with. */
export const LEFTOVER_TOOL_NAME = "agent_leftover";

/**
 * A title, compared the way a person would compare it.
 *
 * Case and spacing are not what makes two leftovers the same leftover; the
 * words are.
 */
function normaliseTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

/** What one filing did. */
export interface LeftoverOutcome {
  /** Whether the issue was filed. */
  readonly filed: boolean;
  /** The issue's number, when it was filed. */
  readonly number: number;
  /** The title it was filed under. */
  readonly title: string;
  /** Why it was not filed, when it was not. */
  readonly reason: string;
}

/** A refusal: the model sees it as a failed call, and why. */
function refusal(title: string, reason: string): {
  content: { type: "text"; text: string }[];
  details: LeftoverOutcome;
  isError: true;
} {
  return {
    content: [{ type: "text", text: `Not filed: ${reason}` }],
    details: { filed: false, number: 0, title, reason },
    isError: true,
  };
}

/**
 * The tool the fourth turn files a leftover with.
 *
 * It holds the bounds the queue needs: at most `limit` leftovers a run, and
 * nothing that is already open in the repository — an issue this run filed is
 * open, so that one read is also what stops the same title twice. The brief it
 * writes must open with `## Agent Brief`, because that is where the next run
 * looks for it.
 */
export function createLeftoverTool(options: {
  /** The repository the issue lives in — `owner/name`. */
  readonly repo: string;
  /** How the issues are read and written. */
  readonly gh: GhRunner;
  /** How many leftovers this run may file. */
  readonly limit?: number;
}): ToolDefinition {
  const limit = options.limit ?? MAX_LEFTOVERS_PER_RUN;
  // How many this run has filed. The titles are not kept: an issue this run
  // filed is open, and the read below finds it — one answer to "is this
  // already known?", not two.
  let filed = 0;

  return defineTool({
    name: LEFTOVER_TOOL_NAME,
    label: "File a leftover as an issue",
    description:
      "File a leftover — the work that follows from the work just done — as an issue in " +
      "the target repository. The issue's body is the brief, and it must open with " +
      "`## Agent Brief`. The issue is labelled `ready-for-agent`, so the next run picks it " +
      "up. Use this tool rather than a shell command: it is what keeps the queue bounded.",
    promptSnippet: "File a leftover as the next issue",
    promptGuidelines: [
      `Use ${LEFTOVER_TOOL_NAME} to file a leftover, not \`gh issue create\`.`,
      "The brief is the issue's body, and it opens with `## Agent Brief`.",
      "At most three leftovers a run. The tool refuses the fourth, and refuses a title that is already open.",
    ],
    parameters: Type.Object({
      title: Type.String({
        description: "The issue's title — one line, saying what has to happen.",
      }),
      brief: Type.String({
        description:
          "The brief, in the target repository's own format: it opens with `## Agent Brief` " +
          "and carries the category, the summary, the current and the desired behaviour, the " +
          "key interfaces, the acceptance criteria and what is out of scope.",
      }),
    }),
    async execute(_toolCallId, params) {
      const title = params.title.trim();
      if (title === "") {
        return refusal(title, "the leftover has no title");
      }
      if (!params.brief.trimStart().startsWith(BRIEF_MARKER)) {
        return refusal(
          title,
          `the brief must open with \`${BRIEF_MARKER}\` — that is where the next run looks for it`,
        );
      }
      if (filed >= limit) {
        return refusal(
          title,
          `this run has already filed ${filed} leftovers — the queue is bounded at ${limit}`,
        );
      }
      const key = normaliseTitle(title);

      // Search first: an issue that is already open is work that is already
      // known, and a second copy of it is a queue that grows for nothing. The
      // open issues are read rather than the queue, because the queue excludes
      // the claimed ones — and an issue another run is working is exactly the
      // one a second copy would be filed against.
      const open = await readOpenIssues(options.repo, options.gh);
      const existing = open.find((issue) => normaliseTitle(issue.title) === key);
      if (existing !== undefined) {
        return refusal(title, `issue #${existing.number} is already open with that title`);
      }

      const number = await createIssue(
        {
          repo: options.repo,
          title,
          body: params.brief.trim(),
          labels: [QUEUE_LABEL],
        },
        options.gh,
      );
      filed += 1;

      return {
        content: [
          {
            type: "text",
            text: `Filed issue #${number}: "${title}" — labelled ${QUEUE_LABEL}.`,
          },
        ],
        details: { filed: true, number, title, reason: "" },
      };
    },
  });
}
