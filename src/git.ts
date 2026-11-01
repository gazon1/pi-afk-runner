/**
 * Every git call the runner makes, in one place.
 *
 * The claim is the reason this file exists at all.
 *
 * A claim has to be **exclusive**: at most one runner may work an issue. The
 * issue's label cannot do that, because adding a label is idempotent — a
 * second add exits 0, so both runners "win" it. The claim is therefore a
 * **ref on the remote**, and a ref creation is exclusive in git: creating a tag
 * is never a fast-forward, and git refuses to update an existing tag without
 * `--force`.
 *
 * There is one hole in that, and it is the whole subtlety of this file. Git
 * answers "Everything up-to-date" and exits **0** when the ref already points
 * at the *same* object — so a plain push of the base commit is not exclusive
 * either. The claim therefore carries a **nonce**, which makes its object
 * unique, and the second creation is rejected no matter what.
 *
 * The claim is an **annotated tag** rather than a branch, for two reasons: a
 * tag's message is where the nonce lives, and a tag records the commit it was
 * taken from — the base the reclaim path needs, which the issue's own metadata
 * cannot supply, because `origin/main` has moved on by then.
 *
 * The tag object is written with `git mktag` rather than `git tag -a`, so that
 * **no local ref is created**. The object is what gets pushed; the name lives
 * only on the remote, and the runner's own checkout is left as it found it.
 */

import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";

/** Who the claim is attributed to. Part of the tag object's identity. */
export const CLAIM_TAGGER = {
  name: "afk-runner",
  email: "afk-runner@localhost",
} as const;

/** A command to run, and where. */
export interface CommandSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Written to the command's standard input, and its standard input closed. */
  readonly input?: string;
  /** Kill the child and reject after this many milliseconds. */
  readonly timeoutMs?: number;
}

/** Runs a command and returns its standard output. */
export type CommandRunner = (spec: CommandSpec) => Promise<string>;

/** Runs a git command and returns its standard output. */
export type GitRunner = (
  args: readonly string[],
  options: { readonly cwd: string; readonly input?: string },
) => Promise<string>;

/**
 * A command that failed, with what it said.
 *
 * Both streams are kept. A command whose **exit code is its answer** — the
 * repository's own CI verdict tool is one — prints what it concluded and
 * then exits with that conclusion, so the printed output is the answer and
 * the error has to carry it.
 */
export class CommandFailed extends Error {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(
    exitCode: number,
    command: string,
    args: readonly string[],
    stdout: string,
    stderr: string,
  ) {
    const detail = stderr.trim();
    super(
      detail.length > 0
        ? `${command} ${args.join(" ")} failed (${exitCode}): ${detail}`
        : `${command} ${args.join(" ")} failed (${exitCode}) and said nothing`,
    );
    this.name = "CommandFailed";
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/**
 * The bound a command gets.
 *
 * Fifteen minutes: long enough for a slow gate, short enough that a command
 * that hangs on a black-holed network does not hold the run for ever.
 */
export const COMMAND_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Runs the real `git`.
 *
 * `spawn` rather than `execFile`, because `git mktag` reads its payload from
 * stdin, and `execFile` has no way to write to it — the command would wait
 * for input that never comes.
 */
export const runGit: GitRunner = (args, options) =>
  runCommand({
    command: "git",
    args: [...args],
    cwd: options.cwd,
    ...(options.input === undefined ? {} : { input: options.input }),
  });

/**
 * Runs a command.
 *
 * `spawn` rather than `execFile`, because `git mktag` reads its payload from
 * stdin, and `execFile` has no way to write to it — the command would wait
 * for input that never comes.
 */
export const runCommand: CommandRunner = (spec) =>
  new Promise<string>((resolve, reject) => {
    const timeoutMs = spec.timeoutMs ?? COMMAND_TIMEOUT_MS;
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`command timed out after ${timeoutMs}ms: ${spec.command} ${spec.args.join(" ")}`));
    }, timeoutMs);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new CommandFailed(code ?? 1, spec.command, spec.args, stdout, stderr));
      }
    });
    child.stdin.on("error", () => {
      // A command that exits before reading its input closes the pipe; that is
      // the command's business, not an error of ours.
    });
    child.stdin.end(spec.input ?? "");
  });

/** The name of the claim ref for an issue. */
export function claimRefName(issueNumber: number): string {
  return `afk-claim-issue-${issueNumber}`;
}

/** The full ref of the claim: an annotated tag on the remote. */
export function claimRef(issueNumber: number): string {
  return `refs/tags/${claimRefName(issueNumber)}`;
}

