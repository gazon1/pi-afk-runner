/**
 * The claim on an issue.
 *
 * This is the one piece of the runner that **cannot be installed**: no ready-made
 * extension does it, because it depends on a contract with a repository the
 * runner does not own.
 *
 * The claim has two halves, and the order between them is not a detail.
 *
 * **The label comes first.** `agent-in-progress` is what a human sees, and it
 * is what moves the issue's last-update time — and that time is the staleness
 * signal in the state derivation. The ref comes second, because the ref is
 * what makes the claim exclusive. The reverse order leaves a claim whose
 * staleness clock never started.
 *
 * **The ref is what excludes.** Adding a label is idempotent: a second add
 * exits 0, so two runners both "win" it. The claim is an annotated tag on the
 * remote, and creating a tag is never a fast-forward — with a nonce in its
 * message, so that a second creation is rejected rather than absorbed as
 * "everything up-to-date".
 *
 * When the push is rejected, the runner **removes the label it just added** and
 * moves on: it lost the race, and it must not leave a claim behind.
 */

import { randomUUID } from "node:crypto";

import { CLAIM_LABEL, type GhRunner, type IssueSummary } from "./gh.js";
import {
  GitCommandFailed,
  claimRef,
  createClaimObject,
  deleteClaim,
  pushClaim,
  readRemoteSha,
  type GitRunner,
} from "./git.js";

/** What came of a claim. */
export type ClaimOutcome =
  | {
      readonly claimed: true;
      /** The commit the claim was taken from. */
      readonly base: string;
      /** The ref that holds the claim. */
      readonly ref: string;
    }
  | {
      readonly claimed: false;
      /** Why the claim did not happen. */
      readonly reason: string;
    };

export interface ClaimOptions {
  /** The issue being claimed. */
  readonly issue: IssueSummary;
  /** The repository the issue lives in. */
  readonly repo: string;
  /** The remote the claim is pushed to. */
  readonly remote: string;
  /** The branch the work goes on, and the branch the base is read from. */
  readonly baseBranch: string;
  /** The directory the git commands run in. */
  readonly cwd: string;
  readonly git: GitRunner;
  readonly gh: GhRunner;
  /** The nonce that makes the claim object unique. */
  readonly nonce?: string;
  /** The clock, for the tag object's timestamp. */
  readonly now?: Date;
}

/**
 * Take the claim on an issue.
 *
 * The label goes on first, so the issue's age starts. Then the base commit is
 * read, the claim object is written, and it is pushed. A rejected push means
 * another runner got there first: the label comes off again and the issue is
 * somebody else's.
 */
export async function claimIssue(options: ClaimOptions): Promise<ClaimOutcome> {
  const { issue, repo, remote, baseBranch, cwd, git, gh } = options;
  const nonce = options.nonce ?? randomUUID();
  const now = options.now ?? new Date();

  // The label first: it is what a human sees, and it is what starts the
  // staleness clock.
  await gh([
    "issue",
    "edit",
    String(issue.number),
    "--repo",
    repo,
    "--add-label",
    CLAIM_LABEL,
  ]);

  try {
    const base = await readRemoteSha(git, cwd, { remote, ref: baseBranch });
    if (base === null) {
      throw new Error(`${remote} has no ${baseBranch} to take the claim from`);
    }

    const objectId = await createClaimObject(git, cwd, {
      baseSha: base,
      issueNumber: issue.number,
      nonce,
      timestampSeconds: Math.floor(now.getTime() / 1000),
    });

    await pushClaim(git, cwd, { remote, issueNumber: issue.number, objectId });

    return { claimed: true, base, ref: claimRef(issue.number) };
  } catch (failure) {
    // It lost the race, or something else went wrong. Either way it must not
    // leave a label behind: a claim nobody is working is an issue nobody can
    // take.
    await removeClaimLabel(gh, repo, issue.number);
    if (failure instanceof GitCommandFailed) {
      return {
        claimed: false,
        reason: `the claim on issue ${issue.number} was rejected: ${failure.stderr.trim()}`,
      };
    }
    throw failure;
  }
}

/** Take the claim label off an issue. */
export async function removeClaimLabel(
  gh: GhRunner,
  repo: string,
  issueNumber: number,
): Promise<void> {
  await gh([
    "issue",
    "edit",
    String(issueNumber),
    "--repo",
    repo,
    "--remove-label",
    CLAIM_LABEL,
  ]);
}

/** Release a claim: the label comes off and the ref goes away. */
export async function releaseClaim(options: {
  readonly repo: string;
  readonly remote: string;
  readonly cwd: string;
  readonly issueNumber: number;
  readonly git: GitRunner;
  readonly gh: GhRunner;
}): Promise<void> {
  await removeClaimLabel(options.gh, options.repo, options.issueNumber);
  await deleteClaim(options.git, options.cwd, {
    remote: options.remote,
    issueNumber: options.issueNumber,
  });
}
