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
 * When the push is rejected, the runner reads the claim ref on the remote and
 * decides from it. The ref is the claim, and the label is the claim's label:
 * when the ref is not there, the label this runner added comes off — a claim
 * nobody is working is an issue nobody can take; when the ref is there, the
 * label stays, because it belongs to whoever holds the ref, and a runner that
 * lost the race and took the label off would leave the winner's issue looking
 * free while the winner is working on it.
 */

import { randomUUID } from "node:crypto";

import { CLAIM_LABEL, type GhRunner, type IssueSummary } from "./gh.js";
import {
  CommandFailed,
  claimRef,
  createClaimObject,
  deleteClaim,
  deleteLocalBranch,
  deleteRemoteBranch,
  fetchRef,
  headRef,
  issueWorktreePath,
  pushClaim,
  readClaimObject,
  readRemoteSha,
  removeWorktree,
  workBranch,
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
 * the claim did not happen — and the label is settled by the remote's claim
 * ref, not by this runner: see `settleClaimLabel`.
 */
export async function claimIssue(options: ClaimOptions): Promise<ClaimOutcome> {
  const { issue, repo, remote, baseBranch, cwd, git, gh } = options;
  const nonce = options.nonce ?? randomUUID();
  const now = options.now ?? new Date();

  // The label first: it is what a human sees, and it is what starts the
  // staleness clock.
  await gh(["issue", "edit", String(issue.number), "--repo", repo, "--add-label", CLAIM_LABEL]);

  // The claim object this runner wrote, when it gets that far. The remote's
  // ref is compared against it: a ref that holds it is this runner's own
  // claim, and a ref that holds another object is another runner's.
  let claimObject: string | undefined;

  try {
    const base = await readRemoteSha(git, cwd, { remote, ref: headRef(baseBranch) });
    if (base === null) {
      throw new Error(`${remote} has no ${baseBranch} to take the claim from`);
    }

    // The base has to be **here** before the claim object can point at it. The
    // claim is a tag, and a tag whose target the repository does not hold
    // cannot be pushed — git says "could not read tagged object" and the claim
    // is lost. The base is fetched by that exact commit, so the commit the
    // claim names and the commit that is local cannot disagree.
    await fetchRef(git, cwd, { remote, ref: base });

    claimObject = await createClaimObject(git, cwd, {
      baseSha: base,
      issueNumber: issue.number,
      nonce,
      timestampSeconds: Math.floor(now.getTime() / 1000),
    });

    await pushClaim(git, cwd, { remote, issueNumber: issue.number, objectId: claimObject });

    return { claimed: true, base, ref: claimRef(issue.number) };
  } catch (failure) {
    // The label is the claim's label, and the claim is whoever holds the ref.
    // So the ref is read, and the label follows it.
    const label = await settleClaimLabel({
      git,
      gh,
      cwd,
      repo,
      remote,
      issueNumber: issue.number,
      ...(claimObject === undefined ? {} : { objectId: claimObject }),
    });

    if (failure instanceof CommandFailed) {
      return {
        claimed: false,
        reason:
          `the claim on issue ${issue.number} was rejected: ${failure.stderr.trim()}` +
          ` — and ${label.sentence}`,
      };
    }
    if (label.failure !== null) {
      throw new Error(
        `${failure instanceof Error ? failure.message : String(failure)} ` +
          `— and the claim label could not be taken off: ${label.failure}`,
        { cause: failure },
      );
    }
    if (!label.removed) {
      // The label stayed on, and that is worth saying: the issue looks
      // claimed, and it is — by whoever holds the ref.
      throw new Error(
        `${failure instanceof Error ? failure.message : String(failure)} — and ${label.sentence}`,
        { cause: failure },
      );
    }
    throw failure;
  }
}

/**
 * Who holds the claim on an issue, as the remote's ref says.
 *
 * - `ours`: the ref holds this runner's own claim object — the claim landed.
 * - `theirs`: the ref holds another claim object — another runner won the race.
 * - `none`: the ref is not on the remote — nobody holds the claim.
 */
type ClaimHolder = "ours" | "theirs" | "none";

/**
 * Read who holds the claim from the remote's claim ref.
 *
 * The ref is the claim. The label cannot be, because adding a label is
 * idempotent: two runners both "win" it, and only the ref tells them apart.
 */
async function readClaimHolder(
  git: GitRunner,
  cwd: string,
  options: {
    readonly remote: string;
    readonly issueNumber: number;
    /** The claim object this runner wrote, when it got that far. */
    readonly objectId?: string;
  },
): Promise<ClaimHolder> {
  const remote = await readClaimObject(git, cwd, {
    remote: options.remote,
    issueNumber: options.issueNumber,
  });
  if (remote === null) {
    return "none";
  }
  return remote === options.objectId ? "ours" : "theirs";
}

/** What became of the claim label after a claim that did not happen. */
interface LabelOutcome {
  /** Whether the label came off the issue. */
  readonly removed: boolean;
  /** What happened to the label, in a sentence a reader can act on. */
  readonly sentence: string;
  /** Why the label could not be taken off, when it could not. */
  readonly failure: string | null;
}

/**
 * Settle the claim label after a claim that did not happen.
 *
 * The label is not this runner's to remove: it is the claim's, and the claim
 * is whoever holds the ref. So the ref is read, and the label follows it:
 *
 * - **the ref is not on the remote**: nobody holds the claim, and the label
 *   this runner added comes off — a claim nobody is working is an issue nobody
 *   can take;
 * - **the ref holds this runner's own claim object**: the claim is its own, and
 *   the label stays;
 * - **the ref holds another claim object**: another runner won the race, and
 *   the label is theirs — taking it off would leave their issue looking free
 *   while they are working on it, and the next runner would be offered an
 *   issue it cannot claim.
 *
 * When the ref cannot be read, the label stays: it is not known to be
 * anybody's to remove.
 */
async function settleClaimLabel(options: {
  readonly git: GitRunner;
  readonly gh: GhRunner;
  readonly cwd: string;
  readonly repo: string;
  readonly remote: string;
  readonly issueNumber: number;
  /** The claim object this runner wrote, when it got that far. */
  readonly objectId?: string;
}): Promise<LabelOutcome> {
  let holder: ClaimHolder;
  try {
    holder = await readClaimHolder(options.git, options.cwd, {
      remote: options.remote,
      issueNumber: options.issueNumber,
      ...(options.objectId === undefined ? {} : { objectId: options.objectId }),
    });
  } catch (failure) {
    const detail = failure instanceof Error ? failure.message : String(failure);
    return {
      removed: false,
      failure: null,
      sentence: `the claim on the remote could not be read, so the claim label was left on: ${detail}`,
    };
  }

  if (holder === "ours") {
    return {
      removed: false,
      failure: null,
      sentence: "the claim landed, so the claim label was left on",
    };
  }
  if (holder === "theirs") {
    return {
      removed: false,
      failure: null,
      sentence: "another runner holds the claim, so the claim label was left on",
    };
  }

  try {
    await removeClaimLabel(options.gh, options.repo, options.issueNumber);
    return { removed: true, failure: null, sentence: "the claim label was taken off" };
  } catch (failure) {
    const detail = failure instanceof Error ? failure.message : String(failure);
    return {
      removed: false,
      failure: detail,
      sentence: `the claim label could not be taken off: ${detail}`,
    };
  }
}

/** Take the claim label off an issue. */
async function removeClaimLabel(gh: GhRunner, repo: string, issueNumber: number): Promise<void> {
  await gh(["issue", "edit", String(issueNumber), "--repo", repo, "--remove-label", CLAIM_LABEL]);
}

/**
 * Take over a claim a previous run left behind.
 *
 * The stale claim's **ref** goes first: the ref is the lock, and a ref that is
 * still there refuses a new claim — the push is rejected and the issue stays
 * untouchable. Then the claim is taken again, with a new nonce, so the new
 * claim is a different object from the old one and the push is not a
 * no-op.
 *
 * The label is left alone. It is already on — it is the marker of a claim — and
 * adding it again is idempotent, which is exactly what a re-claim needs. A
 * reclaim that loses the race to another runner leaves it on too: the label is
 * the claim's, and the claim is then the runner that won.
 *
 * The stale **branch** goes too, when there is one: the work is redone rather
 * than resumed, because the session that made it is gone with the process that
 * died. The branch is the runner's own — `agent/issue-<N>` — and its commits
 * are the dead run's, not anybody's.
 *
 * The branch goes on the remote as well as in the checkout. The rework pushes
 * over the branch, and a push over a branch whose commits the new base no
 * longer contains is refused as a non-fast-forward: the base was rewritten
 * while the dead run's branch was on the remote, and the rework would fail on
 * every attempt for ever. A reclaim is reached only when the branch carries
 * no work — its commits are already on the base — so deleting it loses
 * nothing, and the rework's push creates the branch instead of failing on the
 * leftover.
 *
 * **`keepBranch`** is for the claim a review that failed left behind. That
 * branch carries the work the review judged, so it is kept: only the ref is
 * taken over. The ref is still replaced, because it is what excludes a second
 * runner, and a claim that is merely extended is a claim two runners both
 * believe is theirs.
 */
export async function reclaimClaim(
  options: ClaimOptions & {
    readonly worktreeRoot?: string;
    readonly keepBranch?: boolean;
  },
): Promise<ClaimOutcome> {
  await deleteClaim(options.git, options.cwd, {
    remote: options.remote,
    issueNumber: options.issue.number,
  });
  // The dead run's worktree first: a branch that is checked out somewhere
  // cannot be deleted, and the worktree is where that work was.
  if (options.worktreeRoot !== undefined) {
    await removeWorktree(
      options.git,
      options.cwd,
      issueWorktreePath(options.worktreeRoot, options.issue.number),
    );
  }
  if (options.keepBranch !== true) {
    await deleteLocalBranch(options.git, options.cwd, {
      branch: workBranch(options.issue.number),
    });
    await deleteRemoteBranch(options.git, options.cwd, {
      remote: options.remote,
      branch: workBranch(options.issue.number),
    });
  }
  return claimIssue(options);
}

/**
 * Release a claim: the ref goes away and the label comes off.
 *
 * The order is the safety. The label is what a human sees and what the queue
 * read excludes by, so it comes off **last**: an issue whose label is off
 * while its claim ref is still there looks free to the next runner, and the
 * next runner cannot claim it — a claim nobody can take is an issue nobody can
 * take either. The other order leaves an issue that looks claimed and is not,
 * and *that* the reclaim path finds and takes over.
 */
export async function releaseClaim(options: {
  readonly repo: string;
  readonly remote: string;
  readonly cwd: string;
  readonly issueNumber: number;
  readonly git: GitRunner;
  readonly gh: GhRunner;
}): Promise<void> {
  await deleteClaim(options.git, options.cwd, {
    remote: options.remote,
    issueNumber: options.issueNumber,
  });
  await removeClaimLabel(options.gh, options.repo, options.issueNumber);
}