/** The branch the work goes on. */
export function workBranch(issueNumber: number): string {
  return `agent/issue-${issueNumber}`;
}

/**
 * Where an issue's worktree lives.
 *
 * One function, because four places need the answer — the runner's worktree
 * step, its review path, the reclaim that removes the worktree a dead run left,
 * and the live door that puts the worktree back after a run's cleanup — and a
 * name spelled out in four places is four chances to disagree.
 *
 * The door is the sharp edge of that. It restores the worktree the runner
 * made, so a name that changed on one side alone leaves the door restoring a
 * directory the run never used, and the chat it switched into stands in an
 * empty place.
 */
export function issueWorktreePath(worktreeRoot: string, issueNumber: number): string {
  return join(worktreeRoot, `issue-${issueNumber}`);
}

/**
 * The message of a claim.
 *
 * The nonce is in the message because the message is part of the tag object's
 * identity — and the identity is the whole mechanism. Two claims of the same
 * issue from the same base commit differ by their nonce, so their objects
 * differ, so the second creation is rejected rather than absorbed.
 */
export function claimMessage(issueNumber: number, nonce: string): string {
  return `afk claim issue ${issueNumber}\nnonce: ${nonce}\n`;
}

/**
 * The bytes of a tag object, for `git mktag`.
 *
 * The format is git's own: the object it points at, its type, the tag's name,
 * who tagged it and when, and then the message.
 */
export function claimTagObject(options: {
  readonly baseSha: string;
  readonly name: string;
  readonly message: string;
  readonly timestampSeconds: number;
}): string {
  const { baseSha, name, message, timestampSeconds } = options;
  return (
    `object ${baseSha}\n` +
    `type commit\n` +
    `tag ${name}\n` +
    `tagger ${CLAIM_TAGGER.name} <${CLAIM_TAGGER.email}> ${timestampSeconds} +0000\n` +
    `\n` +
    `${message}`
  );
}

/** Write the tag object and return its id. No ref is created — the object only. */
export async function createClaimObject(
  git: GitRunner,
  cwd: string,
  options: {
    readonly baseSha: string;
    readonly issueNumber: number;
    readonly nonce: string;
    readonly timestampSeconds: number;
  },
): Promise<string> {
  const name = claimRefName(options.issueNumber);
  const payload = claimTagObject({
    baseSha: options.baseSha,
    name,
    message: claimMessage(options.issueNumber, options.nonce),
    timestampSeconds: options.timestampSeconds,
  });
  const id = await git(["mktag"], { cwd, input: payload });
  return id.trim();
}

/**
 * Push the claim.
 *
 * It throws when the push is rejected, and the rejection is the interesting
 * case: it means another runner holds the issue.
 */
export async function pushClaim(
  git: GitRunner,
  cwd: string,
  options: { readonly remote: string; readonly issueNumber: number; readonly objectId: string },
): Promise<void> {
  // No hook: the claim is a marker, not code. The repository's pre-push hook
  // gates the tree that is being pushed, and the claim pushes a marker object
  // — gating that costs minutes and says nothing about the change.
  await git(
    [
      "push",
      "--no-verify",
      options.remote,
      `${options.objectId}:${claimRef(options.issueNumber)}`,
    ],
    { cwd },
  );
}

/** Remove the claim. */
export async function deleteClaim(
  git: GitRunner,
  cwd: string,
  options: { readonly remote: string; readonly issueNumber: number },
): Promise<void> {
  // The ref may not be there: a run that died before its claim landed has
  // nothing to delete, and a delete of a ref that is not there fails.
  const existing = await readRemoteSha(git, cwd, {
    remote: options.remote,
    ref: claimRef(options.issueNumber),
  });
  if (existing === null) {
    return;
  }
  // No hook: the claim is a marker, not code, and a hook that gates the
  // repository's tree has nothing to say about it.
  await git(
    ["push", "--no-verify", options.remote, "--delete", claimRefName(options.issueNumber)],
    { cwd },
  );
}

/**
 * Delete a local branch, if it is there.
 *
 * `-D`, not `-d`: the branch is not merged and is not anybody's — it is the
 * runner's own `agent/issue-<N>`, and its commits are a dead run's. The caller
 * has decided that the work is redone.
 */
export async function deleteLocalBranch(
  git: GitRunner,
  cwd: string,
  options: { readonly branch: string },
): Promise<void> {
  const listed = await git(["branch", "--list", options.branch], { cwd });
  if (listed.trim() === "") {
    return;
  }
  await git(["branch", "-D", options.branch], { cwd });
}

