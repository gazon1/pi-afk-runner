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
}

/** Runs a command and returns its standard output. */
export type CommandRunner = (spec: CommandSpec) => Promise<string>;

/** Runs a git command and returns its standard output. */
export type GitRunner = (
  args: readonly string[],
  options: { readonly cwd: string; readonly input?: string },
) => Promise<string>;

/** A git command that failed, with the reason git gave in the message. */
export class GitCommandFailed extends Error {
  readonly exitCode: number;
  readonly stderr: string;

  constructor(exitCode: number, args: readonly string[], stderr: string) {
    const detail = stderr.trim();
    super(
      detail.length > 0
        ? `git ${args.join(" ")} failed (${exitCode}): ${detail}`
        : `git ${args.join(" ")} failed (${exitCode}) and said nothing`,
    );
    this.name = "GitCommandFailed";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

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
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
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
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new GitCommandFailed(code ?? 1, spec.args, stderr));
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
  await git(
    ["push", options.remote, `${options.objectId}:${claimRef(options.issueNumber)}`],
    { cwd },
  );
}

/** Remove the claim. */
export async function deleteClaim(
  git: GitRunner,
  cwd: string,
  options: { readonly remote: string; readonly issueNumber: number },
): Promise<void> {
  await git(["push", options.remote, "--delete", claimRefName(options.issueNumber)], { cwd });
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
  await git(["worktree", "add", "-b", options.branch, options.path, options.baseSha], { cwd });
}