/**
 * Delete a branch on the remote, if it is there.
 *
 * The ref may not be there: a run that died before its push leaves nothing to
 * delete, and a delete of a ref that is not there fails.
 *
 * No hook: a delete pushes no tree, and the repository's pre-push hook gates
 * the tree that is being pushed. A hook that has nothing to gate must not
 * stand between the runner and a branch it has to remove.
 */
export async function deleteRemoteBranch(
  git: GitRunner,
  cwd: string,
  options: { readonly remote: string; readonly branch: string },
): Promise<void> {
  const existing = await readRemoteSha(git, cwd, {
    remote: options.remote,
    ref: headRef(options.branch),
  });
  if (existing === null) {
    return;
  }
  await git(["push", "--no-verify", options.remote, "--delete", options.branch], { cwd });
}

/**
 * The full ref of a branch.
 *
 * `git ls-remote` matches the **tail** of a ref, so `main` would also match
 * `refs/tags/main`. The head is named exactly.
 */
export function headRef(branch: string): string {
  return branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
}

/** The commit a ref points at on the remote, or null when it has none. */
export async function readRemoteSha(
  git: GitRunner,
  cwd: string,
  options: { readonly remote: string; readonly ref: string },
): Promise<string | null> {
  const output = await git(["ls-remote", options.remote, options.ref], { cwd });
  const line = output.trim();
  if (line === "") {
    return null;
  }
  const sha = line.split(/\s+/)[0];
  return sha ?? null;
}

/**
 * The base commit a claim was taken from.
 *
 * The claim is an annotated tag, so the remote lists it twice: the tag object,
 * and the commit it peels to. The commit is the base.
 */
export async function readClaimBase(
  git: GitRunner,
  cwd: string,
  options: { readonly remote: string; readonly issueNumber: number },
): Promise<string | null> {
  const output = await git(
    ["ls-remote", "--tags", options.remote, `${claimRefName(options.issueNumber)}*`],
    { cwd },
  );
  for (const line of output.trim().split("\n")) {
    const match = /^[0-9a-f]+\s+refs\/tags\/.*\^\{\}$/.exec(line.trim());
    if (match !== null) {
      return line.trim().split(/\s+/)[0] ?? null;
    }
  }
  return null;
}

/**
 * The pattern that names every work branch on the remote.
 *
 * The runner's branches are `agent/issue-<N>` (see `workBranch`), and this is
 * what one `ls-remote` and one `fetch` ask for.
 */
const WORK_BRANCH_PATTERN = "refs/heads/agent/*";

/** The prefix every work branch carries. */
const WORK_BRANCH_PREFIX = "agent/";

/** A counter that keeps the private refs of one bulk read apart. */
let bulkCounter = 0;

/**
 * Every work branch on the remote.
 *
 * One `ls-remote` for all of them: the branches grow with the issues the
 * runner has worked, and a call per branch made the cost of a run grow with
 * the queue's history.
 */
async function readRemoteWorkBranches(
  git: GitRunner,
  cwd: string,
  options: { readonly remote: string },
): Promise<ReadonlySet<string>> {
  const output = await git(["ls-remote", "--heads", options.remote, WORK_BRANCH_PATTERN], {
    cwd,
  });
  const branches = new Set<string>();
  for (const line of output.split("\n")) {
    const match = /^[0-9a-f]+\s+refs\/heads\/(agent\/.*)$/.exec(line.trim());
    if (match !== null) {
      branches.add(match[1] ?? "");
    }
  }
  return branches;
}

/**
 * The branches that carry work the base does not have.
 *
 * A branch that points at the base carries nothing: it is what a run pushed
 * before the session step refused an empty tree, or the leftover of work the
 * base already has. GitHub refuses a pull request for it — *No commits between
 * <base> and <branch>* — so a run that reads the branch's **existence** as work
 * retries the same refusal for ever.
 *
 * The question is asked of every branch at once: the answer is the same one
 * `git rev-list --count <base>..<branch>` gives, and a run that asked it per
 * branch paid for it once per issue it had ever worked.
 */
export async function branchesWithWork(
  git: GitRunner,
  cwd: string,
  options: {
    readonly remote: string;
    readonly base: string;
    readonly branches: readonly string[];
  },
): Promise<Set<string>> {
  const work = new Set<string>();
  const wanted = [...new Set(options.branches)].filter((branch) =>
    branch.startsWith(WORK_BRANCH_PREFIX),
  );
  if (wanted.length === 0) {
    return work;
  }
  const tips = await readRemoteWorkBranches(git, cwd, { remote: options.remote });
  const present = wanted.filter((branch) => tips.has(branch));
  if (present.length === 0) {
    // No branch on the remote carries anything: there is nothing to fetch and
    // nothing to compare.
    return work;
  }
  const namespace = `refs/afk/work-${process.pid}-${++bulkCounter}`;
  try {
    // The fetch is a wildcard over the runner's own branches: one call, a
    // command line that does not grow with the queue, and a branch that was
    // deleted between the two calls is simply not fetched — a fetch that named
    // it would fail on it.
    await git(
      [
        "fetch",
        options.remote,
        `+${headRef(options.base)}:${namespace}/base`,
        `+${WORK_BRANCH_PATTERN}:${namespace}/branch/*`,
      ],
      { cwd },
    );
    // The branches the base does not have are the branches that carry work:
    // their commits are not on the base, and GitHub would refuse a pull
    // request for the ones that are. The base is named, not resolved:
    // `for-each-ref` reads the ref, and a `rev-parse` to learn its commit
    // would be one call more.
    const carrying = new Set(
      (
        await git(
          [
            "for-each-ref",
            "--no-merged",
            `${namespace}/base`,
            "--format=%(refname)",
            `${namespace}/branch/`,
          ],
          { cwd },
        )
      )
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    );
    for (const branch of present) {
      const ref = `${namespace}/branch/${branch.slice(WORK_BRANCH_PREFIX.length)}`;
      // A branch that is not in the list was not fetched — it was deleted
      // between the two calls — and a branch that is not there carries nothing.
      if (carrying.has(ref)) {
        work.add(branch);
      }
    }
  } finally {
    await removeRefs(git, cwd, namespace).catch(() => "");
  }
  return work;
}

/** Remove the refs of one bulk read, so the checkout is left as it was. */
async function removeRefs(
  git: GitRunner,
  cwd: string,
  namespace: string,
): Promise<void> {
  const refs = (
    await git(["for-each-ref", "--format=%(refname)", namespace], { cwd })
  )
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (refs.length === 0) {
    return;
  }
  await git(["update-ref", "--stdin"], {
    cwd,
    input: refs.map((ref) => `delete ${ref}\n`).join(""),
  });
}

/** A counter that keeps the private fetch refs of one process apart. */
let fetchCounter = 0;

/**
 * Fetch one ref, and hand back the commit it points at.
 *
 * The ref is fetched into a private ref of this call, named so that no other
 * run in the checkout can be writing it, and removed again. That is what makes
 * it safe to read: `FETCH_HEAD` is shared by every run of the repository, and a
 * commit read from it may be a commit another run fetched.
 */
export async function fetchCommit(
  git: GitRunner,
  cwd: string,
  options: { readonly remote: string; readonly ref: string },
): Promise<string> {
  // shortcut: a run killed mid-fetch leaves its private ref behind, and nothing
  // sweeps those up — clean them out when their number starts to matter.
  const name = `refs/afk/fetch-${process.pid}-${++fetchCounter}`;
  try {
    await git(["fetch", options.remote, `+${options.ref}:${name}`], { cwd });
    return (await git(["rev-parse", name], { cwd })).trim();
  } finally {
    await git(["update-ref", "-d", name], { cwd }).catch(() => "");
  }
}

/** Bring one ref's objects down from the remote. */
export async function fetchRef(
  git: GitRunner,
  cwd: string,
  options: { readonly remote: string; readonly ref: string },
): Promise<void> {
  await git(["fetch", options.remote, options.ref], { cwd });
}

/**
 * Create the worktree the work happens in.
 *
 * The branch is created here, on the base the claim recorded, so the work
 * starts from exactly the commit the claim was taken against.
 */
export async function addWorktree(
  git: GitRunner,
  cwd: string,
  options: {
    readonly path: string;
    readonly branch: string;
    readonly baseSha: string;
  },
): Promise<void> {
  // A run that failed before its push leaves its branch behind on purpose — the
  // work a run did is durable — so the next attempt on this checkout finds the
  // branch and continues it. `-b` would fail on the second attempt, and the issue
  // would be unworkable on this machine for ever.
  const exists =
    (
      await git(
        ["rev-parse", "--verify", "--quiet", `refs/heads/${options.branch}`],
        { cwd },
      ).catch(() => "")
    ).trim() !== "";
  if (!exists) {
    await git(["worktree", "add", "-b", options.branch, options.path, options.baseSha], {
      cwd,
    });
    return;
  }
  // A branch that carries nothing of its own is a failed run's leftover, not work:
  // it is moved to the base this run claimed, so a retry does not work on the main
  // of an hour ago. Commits of its own are left where they are.
  const ahead = (
    await git(["rev-list", "--count", `${options.baseSha}..${options.branch}`], { cwd })
  ).trim();
  if (ahead === "0") {
    await git(["branch", "-f", options.branch, options.baseSha], { cwd });
  }
  await git(["worktree", "add", options.path, options.branch], { cwd });
}

/**
 * Remove the worktree.
 *
 * The directory goes and the registration is pruned, rather than
 * `git worktree remove`, because that command refuses a path that is not a
 * registered worktree — and a run that failed *before* the worktree existed
 * must still be able to release its claim. Pruning a registration whose
 * directory is gone is what git itself does when it cleans up.
 *
 * The branch is not the worktree: removing the worktree leaves the branch and
 * its commits alone, so the work a failed run did is durable.
 */
export async function removeWorktree(
  git: GitRunner,
  cwd: string,
  path: string,
): Promise<void> {
  // Ask git first: the path may belong to another run's worktree.
  const list = await git(["worktree", "list", "--porcelain"], { cwd });
  const entries = list.split(/\n\n/).map((block) => block.trim()).filter((b) => b !== "");
  let registeredBranch: string | null = null;
  for (const block of entries) {
    const lines = block.split("\n");
    const wtLine = lines.find((l) => l.startsWith("worktree "));
    if (wtLine === undefined || wtLine.slice("worktree ".length).trim() !== path) {
      continue;
    }
    const branchLine = lines.find((l) => l.startsWith("branch "));
    registeredBranch = branchLine === undefined ? null : branchLine.slice("branch ".length).trim();
  }

  if (registeredBranch !== null) {
    // Only our own worktrees may be removed: those on agent/issue-<N>.
    if (!/^refs\/heads\/agent\/issue-\d+$/.test(registeredBranch)) {
      throw new Error(
        `refusing to remove worktree at ${path}: it is registered to branch ${registeredBranch}`,
      );
    }
    // Remove via git so the registration is cleaned up, then prune.
    await git(["worktree", "remove", "--force", path], { cwd }).catch(async () => {
      await rm(path, { recursive: true, force: true });
    });
    await git(["worktree", "prune"], { cwd });
    return;
  }

  // Not a registered worktree: a leftover directory (or nothing at all).
  await rm(path, { recursive: true, force: true });
  await git(["worktree", "prune"], { cwd });
}

/**
 * The refs the runner is allowed to push.
 *
 * The work branch, and the claim. Nothing else — a runner that can push
 * anywhere can push anywhere, and the guard is cheaper than the review.
 */
export function allowedPushRefs(issueNumber: number): readonly string[] {
  return [`refs/heads/${workBranch(issueNumber)}`, claimRef(issueNumber)];
}

/**
 * Refuse a ref the runner may not push.
 *
 * The refusal happens **before** any git command runs: a push that has already
 * half happened is a push that has to be undone.
 */
export function assertPushableRef(ref: string, issueNumber: number): void {
  const allowed = allowedPushRefs(issueNumber);
  if (!allowed.includes(ref)) {
    throw new Error(
      `the runner may not push ${ref}: it pushes only ${allowed.join(" and ")}`,
    );
  }
}

/** Push one ref, if it is one the runner may push. */
export async function pushRef(
  git: GitRunner,
  cwd: string,
  options: {
    readonly remote: string;
    readonly ref: string;
    readonly sha: string;
    readonly issueNumber: number;
    /**
     * Whether the repository's own pre-push hook may gate this push.
     *
     * The hook is the repository's rule, and it is expensive: the detekt
     * verdict over a `shared/` change takes about nine minutes. Skipping it is
     * a decision about the repository's state — its gate is red for a reason
     * that has nothing to do with this change — and it is therefore explicit.
     */
    readonly verify?: boolean;
  },
): Promise<void> {
  assertPushableRef(options.ref, options.issueNumber);
  await git(
    [
      "push",
      ...(options.verify === false ? ["--no-verify"] : []),
      options.remote,
      `${options.sha}:${options.ref}`,
    ],
    { cwd },
  );
}

/** Push the work branch. */
export async function pushWorkBranch(
  git: GitRunner,
  cwd: string,
  options: {
    readonly remote: string;
    readonly issueNumber: number;
    readonly sha: string;
    /** Whether the repository's own pre-push hook may gate this push. */
    readonly verify?: boolean;
  },
): Promise<void> {
  await pushRef(git, cwd, {
    remote: options.remote,
    ref: `refs/heads/${workBranch(options.issueNumber)}`,
    sha: options.sha,
    issueNumber: options.issueNumber,
    ...(options.verify === undefined ? {} : { verify: options.verify }),
  });
}
